import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AutonomyController,
  CircuitBreakerStore,
  EmergencyStopService,
  RecoveryService,
  type SandboxReaper,
  stopReaderFor,
} from '@escritorio/autonomy';
import { type Pool, seedInitialAgents } from '@escritorio/database';
import { JOB_NAMES } from '@escritorio/events';
import { Governor, loadConstitution } from '@escritorio/governor';
import { createDockerClient, DEFAULT_SANDBOX_IMAGE, reapLeakedSandboxes, SANDBOX_NAME_PREFIX } from '@escritorio/tools';
import { createTestPool, logger, resetDatabase } from './support.js';

/**
 * Critério 15 do M6 contra Postgres e Docker reais: o recovery só mexe em estado
 * TÉCNICO, é idempotente (inclusive em paralelo), só libera reserva com prova de que
 * não há dono vivo, e nunca toca em fato econômico.
 */
const governor = new Governor(loadConstitution());
const DEV = 'DESENVOLVEDOR-001';
let pool: Pool;
let stop: EmergencyStopService;
let recovery: RecoveryService;
let reaper: { reap: ReturnType<typeof vi.fn<SandboxReaper['reap']>> };

/** "Agora" 2h à frente do relógio real: tudo que existe hoje está parado há mais que o prazo de 30 min. */
const later = () => new Date(Date.now() + 2 * 3_600_000);

beforeAll(async () => {
  pool = createTestPool();
});

beforeEach(async () => {
  await resetDatabase(pool);
  await seedInitialAgents(pool);
  stop = new EmergencyStopService(pool);
  const controller = new AutonomyController({
    governor,
    stop: stopReaderFor(pool),
    breakers: new CircuitBreakerStore(pool, () => ({ failureThreshold: 5, cooldownMs: 1000, minSample: 1 })),
  });
  reaper = { reap: vi.fn<SandboxReaper['reap']>(async () => []) };
  recovery = new RecoveryService({ pool, governor, controller, sandboxes: reaper, attempts: 4 });
});

afterAll(async () => {
  await pool.end();
});

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params);
  return Number(rows[0]!.n);
}

async function insertTask(status: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO tasks (objective, status, assigned_agent_id) VALUES ('objetivo', $1, $2) RETURNING id`,
    [status, DEV],
  );
  return rows[0]!.id;
}

async function insertReservation(fields: { taskId?: string; correlationId?: string; status?: string; ageMinutes: number }): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO budget_reservations (purpose, status, estimated_amount_brl, idempotency_key, task_id, correlation_id, created_at, updated_at)
     VALUES ('DEVELOPMENT_EXTERNAL_SERVICE', $1, 0, $2, $3, $4, now() - make_interval(mins => $5), now() - make_interval(mins => $5))
     RETURNING id`,
    [fields.status ?? 'RESERVED', `teste:${crypto.randomUUID()}`, fields.taskId ?? null, fields.correlationId ?? null, fields.ageMinutes],
  );
  return rows[0]!.id;
}

async function reservationStatus(id: string): Promise<string> {
  const { rows } = await pool.query<{ status: string }>('SELECT status FROM budget_reservations WHERE id = $1', [id]);
  return rows[0]!.status;
}

describe('recovery de tasks paradas', () => {
  it('re-despacha o passo certo de cada task órfã, e repetir a varredura não duplica nada', async () => {
    const developing = await insertTask('IN_PROGRESS');
    const reviewing = await insertTask('IN_REVIEW');

    const first = await recovery.sweep(later());
    expect(first).toMatchObject({ tasksRedispatched: 2 });

    const { rows } = await pool.query<{ job_name: string; payload: { taskId: string } }>(`SELECT job_name, payload FROM outbox`);
    expect(rows.find((r) => r.payload.taskId === developing)?.job_name).toBe(JOB_NAMES.DEVELOP_TASK);
    expect(rows.find((r) => r.payload.taskId === reviewing)?.job_name).toBe(JOB_NAMES.REVIEW_TASK);
    expect(await count(`events WHERE type = 'RECOVERY_ACTION_TAKEN'`)).toBe(2);

    expect((await recovery.sweep(later())).tasksRedispatched).toBe(0);
    expect(await count('outbox')).toBe(2);
  });

  it('varreduras EM PARALELO também produzem um despacho por task', async () => {
    await insertTask('IN_PROGRESS');
    await insertTask('ASSIGNED');
    const reports = await Promise.all([recovery.sweep(later()), recovery.sweep(later()), recovery.sweep(later())]);
    expect(reports.reduce((sum, r) => sum + r.tasksRedispatched, 0)).toBe(2);
    expect(await count('outbox')).toBe(2);
  });

  it('não mexe no que está vivo, terminal, pausado ou já com job pendente', async () => {
    const fresh = await insertTask('IN_PROGRESS');
    const done = await insertTask('COMPLETED');
    const blocked = await insertTask('BLOCKED');
    const paused = await insertTask('IN_PROGRESS');
    const queued = await insertTask('IN_PROGRESS');

    await pool.query(`INSERT INTO paused_work (job_name, entity_id, pause_reason) VALUES ($1, $2, 'stop')`, [JOB_NAMES.DEVELOP_TASK, paused]);
    const { rows: ev } = await pool.query<{ id: string }>(`INSERT INTO events (type, payload, task_id) VALUES ('TASK_STARTED', '{}', $1) RETURNING id`, [queued]);
    await pool.query(
      `INSERT INTO outbox (event_id, queue, job_name, job_id, payload, job_attempts) VALUES ($1, 'orchestrator', 'develop-task', $2, $3, 4)`,
      [ev[0]!.id, `pendente-${queued}`, JSON.stringify({ taskId: queued })],
    );

    // "Agora" = o real: nada tem mais de 30 min, então a task viva (fresh) não é candidata.
    expect((await recovery.sweep(new Date())).tasksRedispatched).toBe(0);
    // Com o relógio à frente, só sobram elegíveis as que não são terminais, pausadas nem já enfileiradas.
    const report = await recovery.sweep(later());
    expect(report.tasksRedispatched).toBe(1);
    const { rows } = await pool.query<{ payload: { taskId: string } }>(`SELECT payload FROM outbox WHERE job_id LIKE 'recovery-%'`);
    expect(rows.map((r) => r.payload.taskId)).toEqual([fresh]);
    expect([done, blocked, paused, queued]).not.toContain(fresh);
  });

  it('o recovery NUNCA consome retry funcional da task', async () => {
    const taskId = await insertTask('IN_PROGRESS');
    await pool.query('UPDATE tasks SET retry_count = 2 WHERE id = $1', [taskId]);
    await recovery.sweep(later());
    const { rows } = await pool.query<{ retry_count: number }>('SELECT retry_count FROM tasks WHERE id = $1', [taskId]);
    expect(rows[0]!.retry_count).toBe(2);
  });
});

describe('recovery de reservas: só com prova de que não há dono vivo', () => {
  it('libera a reserva velha de uma task terminal; SETTLED e as recentes ficam', async () => {
    const dead = await insertTask('COMPLETED');
    const orphan = await insertReservation({ taskId: dead, ageMinutes: 120 });
    const recent = await insertReservation({ taskId: dead, ageMinutes: 1 });
    const settled = await insertReservation({ taskId: dead, ageMinutes: 120, status: 'SETTLED' });

    expect((await recovery.sweep(new Date())).reservationsReleased).toBe(1);
    expect(await reservationStatus(orphan)).toBe('RELEASED');
    expect(await reservationStatus(recent)).toBe('RESERVED');
    expect(await reservationStatus(settled)).toBe('SETTLED');
  });

  it('TTL sozinho NÃO libera: dono vivo (task em andamento e ativa) mantém a reserva', async () => {
    const alive = await insertTask('IN_PROGRESS'); // updated_at = agora: atividade recente
    const held = await insertReservation({ taskId: alive, ageMinutes: 120 });
    expect((await recovery.sweep(new Date())).reservationsReleased).toBe(0);
    expect(await reservationStatus(held)).toBe('RESERVED');
  });

  it('dono vivo pelo fio de correlação: evento recente com o mesmo correlation_id mantém a reserva', async () => {
    const correlationId = crypto.randomUUID();
    const held = await insertReservation({ correlationId, ageMinutes: 120 });
    await pool.query(`INSERT INTO events (type, payload, correlation_id) VALUES ('AI_CALL_RECORDED', '{}', $1)`, [correlationId]);
    expect((await recovery.sweep(new Date())).reservationsReleased).toBe(0);
    expect(await reservationStatus(held)).toBe('RESERVED');
  });

  it('sem task nem correlação não há como provar que o dono morreu: a reserva fica', async () => {
    const unprovable = await insertReservation({ ageMinutes: 600 });
    expect((await recovery.sweep(new Date())).reservationsReleased).toBe(0);
    expect(await reservationStatus(unprovable)).toBe('RESERVED');
  });

  it('a liberação é idempotente e publica RECOVERY_ACTION_TAKEN uma vez por reserva', async () => {
    const dead = await insertTask('BLOCKED');
    await insertReservation({ taskId: dead, ageMinutes: 120 });
    await Promise.all([recovery.sweep(new Date()), recovery.sweep(new Date())]);
    await recovery.sweep(new Date());
    expect(await count(`events WHERE payload->>'action' = 'RELEASE_RESERVATION'`)).toBe(1);
    expect(await count(`budget_reservations WHERE status = 'RELEASED'`)).toBe(1);
  });
});

describe('recovery nunca toca em fato econômico', () => {
  it('oportunidade PAID, ledger e evidência de pagamento ficam exatamente como estavam', async () => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO opportunities (source, source_url, title, status) VALUES ('teste', 'https://exemplo.test/x', 't', 'PAID') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO financial_ledger (entry_type, amount_cents, ledger_scope, description, opportunity_id, external_reference, idempotency_key)
       VALUES ('REVENUE', 1000, 'SIMULATION', 'r', $1, 'ref', 'rev-1')`,
      [rows[0]!.id],
    );
    await insertTask('IN_PROGRESS');
    await insertReservation({ taskId: await insertTask('COMPLETED'), ageMinutes: 120 });

    const before = await pool.query(`SELECT (SELECT status FROM opportunities WHERE id = $1) AS opp, (SELECT count(*) FROM financial_ledger) AS ledger`, [rows[0]!.id]);
    await recovery.sweep(later());
    const after = await pool.query(`SELECT (SELECT status FROM opportunities WHERE id = $1) AS opp, (SELECT count(*) FROM financial_ledger) AS ledger`, [rows[0]!.id]);
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(after.rows[0]).toMatchObject({ opp: 'PAID', ledger: '1' });
  });
});

describe('recovery e o Emergency Stop', () => {
  it('com o Stop engajado a varredura espera (é pausa, não falha) e nada muda', async () => {
    await insertTask('IN_PROGRESS');
    await stop.engage('FOUNDER_CLI', 'teste');
    const report = await recovery.sweep(later());
    expect(report).toMatchObject({ tasksRedispatched: 0, reservationsReleased: 0, sandboxesRemoved: 0, skipped: 'EMERGENCY_STOP' });
    expect(await count('outbox')).toBe(0);
    expect(reaper.reap).not.toHaveBeenCalled();
  });
});

describe('recovery de sandboxes órfãs', () => {
  it('a varredura pede ao coletor sandboxes mais velhas que o prazo e reporta quantas saíram', async () => {
    reaper.reap.mockResolvedValueOnce(['escritorio-sandbox-a', 'escritorio-sandbox-b']);
    const now = new Date();
    const report = await recovery.sweep(now);
    expect(reaper.reap).toHaveBeenCalledWith(governor.autonomy.RESERVATION_STALE_AFTER_SECONDS * 1000, now);
    expect(report.sandboxesRemoved).toBe(2);
  });

  it('DOCKER REAL: remove o contêiner órfão antigo e preserva o jovem', async () => {
    const docker = createDockerClient();
    const name = `${SANDBOX_NAME_PREFIX}recovery-teste-${crypto.randomUUID()}`;
    const container = await docker.createContainer({ name, Image: DEFAULT_SANDBOX_IMAGE, Cmd: ['true'] });
    try {
      // Jovem: com o prazo de 1h e o relógio real, o contêiner recém-criado fica.
      expect(await reapLeakedSandboxes(docker, 3_600_000, new Date(), logger)).not.toContain(name);
      expect(await docker.listContainers({ all: true, filters: { name: [name] } })).toHaveLength(1);

      // Órfão: com o relógio 2h à frente, ele passa do prazo e sai.
      expect(await reapLeakedSandboxes(docker, 3_600_000, later(), logger)).toContain(name);
      expect(await docker.listContainers({ all: true, filters: { name: [name] } })).toHaveLength(0);
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  });

  it('DOCKER REAL: só mexe em contêineres do Sandbox Manager, nunca nos alheios', async () => {
    const docker = createDockerClient();
    // O filtro do Docker é por SUBSTRING: este nome passa pelo filtro, mas não começa pelo prefixo do Sandbox Manager.
    const foreign = `outro-${SANDBOX_NAME_PREFIX}${crypto.randomUUID()}`;
    const container = await docker.createContainer({ name: foreign, Image: DEFAULT_SANDBOX_IMAGE, Cmd: ['true'] });
    try {
      await reapLeakedSandboxes(docker, 0, later(), logger);
      expect(await docker.listContainers({ all: true, filters: { name: [foreign] } })).toHaveLength(1);
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  });
});

describe('recovery de trabalho pausado: a varredura se auto-cura', () => {
  async function insertPaused(ageMinutes: number): Promise<string> {
    const entityId = await insertTask('ASSIGNED');
    await pool.query(
      `INSERT INTO paused_work (job_name, entity_id, correlation_id, pause_reason, paused_at)
       VALUES ($1, $2, $3, 'CIRCUIT_OPEN', now() - make_interval(mins => $4))`,
      [JOB_NAMES.DEVELOP_TASK, entityId, crypto.randomUUID(), ageMinutes],
    );
    return entityId;
  }

  it('retoma a pausa VELHA (circuito que fechou, release interrompido) e deixa a recente em paz', async () => {
    const old = await insertPaused(120);
    const recent = await insertPaused(1);

    const report = await recovery.sweep(new Date());
    expect(report.pausedWorkResumed).toBe(1);
    const { rows } = await pool.query<{ entity_id: string; resumed_at: Date | null }>('SELECT entity_id, resumed_at FROM paused_work');
    const byEntity = new Map(rows.map((r) => [r.entity_id, r.resumed_at]));
    expect(byEntity.get(old)).not.toBeNull();
    expect(byEntity.get(recent)).toBeNull();
    expect(await count(`outbox WHERE job_name = 'develop-task' AND payload->>'taskId' = $1`, [old])).toBe(1);

    // Repetir a varredura não duplica.
    expect((await recovery.sweep(new Date())).pausedWorkResumed).toBe(0);
    expect(await count(`outbox WHERE job_name = 'develop-task'`)).toBe(1);
  });

  it('com o Emergency Stop engajado a varredura não retoma nada', async () => {
    await insertPaused(120);
    await stop.engage('FOUNDER_CLI', 'incidente');
    const report = await recovery.sweep(new Date());
    expect(report.pausedWorkResumed).toBe(0);
    expect(report.skipped).toBe('EMERGENCY_STOP');
    expect(await count('outbox')).toBe(0);
  });
});
