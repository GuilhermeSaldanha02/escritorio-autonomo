import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AutonomyController,
  CircuitBreakerStore,
  createJobGate,
  EmergencyStopService,
  LifecycleService,
  stopReaderFor,
} from '@escritorio/autonomy';
import { type Pool, seedInitialAgents } from '@escritorio/database';
import { JOB_NAMES } from '@escritorio/events';
import { Governor, loadConstitution } from '@escritorio/governor';
import { createTestPool, resetDatabase } from './support.js';

/**
 * Critérios 17 a 20 do M6 contra Postgres real. O lifecycle só muda por evidência de
 * AgentPerformance, com amostra mínima, janelas consecutivas, cooldown e autorização
 * do Governor; e pausa nunca é desempenho ruim.
 */
const governor = new Governor(loadConstitution());
const DEV = 'DESENVOLVEDOR-001';
const HOUR = 3_600_000;
let pool: Pool;
let stop: EmergencyStopService;
let breakers: CircuitBreakerStore;
let lifecycle: LifecycleService;
let now: Date;

beforeAll(async () => {
  pool = createTestPool();
});

beforeEach(async () => {
  await resetDatabase(pool);
  await seedInitialAgents(pool);
  now = new Date();
  stop = new EmergencyStopService(pool);
  breakers = new CircuitBreakerStore(pool, () => ({ failureThreshold: 1, cooldownMs: 24 * HOUR, minSample: 1 }));
  const controller = new AutonomyController({ governor, stop: stopReaderFor(pool), breakers });
  lifecycle = new LifecycleService({ pool, governor, controller, resumeAttempts: 4 });
});

afterAll(async () => {
  await pool.end();
});

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params);
  return Number(rows[0]!.n);
}

async function status(agentId = DEV): Promise<string> {
  const { rows } = await pool.query<{ lifecycle_status: string }>('SELECT lifecycle_status FROM agents WHERE id = $1', [agentId]);
  return rows[0]!.lifecycle_status;
}

async function setStatus(agentId: string, value: string): Promise<void> {
  await pool.query('UPDATE agents SET lifecycle_status = $2 WHERE id = $1', [agentId, value]);
}

/** Avaliação `daysAgo` dias atrás (0 = a mais recente), com 24h de duração terminando `daysAgo` dias antes de `now`. */
async function insertWindow(daysAgo: number, action: 'PROMOTE' | 'KEEP' | 'INVESTIGATE', sampleSize = 10): Promise<string> {
  const to = new Date(now.getTime() - daysAgo * 24 * HOUR);
  const from = new Date(to.getTime() - 24 * HOUR);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO agent_performance (agent_id, window_from, window_to, sample_size, tasks_completed, tasks_failed, success_rate,
                                    review_pass_rate, retry_rate, avg_duration_ms, total_technical_cost_brl, recommended_action, idempotency_key)
     VALUES ($1, $2, $3, $4, 0, 0, 0.5, 0.5, 0, 0, 0, $5, $6) RETURNING id`,
    [DEV, from, to, sampleSize, action, `perf:${daysAgo}:${crypto.randomUUID()}`],
  );
  return rows[0]!.id;
}

async function badWindows(): Promise<string[]> {
  return [await insertWindow(0, 'INVESTIGATE'), await insertWindow(1, 'INVESTIGATE'), await insertWindow(2, 'INVESTIGATE')];
}

async function recordTransitionAt(agentId: string, from: string, to: string, at: Date): Promise<void> {
  await pool.query(
    `INSERT INTO agent_lifecycle_transitions (agent_id, from_status, to_status, reason, actor, occurred_at) VALUES ($1, $2, $3, 'fixture', 'FOUNDER', $4)`,
    [agentId, from, to, at],
  );
}

describe('transições automáticas por evidência', () => {
  it('PROBATION -> ACTIVE com janelas PROMOTE consecutivas: grava histórico com a evidência e o evento', async () => {
    await setStatus(DEV, 'PROBATION');
    const ids = [await insertWindow(0, 'PROMOTE'), await insertWindow(1, 'PROMOTE')];

    const result = await lifecycle.evaluateAgent(DEV, now);
    expect(result).toMatchObject({ outcome: 'TRANSITIONED', from: 'PROBATION', to: 'ACTIVE' });
    expect(await status()).toBe('ACTIVE');

    const { rows } = await pool.query<{ actor: string; evidence: string[] }>(`SELECT actor, evidence FROM agent_lifecycle_transitions`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe('LIFECYCLE_CONTROLLER');
    expect(rows[0]!.evidence.sort()).toEqual([...ids].sort());
    expect(await count(`events WHERE type = 'AGENT_ACTIVATED'`)).toBe(1);
  });

  it('ACTIVE -> SLEEP só com janelas ruins consecutivas; depois, a histerese impede vaivém imediato', async () => {
    await badWindows();
    expect(await lifecycle.evaluateAgent(DEV, now)).toMatchObject({ outcome: 'TRANSITIONED', from: 'ACTIVE', to: 'SLEEP' });
    expect(await status()).toBe('SLEEP');
    expect(await count(`events WHERE type = 'AGENT_SLEEP'`)).toBe(1);

    // Mesma evidência, um instante depois: o cooldown segura.
    await setStatus(DEV, 'ACTIVE');
    expect(await lifecycle.evaluateAgent(DEV, new Date(now.getTime() + HOUR))).toMatchObject({ outcome: 'NONE', reason: 'COOLDOWN' });
    expect(await count('agent_lifecycle_transitions')).toBe(1);
  });

  it('uma avaliação ruim isolada nunca dorme um agente', async () => {
    await insertWindow(0, 'INVESTIGATE');
    await insertWindow(1, 'KEEP');
    await insertWindow(2, 'INVESTIGATE');
    expect((await lifecycle.evaluateAgent(DEV, now)).outcome).toBe('NONE');
    expect(await status()).toBe('ACTIVE');
  });

  it('AMOSTRA INSUFICIENTE NUNCA É DESEMPENHO RUIM: INVESTIGATE com amostra pequena não dorme o agente', async () => {
    await insertWindow(0, 'INVESTIGATE', 0);
    await insertWindow(1, 'INVESTIGATE', 2);
    await insertWindow(2, 'INVESTIGATE', 4);
    expect((await lifecycle.evaluateAgent(DEV, now)).outcome).toBe('NONE');
    expect(await status()).toBe('ACTIVE');
  });

  it('a mesma avaliação concorrente transiciona UMA vez só', async () => {
    await badWindows();
    const results = await Promise.all(Array.from({ length: 5 }, () => lifecycle.evaluateAgent(DEV, now)));
    expect(results.filter((r) => r.outcome === 'TRANSITIONED')).toHaveLength(1);
    expect(await count('agent_lifecycle_transitions')).toBe(1);
    expect(await count(`events WHERE type = 'AGENT_SLEEP'`)).toBe(1);
  });
});

describe('pausa não é desempenho ruim (critério 18)', () => {
  it('janela sobreposta a um Emergency Stop não vale: três janelas ruins com uma sobreposta não dormem o agente', async () => {
    // O Stop acontece ANTES de as janelas terminarem: a mais recente (que termina em `now`) o contém.
    await stop.engage('FOUNDER_CLI', 'incidente');
    await stop.release('FOUNDER_CLI', 'resolvido');
    now = new Date();
    await badWindows();
    expect((await lifecycle.evaluateAgent(DEV, now)).outcome).toBe('NONE');
    expect(await status()).toBe('ACTIVE');
  });

  it('janela sobreposta a um circuito aberto do PRÓPRIO agente não vale', async () => {
    await badWindows();
    await breakers.recordOutcome({ type: 'AGENT', key: DEV }, 'FAILURE', new Date(now.getTime() - 60_000)); // aberto durante a janela mais recente
    expect((await lifecycle.evaluateAgent(DEV, now)).outcome).toBe('NONE');
    expect(await status()).toBe('ACTIVE');
  });

  it('o circuito de OUTRO agente, mesmo sobreposto às janelas, não protege nem atrapalha este agente', async () => {
    await badWindows();
    await breakers.recordOutcome({ type: 'AGENT', key: 'REVISOR-001' }, 'FAILURE', new Date(now.getTime() - 60_000));
    expect(await lifecycle.evaluateAgent(DEV, now)).toMatchObject({ outcome: 'TRANSITIONED', to: 'SLEEP' });
  });

  it('circuito FECHADO depois da janela já não é pausa: a janela volta a valer', async () => {
    await badWindows();
    const key = { type: 'AGENT', key: DEV } as const;
    // As janelas cobrem os últimos 3 dias. O circuito abre (-6d), a sonda passa depois do cooldown de 24h
    // (-5d + 1h) e fecha (-5d + 2h): tudo ANTES da janela mais antiga, então nenhuma janela se sobrepõe.
    await breakers.recordOutcome(key, 'FAILURE', new Date(now.getTime() - 6 * 24 * HOUR));
    expect(await breakers.admit(key, new Date(now.getTime() - 5 * 24 * HOUR + HOUR))).toBe('PROBE');
    await breakers.recordOutcome(key, 'SUCCESS', new Date(now.getTime() - 5 * 24 * HOUR + 2 * HOUR));
    expect((await breakers.state(key)).status).toBe('CLOSED');
    expect(await lifecycle.evaluateAgent(DEV, now)).toMatchObject({ outcome: 'TRANSITIONED', to: 'SLEEP' });
  });

  it('circuito em HALF_OPEN (sonda sem desfecho) continua sendo pausa até fechar: as janelas seguem inválidas', async () => {
    await badWindows();
    const key = { type: 'AGENT', key: DEV } as const;
    await breakers.recordOutcome(key, 'FAILURE', new Date(now.getTime() - 100 * HOUR)); // abre antes de todas as janelas
    expect(await breakers.admit(key, new Date(now.getTime() - 75 * HOUR))).toBe('PROBE'); // HALF_OPEN, e a sonda nunca reporta
    expect((await breakers.state(key)).status).toBe('HALF_OPEN');
    expect(await lifecycle.evaluateAgent(DEV, now)).toMatchObject({ outcome: 'NONE' });
    expect(await status()).toBe('ACTIVE');
  });

  it('com o Emergency Stop engajado, a automação de lifecycle espera: nada muda', async () => {
    await badWindows();
    await stop.engage('FOUNDER_CLI', 'teste');
    expect(await lifecycle.evaluateAgent(DEV, new Date(now.getTime() + 48 * HOUR))).toMatchObject({ outcome: 'NONE', reason: 'EMERGENCY_STOP' });
    expect(await status()).toBe('ACTIVE');
    expect(await count('agent_lifecycle_transitions')).toBe(0);
  });
});

describe('SLEEP reversível, sem depender de desempenho (critério 19)', () => {
  async function sleepingSince(hoursAgo: number): Promise<void> {
    await setStatus(DEV, 'SLEEP');
    await recordTransitionAt(DEV, 'ACTIVE', 'SLEEP', new Date(now.getTime() - hoursAgo * HOUR));
  }
  async function insertAssignedTask(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (objective, status, assigned_agent_id) VALUES ('objetivo', 'ASSIGNED', $1) RETURNING id`,
      [DEV],
    );
    return rows[0]!.id;
  }

  it('acorda com cooldown vencido e demanda elegível, SEM nenhuma avaliação de desempenho, e retoma o trabalho pausado', async () => {
    await sleepingSince(30);
    const taskId = await insertAssignedTask();
    await pool.query(`INSERT INTO paused_work (job_name, entity_id, pause_reason) VALUES ($1, $2, 'AGENT_SLEEPING')`, [JOB_NAMES.DEVELOP_TASK, taskId]);

    const result = await lifecycle.evaluateAgent(DEV, now);
    expect(result).toMatchObject({ outcome: 'TRANSITIONED', from: 'SLEEP', to: 'ACTIVE' });
    expect(await status()).toBe('ACTIVE');
    expect(await count(`events WHERE type = 'AGENT_WOKE'`)).toBe(1);
    // Acordar só muda o lifecycle e retoma o que esperava; não inicia task por conta própria.
    expect(await count('paused_work WHERE resumed_at IS NULL')).toBe(0);
    expect(await count(`outbox WHERE job_name = 'develop-task'`)).toBe(1);
    expect(await count('agent_performance')).toBe(0);
  });

  it('não acorda antes do tempo mínimo em SLEEP, mesmo com demanda', async () => {
    await sleepingSince(3);
    await insertAssignedTask();
    expect(await lifecycle.evaluateAgent(DEV, now)).toMatchObject({ outcome: 'NONE', reason: 'COOLDOWN' });
    expect(await status()).toBe('SLEEP');
  });

  it('sem demanda elegível continua dormindo, mesmo depois do tempo mínimo', async () => {
    await sleepingSince(100);
    expect(await lifecycle.evaluateAgent(DEV, now)).toMatchObject({ outcome: 'NONE', reason: 'SEM_DEMANDA_ELEGIVEL' });
    expect(await status()).toBe('SLEEP');
  });

  it('o portão de jobs pausa o trabalho de um agente em SLEEP (e o registra como retomável)', async () => {
    await sleepingSince(1);
    const taskId = await insertAssignedTask();
    const gate = createJobGate({ pool, controller: new AutonomyController({ governor, stop: stopReaderFor(pool), breakers }), sourceKey: 'github' });
    const decision = await gate.admit({ name: JOB_NAMES.DEVELOP_TASK, data: { taskId, correlationId: crypto.randomUUID() } });
    expect(decision).toMatchObject({ admitted: false, gate: 'AGENT_SLEEPING' });
    expect(await count('paused_work WHERE resumed_at IS NULL')).toBe(1);
  });
});

describe('o humano usa o mesmo serviço e o Governor nunca autoriza ARCHIVED (critério 20)', () => {
  it('o fundador acorda um agente pelo LifecycleService, com o ator FOUNDER no histórico', async () => {
    await setStatus(DEV, 'SLEEP');
    const result = await lifecycle.applyManual(DEV, 'ACTIVE', 'decisão do fundador');
    expect(result).toMatchObject({ outcome: 'TRANSITIONED', from: 'SLEEP', to: 'ACTIVE' });
    const { rows } = await pool.query<{ actor: string }>('SELECT actor FROM agent_lifecycle_transitions');
    expect(rows.map((r) => r.actor)).toEqual(['FOUNDER']);
  });

  it('nem o humano arquiva pelo serviço: o Governor nega e nada muda', async () => {
    const result = await lifecycle.applyManual(DEV, 'ARCHIVED' as never, 'tentativa');
    expect(result).toMatchObject({ outcome: 'NONE', reason: 'LIFECYCLE_TRANSITION_NOT_ALLOWED' });
    expect(await status()).toBe('ACTIVE');
    expect(await count('agent_lifecycle_transitions')).toBe(0);
  });

  it('o banco também recusa ARCHIVED no histórico, e o histórico é append-only', async () => {
    await expect(
      pool.query(`INSERT INTO agent_lifecycle_transitions (agent_id, from_status, to_status, reason, actor) VALUES ($1, 'SLEEP', 'ARCHIVED', 'x', 'FOUNDER')`, [DEV]),
    ).rejects.toThrow(/to_status_check/);
    await lifecycle.applyManual(DEV, 'SLEEP', 'x');
    await expect(pool.query(`UPDATE agent_lifecycle_transitions SET reason = 'y'`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM agent_lifecycle_transitions`)).rejects.toThrow(/append-only/);
  });

  it('agente já ARCHIVED (fora do lifecycle automático) nunca é tocado pela avaliação', async () => {
    await setStatus(DEV, 'ARCHIVED');
    expect(await lifecycle.evaluateAgent(DEV, now)).toMatchObject({ outcome: 'NONE', reason: 'AGENTE_FORA_DO_LIFECYCLE_AUTOMATICO' });
  });
});

describe('avaliação de todos os agentes', () => {
  it('sem avaliações de desempenho, nenhum agente muda de estado', async () => {
    const results = await lifecycle.evaluateAll(now);
    expect(results.length).toBeGreaterThanOrEqual(4);
    expect(results.every((r) => r.outcome === 'NONE')).toBe(true);
    expect(await count('agent_lifecycle_transitions')).toBe(0);
  });
});
