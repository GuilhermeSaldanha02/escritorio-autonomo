import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AutonomyController,
  CircuitBreakerStore,
  LifecycleService,
  RecoveryService,
  Scheduler,
  scheduleIntervalMs,
  stopReaderFor,
} from '@escritorio/autonomy';
import { type Pool, seedInitialAgents } from '@escritorio/database';
import { JOB_NAMES } from '@escritorio/events';
import { Governor, loadConstitution, parseConstitution } from '@escritorio/governor';
import { createScheduleActions } from '@escritorio/worker';
import { createTestPool, resetDatabase } from './support.js';

/**
 * As ações que o Scheduler dispara (critério 1 do M6), contra Postgres real: só
 * ENFILEIRAM ou registram, são idempotentes pela identidade da janela e a
 * reconciliação nunca repara dinheiro.
 */
const HOUR = 3_600_000;
const T0 = new Date('2026-09-18T12:00:00.000Z');
let pool: Pool;
let scheduler: Scheduler;
let governor: Governor;

beforeAll(async () => {
  pool = createTestPool();
});

beforeEach(async () => {
  await resetDatabase(pool);
  await seedInitialAgents(pool);
  const raw = structuredClone(loadConstitution()) as unknown as { autonomia: { AUTONOMY_ENABLED: boolean } };
  raw.autonomia.AUTONOMY_ENABLED = true;
  governor = new Governor(parseConstitution(raw));
  const controller = new AutonomyController({
    governor,
    stop: stopReaderFor(pool),
    breakers: new CircuitBreakerStore(pool, () => ({ failureThreshold: 5, cooldownMs: 1000, minSample: 1 })),
  });
  const attempts = governor.limits.MAX_TASK_RETRIES + 1;
  const recovery = new RecoveryService({ pool, governor, controller, attempts });
  const lifecycle = new LifecycleService({ pool, governor, controller, resumeAttempts: attempts });
  scheduler = new Scheduler({ pool, governor, controller, actions: createScheduleActions({ pool, governor, recovery, lifecycle }) });
});

afterAll(async () => {
  await pool.end();
});

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params);
  return Number(rows[0]!.n);
}

describe('agenda DISCOVERY', () => {
  it('enfileira UM job de descoberta pelo outbox, com evento, e repetir o tick não duplica', async () => {
    expect((await scheduler.runTick('DISCOVERY', T0)).outcome).toBe('DISPATCHED');
    expect(await count(`outbox WHERE job_name = $1`, [JOB_NAMES.DISCOVER_OPPORTUNITIES])).toBe(1);
    expect(await count(`events WHERE type = 'SCHEDULE_TICK_DISPATCHED'`)).toBe(1);

    expect((await scheduler.runTick('DISCOVERY', new Date(T0.getTime() + 1000))).outcome).toBe('ALREADY_CLAIMED');
    expect(await count('outbox')).toBe(1);

    await scheduler.runTick('DISCOVERY', new Date(T0.getTime() + scheduleIntervalMs(governor, 'DISCOVERY')));
    expect(await count('outbox')).toBe(2); // a próxima janela é outro job
  });

  it('o job enfileirado carrega o id da janela: a identidade agendada chega ao BullMQ', async () => {
    const result = await scheduler.runTick('DISCOVERY', T0);
    const { rows } = await pool.query<{ job_id: string }>('SELECT job_id FROM outbox');
    expect(rows[0]!.job_id).toBe(`scheduled-${result.windowKey.replaceAll(':', '-')}`);
  });
});

describe('agenda RECONCILIATION (só detecta)', () => {
  it('banco saudável: registra RECONCILIATION_OK como evento', async () => {
    await scheduler.runTick('RECONCILIATION', T0);
    const { rows } = await pool.query<{ payload: { status: string; issueCount: number } }>(`SELECT payload FROM events WHERE type = 'RECONCILIATION_REPORTED'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ status: 'RECONCILIATION_OK', issueCount: 0 });
  });

  it('PAID sem receita: registra o MISMATCH com os códigos e NÃO repara nada', async () => {
    await pool.query(`INSERT INTO opportunities (source, source_url, title, status) VALUES ('teste', 'https://exemplo.test/paid', 't', 'PAID')`);
    await scheduler.runTick('RECONCILIATION', T0);
    const { rows } = await pool.query<{ payload: { status: string; issueCodes: string[] } }>(`SELECT payload FROM events WHERE type = 'RECONCILIATION_REPORTED'`);
    expect(rows[0]!.payload).toMatchObject({ status: 'RECONCILIATION_MISMATCH', issueCodes: ['PAID_WITHOUT_REVENUE'] });
    expect(await count('financial_ledger')).toBe(0); // detectou, não consertou
    expect(await count(`opportunities WHERE status = 'PAID'`)).toBe(1);
  });
});

describe('agenda PERFORMANCE_WINDOW', () => {
  it('avalia a janela ANTERIOR, já completa, de cada agente, uma vez só', async () => {
    const interval = scheduleIntervalMs(governor, 'PERFORMANCE_WINDOW');
    const windowStart = Math.floor(T0.getTime() / interval) * interval;
    const previous = new Date(windowStart - interval / 2); // no meio da janela anterior
    const { rows: tasks } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (objective, status, assigned_agent_id) VALUES ('o', 'COMPLETED', 'DESENVOLVEDOR-001') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO experiences (task_id, agent_id, capability, outcome, attempt_count, review_result, duration_ms, idempotency_key, created_at)
       VALUES ($1, 'DESENVOLVEDOR-001', 'DESENVOLVEDOR', 'SUCCESS', 1, 'PASSED', 100, 'e:1', $2)`,
      [tasks[0]!.id, previous],
    );

    await scheduler.runTick('PERFORMANCE_WINDOW', T0);
    const { rows } = await pool.query<{ agent_id: string; sample_size: number; window_to: Date }>(
      `SELECT agent_id, sample_size, window_to FROM agent_performance WHERE agent_id = 'DESENVOLVEDOR-001'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sample_size).toBe(1);
    expect(rows[0]!.window_to.getTime()).toBe(windowStart);
    expect(await count('agent_performance')).toBe(4); // um por agente inicial

    await scheduler.runTick('PERFORMANCE_WINDOW', new Date(T0.getTime() + 1000));
    expect(await count('agent_performance')).toBe(4);
  });
});

describe('agendas RECOVERY_SWEEP e LIFECYCLE_EVALUATION', () => {
  it('a varredura re-despacha a task órfã (o relógio injetado avança além do prazo)', async () => {
    await pool.query(`INSERT INTO tasks (objective, status, assigned_agent_id) VALUES ('o', 'IN_PROGRESS', 'DESENVOLVEDOR-001')`);
    const later = new Date(Date.now() + 2 * HOUR);
    expect((await scheduler.runTick('RECOVERY_SWEEP', later)).outcome).toBe('DISPATCHED');
    expect(await count(`outbox WHERE job_name = 'develop-task'`)).toBe(1);
  });

  it('a avaliação de lifecycle roda sem mudar nada quando não há evidência', async () => {
    expect((await scheduler.runTick('LIFECYCLE_EVALUATION', T0)).outcome).toBe('DISPATCHED');
    expect(await count('agent_lifecycle_transitions')).toBe(0);
  });
});

describe('o Scheduler inteiro', () => {
  it('runDue dispara as cinco agendas na primeira vez e nenhuma na repetição', async () => {
    const first = await scheduler.runDue(T0);
    expect(first).toHaveLength(5);
    expect(first.every((r) => r.outcome === 'DISPATCHED')).toBe(true);
    const again = await scheduler.runDue(new Date(T0.getTime() + 1000));
    expect(again.every((r) => r.outcome === 'ALREADY_CLAIMED')).toBe(true);
  });
});
