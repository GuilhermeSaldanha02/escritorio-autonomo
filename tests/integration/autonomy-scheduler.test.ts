import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AutonomyController,
  CircuitBreakerStore,
  EmergencyStopService,
  Scheduler,
  SCHEDULE_NAMES,
  scheduleIntervalMs,
  type ScheduleAction,
  type ScheduleName,
  stopReaderFor,
  type StopReader,
} from '@escritorio/autonomy';
import type { Pool } from '@escritorio/database';
import { Governor, loadConstitution, parseConstitution } from '@escritorio/governor';
import { createTestPool, resetDatabase } from './support.js';

/**
 * Critérios 1 a 4 do M6 contra Postgres real: nada roda com a autonomia
 * desligada (o padrão), a identidade da execução agendada vive no Postgres
 * (um efeito só, mesmo com ticks concorrentes), tick negado é registrado e
 * NÃO é falha, e o tempo é injetado.
 */
let pool: Pool;
const T0 = new Date('2026-09-18T12:00:00.000Z');

function governorWith(enabled: boolean): Governor {
  const raw = structuredClone(loadConstitution()) as unknown as { autonomia: { AUTONOMY_ENABLED: boolean } };
  raw.autonomia.AUTONOMY_ENABLED = enabled;
  return new Governor(parseConstitution(raw));
}

function build(options: { enabled: boolean; stop?: StopReader }) {
  const governor = governorWith(options.enabled);
  const breakers = new CircuitBreakerStore(pool, () => ({ failureThreshold: 5, cooldownMs: 1000, minSample: 1 }));
  const controller = new AutonomyController({ governor, stop: options.stop ?? stopReaderFor(pool), breakers });
  const actions = Object.fromEntries(SCHEDULE_NAMES.map((name) => [name, vi.fn<ScheduleAction>(async () => {})])) as Record<ScheduleName, ReturnType<typeof vi.fn<ScheduleAction>>>;
  return { governor, actions, scheduler: new Scheduler({ pool, governor, controller, actions }) };
}

beforeAll(async () => {
  pool = createTestPool();
});

beforeEach(async () => {
  await resetDatabase(pool);
});

afterAll(async () => {
  await pool.end();
});

async function count(sql: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`);
  return Number(rows[0]!.n);
}

describe('Scheduler: autonomia desligada por padrão (critério 1)', () => {
  it('com a Constituição REAL (AUTONOMY_ENABLED=false) nenhuma agenda executa, e cada janela grava o motivo', async () => {
    const governor = new Governor(loadConstitution());
    const controller = new AutonomyController({ governor, stop: stopReaderFor(pool), breakers: new CircuitBreakerStore(pool, () => ({ failureThreshold: 5, cooldownMs: 1, minSample: 1 })) });
    const actions = Object.fromEntries(SCHEDULE_NAMES.map((n) => [n, vi.fn(async () => {})])) as unknown as Record<ScheduleName, ScheduleAction>;
    const results = await new Scheduler({ pool, governor, controller, actions }).runDue(T0);

    expect(results.every((r) => r.outcome === 'SKIPPED' && r.reason === 'AUTONOMY_DISABLED')).toBe(true);
    for (const name of SCHEDULE_NAMES) expect(actions[name]).not.toHaveBeenCalled();
    expect(await count(`scheduled_executions WHERE status = 'SKIPPED' AND skip_reason = 'AUTONOMY_DISABLED'`)).toBe(SCHEDULE_NAMES.length);
    expect(await count(`events WHERE type = 'SCHEDULE_TICK_SKIPPED'`)).toBe(0); // desligada: uma linha por janela, sem ruído de evento
  });

  it('os intervalos vêm da Constituição, nunca do código', () => {
    const governor = new Governor(loadConstitution());
    expect(scheduleIntervalMs(governor, 'DISCOVERY')).toBe(900_000);
    expect(scheduleIntervalMs(governor, 'RECONCILIATION')).toBe(3_600_000);
    expect(scheduleIntervalMs(governor, 'PERFORMANCE_WINDOW')).toBe(24 * 3_600_000);
    expect(scheduleIntervalMs(governor, 'RECOVERY_SWEEP')).toBe(300_000);
    expect(scheduleIntervalMs(governor, 'LIFECYCLE_EVALUATION')).toBe(3_600_000);
  });
});

describe('Scheduler: identidade idempotente no Postgres (critério 2)', () => {
  it('a mesma janela roda uma vez só; a próxima janela roda de novo', async () => {
    const { scheduler, actions, governor } = build({ enabled: true });
    const first = await scheduler.runDue(T0);
    expect(first.every((r) => r.outcome === 'DISPATCHED')).toBe(true);
    for (const name of SCHEDULE_NAMES) expect(actions[name]).toHaveBeenCalledTimes(1);

    const again = await scheduler.runDue(new Date(T0.getTime() + 1000)); // mesma janela de todas as agendas
    expect(again.every((r) => r.outcome === 'ALREADY_CLAIMED')).toBe(true);
    for (const name of SCHEDULE_NAMES) expect(actions[name]).toHaveBeenCalledTimes(1);

    const next = await scheduler.runTick('DISCOVERY', new Date(T0.getTime() + scheduleIntervalMs(governor, 'DISCOVERY')));
    expect(next.outcome).toBe('DISPATCHED');
    expect(actions.DISCOVERY).toHaveBeenCalledTimes(2);
  });

  it('cinco ticks simultâneos da MESMA janela resultam em UM só efeito', async () => {
    const { scheduler, actions } = build({ enabled: true });
    const results = await Promise.all(Array.from({ length: 5 }, () => scheduler.runTick('DISCOVERY', T0)));
    expect(results.filter((r) => r.outcome === 'DISPATCHED')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'ALREADY_CLAIMED')).toHaveLength(4);
    expect(actions.DISCOVERY).toHaveBeenCalledTimes(1);
    expect(await count(`scheduled_executions WHERE schedule_name = 'DISCOVERY'`)).toBe(1);
  });

  it('dois schedulers independentes (dois processos) também produzem um efeito só', async () => {
    const a = build({ enabled: true });
    const b = build({ enabled: true });
    const results = await Promise.all([a.scheduler.runTick('RECOVERY_SWEEP', T0), b.scheduler.runTick('RECOVERY_SWEEP', T0)]);
    expect(results.filter((r) => r.outcome === 'DISPATCHED')).toHaveLength(1);
    expect(a.actions.RECOVERY_SWEEP.mock.calls.length + b.actions.RECOVERY_SWEEP.mock.calls.length).toBe(1);
  });

  it('a chave da janela é a fronteira do intervalo: dentro dele é a mesma, ao cruzá-lo é outra', async () => {
    const { scheduler, governor } = build({ enabled: true });
    const interval = scheduleIntervalMs(governor, 'DISCOVERY');
    const base = Math.floor(T0.getTime() / interval) * interval;
    const a = await scheduler.runTick('DISCOVERY', new Date(base));
    const b = await scheduler.runTick('DISCOVERY', new Date(base + interval - 1));
    const c = await scheduler.runTick('DISCOVERY', new Date(base + interval));
    expect(a.windowKey).toBe(b.windowKey);
    expect(c.windowKey).not.toBe(a.windowKey);
    expect([a.outcome, b.outcome, c.outcome]).toEqual(['DISPATCHED', 'ALREADY_CLAIMED', 'DISPATCHED']);
  });
});

describe('Scheduler: tick negado é pausa, não falha (critério 3)', () => {
  it('com o Emergency Stop engajado, o tick é SKIPPED com o motivo e um evento; a ação não roda', async () => {
    const { scheduler, actions } = build({ enabled: true });
    await new EmergencyStopService(pool).engage('FOUNDER_CLI', 'teste');
    const result = await scheduler.runTick('DISCOVERY', T0);
    expect(result).toMatchObject({ outcome: 'SKIPPED', reason: 'EMERGENCY_STOP' });
    expect(actions.DISCOVERY).not.toHaveBeenCalled();
    expect(await count(`events WHERE type = 'SCHEDULE_TICK_SKIPPED'`)).toBe(1);
  });

  it('com o estado do Stop ilegível (fail-safe), o tick é SKIPPED e não roda', async () => {
    const { scheduler, actions } = build({ enabled: true, stop: { read: async () => ({ status: 'UNVERIFIABLE', error: 'db fora' }) } });
    expect(await scheduler.runTick('RECONCILIATION', T0)).toMatchObject({ outcome: 'SKIPPED', reason: 'STOP_UNVERIFIABLE' });
    expect(actions.RECONCILIATION).not.toHaveBeenCalled();
  });

  it('uma janela negada é avaliada UMA vez: liberar o Stop dentro dela não a executa retroativamente', async () => {
    const { scheduler, actions } = build({ enabled: true });
    const stop = new EmergencyStopService(pool);
    await stop.engage('FOUNDER_CLI', 'a');
    await scheduler.runTick('DISCOVERY', T0);
    await stop.release('FOUNDER_CLI', 'b');
    expect((await scheduler.runTick('DISCOVERY', new Date(T0.getTime() + 1000))).outcome).toBe('ALREADY_CLAIMED');
    expect(actions.DISCOVERY).not.toHaveBeenCalled();
  });

  it('nada disso alimenta circuito nem cria falha: só linhas de agendamento', async () => {
    const { scheduler } = build({ enabled: true });
    await new EmergencyStopService(pool).engage('FOUNDER_CLI', 'teste');
    await scheduler.runDue(T0);
    expect(await count('circuit_breaker_events')).toBe(0);
    expect(await count(`scheduled_executions WHERE status = 'FAILED'`)).toBe(0);
  });

  it('falha da ação vira FAILED com o motivo, sem lançar, e não impede as demais agendas nem as próximas janelas', async () => {
    const { scheduler, actions, governor } = build({ enabled: true });
    actions.DISCOVERY.mockRejectedValueOnce(new Error('fila indisponível'));
    const results = await scheduler.runDue(T0);
    expect(results.find((r) => r.schedule === 'DISCOVERY')).toMatchObject({ outcome: 'FAILED', reason: 'fila indisponível' });
    expect(results.filter((r) => r.outcome === 'DISPATCHED')).toHaveLength(SCHEDULE_NAMES.length - 1);
    const next = await scheduler.runTick('DISCOVERY', new Date(T0.getTime() + scheduleIntervalMs(governor, 'DISCOVERY')));
    expect(next.outcome).toBe('DISPATCHED');
  });
});

describe('Scheduler: tempo injetado (critério 4)', () => {
  it('a ação recebe a janela e o `now` injetados, e nada espera tempo real', async () => {
    const { scheduler, actions, governor } = build({ enabled: true });
    const farFuture = new Date('2031-03-01T08:30:00.000Z');
    const startedAt = Date.now();
    await scheduler.runTick('PERFORMANCE_WINDOW', farFuture);
    expect(Date.now() - startedAt).toBeLessThan(5_000);

    const run = actions.PERFORMANCE_WINDOW.mock.calls[0]![0];
    const interval = scheduleIntervalMs(governor, 'PERFORMANCE_WINDOW');
    expect(run.now).toEqual(farFuture);
    expect(run.intervalMs).toBe(interval);
    expect(run.windowStart.getTime()).toBe(Math.floor(farFuture.getTime() / interval) * interval);
    expect(run.windowKey).toBe(`PERFORMANCE_WINDOW:${Math.floor(farFuture.getTime() / interval)}`);
  });
});
