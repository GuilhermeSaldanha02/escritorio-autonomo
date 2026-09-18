import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiGateway, ModelRouter } from '@escritorio/ai';
import {
  AutonomyController,
  CircuitBreakerStore,
  createJobGate,
  EmergencyStopService,
  resumePausedWork,
  stopReaderFor,
  WorkPausedError,
} from '@escritorio/autonomy';
import { type Pool, seedInitialAgents } from '@escritorio/database';
import { JOB_NAMES } from '@escritorio/events';
import { Governor, loadConstitution } from '@escritorio/governor';
import { recordExperienceForTask } from '@escritorio/memory';
import { GovernedSandbox, ToolGateway } from '@escritorio/tool-gateway';
import type { SandboxManager } from '@escritorio/tools';
import { createTestPool, logger, resetDatabase } from './support.js';

/**
 * Critérios 6, 8, 11, 12, 13 e 18 do M6 contra Postgres real: o portão de jobs, o
 * PAUSED nos gateways e a retomada. Pausa nunca vira falha, nem nos dados.
 */
const governor = new Governor(loadConstitution());
const DEV = 'DESENVOLVEDOR-001';
let pool: Pool;
let stop: EmergencyStopService;
let breakers: CircuitBreakerStore;
let controller: AutonomyController;

beforeAll(async () => {
  pool = createTestPool();
});

beforeEach(async () => {
  await resetDatabase(pool);
  await seedInitialAgents(pool);
  stop = new EmergencyStopService(pool);
  // Limiar 1: uma única falha abre o circuito, para os testes serem curtos.
  breakers = new CircuitBreakerStore(pool, () => ({ failureThreshold: 1, cooldownMs: 3_600_000, minSample: 1 }));
  controller = new AutonomyController({ governor, stop: stopReaderFor(pool), breakers });
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

const job = (name: string, data: Record<string, unknown>) => ({ name, data });

describe('portão de jobs: Emergency Stop', () => {
  it('com o Stop engajado, todo job de trabalho é pausado (retorna, não lança) e fica registrado uma vez só', async () => {
    const gate = createJobGate({ pool, controller, sourceKey: 'github' });
    const taskId = await insertTask('ASSIGNED');
    const opportunityId = crypto.randomUUID();
    await stop.engage('FOUNDER_CLI', 'teste');

    const decide = job(JOB_NAMES.DECIDE_OPPORTUNITY, { opportunityId, correlationId: crypto.randomUUID() });
    const develop = job(JOB_NAMES.DEVELOP_TASK, { taskId, correlationId: crypto.randomUUID() });
    const review = job(JOB_NAMES.REVIEW_TASK, { taskId: await insertTask('IN_REVIEW'), correlationId: crypto.randomUUID() });
    for (const j of [decide, develop, review]) {
      expect(await gate.admit(j)).toMatchObject({ admitted: false, gate: 'EMERGENCY_STOP' });
    }
    expect(await count('paused_work WHERE resumed_at IS NULL')).toBe(3);
    expect(await count(`events WHERE type = 'WORK_PAUSED'`)).toBe(3);

    // Barrado de novo (o job voltou): a mesma linha, sem evento novo.
    await gate.admit(develop);
    expect(await count('paused_work')).toBe(3);
    expect(await count(`events WHERE type = 'WORK_PAUSED'`)).toBe(3);
  });

  it('a descoberta é pausada sem virar trabalho retomável (o próximo tick a regenera); record-experience NÃO é barrado', async () => {
    const gate = createJobGate({ pool, controller, sourceKey: 'github' });
    await stop.engage('FOUNDER_CLI', 'teste');
    expect(await gate.admit(job(JOB_NAMES.DISCOVER_OPPORTUNITIES, { correlationId: crypto.randomUUID() }))).toMatchObject({ admitted: false });
    expect(await count('paused_work')).toBe(0);
    // Registrar fatos já apurados não é ação de trabalho: continua com o Stop engajado.
    expect(await gate.admit(job(JOB_NAMES.RECORD_EXPERIENCE, { taskId: crypto.randomUUID() }))).toEqual({ admitted: true });
  });

  it('sem Stop, o job passa e nada é gravado', async () => {
    const gate = createJobGate({ pool, controller, sourceKey: 'github' });
    const taskId = await insertTask('ASSIGNED');
    expect(await gate.admit(job(JOB_NAMES.DEVELOP_TASK, { taskId, correlationId: crypto.randomUUID() }))).toEqual({ admitted: true });
    expect(await count('paused_work')).toBe(0);
  });

  it('PAUSA NÃO É FALHA: nada disso alimenta o circuito de ninguém', async () => {
    const gate = createJobGate({ pool, controller, sourceKey: 'github' });
    await stop.engage('FOUNDER_CLI', 'teste');
    await gate.admit(job(JOB_NAMES.DEVELOP_TASK, { taskId: await insertTask('ASSIGNED'), correlationId: crypto.randomUUID() }));
    await gate.admit(job(JOB_NAMES.DISCOVER_OPPORTUNITIES, { correlationId: crypto.randomUUID() }));
    expect(await count('circuit_breaker_events')).toBe(0);
  });
});

describe('retomada depois do RELEASE', () => {
  it('re-despacha o trabalho pausado pelo outbox, uma vez só, mesmo retomando duas vezes ou em paralelo', async () => {
    const gate = createJobGate({ pool, controller, sourceKey: 'github' });
    const taskA = await insertTask('ASSIGNED');
    const taskB = await insertTask('IN_REVIEW');
    await stop.engage('FOUNDER_CLI', 'teste');
    await gate.admit(job(JOB_NAMES.DEVELOP_TASK, { taskId: taskA, correlationId: crypto.randomUUID() }));
    await gate.admit(job(JOB_NAMES.REVIEW_TASK, { taskId: taskB, correlationId: crypto.randomUUID() }));
    await stop.release('FOUNDER_CLI', 'ok');

    const results = await Promise.all([resumePausedWork(pool, 4), resumePausedWork(pool, 4), resumePausedWork(pool, 4)]);
    expect(results.reduce((sum, r) => sum + r.resumed, 0)).toBe(2);
    expect((await resumePausedWork(pool, 4)).resumed).toBe(0);

    const { rows } = await pool.query<{ job_name: string; payload: { taskId?: string } }>(
      `SELECT job_name, payload FROM outbox ORDER BY job_name`,
    );
    expect(rows.map((r) => r.job_name).sort()).toEqual([JOB_NAMES.DEVELOP_TASK, JOB_NAMES.REVIEW_TASK]);
    expect(rows.map((r) => r.payload.taskId).sort()).toEqual([taskA, taskB].sort());
    expect(await count(`events WHERE type = 'WORK_RESUMED'`)).toBe(2);
    expect(await count('paused_work WHERE resumed_at IS NULL')).toBe(0);
  });

  it('uma nova pausa do mesmo job depois de retomado volta a ser registrada (e gera evento)', async () => {
    const gate = createJobGate({ pool, controller, sourceKey: 'github' });
    const j = job(JOB_NAMES.DEVELOP_TASK, { taskId: await insertTask('ASSIGNED'), correlationId: crypto.randomUUID() });
    await stop.engage('FOUNDER_CLI', 'a');
    await gate.admit(j);
    await stop.release('FOUNDER_CLI', 'b');
    await resumePausedWork(pool, 4);
    await stop.engage('FOUNDER_CLI', 'c');
    await gate.admit(j);
    expect(await count('paused_work WHERE resumed_at IS NULL')).toBe(1);
    expect(await count(`events WHERE type = 'WORK_PAUSED'`)).toBe(2);
  });

  it('pausa no MEIO do job (WorkPausedError) grava o trabalho como pausado, mesmo que o portão já tenha liberado', async () => {
    const gate = createJobGate({ pool, controller, sourceKey: 'github' });
    const taskId = await insertTask('IN_PROGRESS');
    await gate.pause(job(JOB_NAMES.DEVELOP_TASK, { taskId, correlationId: crypto.randomUUID() }), 'EMERGENCY_STOP', 'no meio da execução');
    expect(await count('paused_work WHERE resumed_at IS NULL')).toBe(1);
  });
});

describe('portão de jobs: circuito só barra trabalho NOVO do escopo', () => {
  it('circuito da FONTE aberto pausa a descoberta, e nada mais', async () => {
    const gate = createJobGate({ pool, controller, sourceKey: 'github' });
    await breakers.recordOutcome({ type: 'SOURCE', key: 'github' }, 'FAILURE', new Date());
    expect(await gate.admit(job(JOB_NAMES.DISCOVER_OPPORTUNITIES, { correlationId: crypto.randomUUID() }))).toMatchObject({
      admitted: false,
      gate: 'CIRCUIT_OPEN',
    });
    expect(await gate.admit(job(JOB_NAMES.DEVELOP_TASK, { taskId: await insertTask('ASSIGNED'), correlationId: crypto.randomUUID() }))).toEqual({
      admitted: true,
    });
  });

  it('circuito do AGENTE aberto barra a PRIMEIRA tentativa (ASSIGNED), e não a continuação nem o Revisor', async () => {
    const gate = createJobGate({ pool, controller, sourceKey: 'github' });
    await breakers.recordOutcome({ type: 'AGENT', key: DEV }, 'FAILURE', new Date());

    const fresh = job(JOB_NAMES.DEVELOP_TASK, { taskId: await insertTask('ASSIGNED'), correlationId: crypto.randomUUID() });
    const inFlight = job(JOB_NAMES.DEVELOP_TASK, { taskId: await insertTask('IN_PROGRESS'), correlationId: crypto.randomUUID() });
    const review = job(JOB_NAMES.REVIEW_TASK, { taskId: await insertTask('IN_REVIEW'), correlationId: crypto.randomUUID() });

    expect(await gate.admit(fresh)).toMatchObject({ admitted: false, gate: 'CIRCUIT_OPEN' });
    expect(await gate.admit(inFlight)).toEqual({ admitted: true });
    expect(await gate.admit(review)).toEqual({ admitted: true });
  });
});

describe('PAUSED nos gateways: pausa nunca vira falha nem custo', () => {
  function toolGateway() {
    const run = vi.fn(async () => ({ sandboxId: 's-1', exitCode: 0, stdout: '', stderr: '', timedOut: false, oomKilled: false, durationMs: 1 }));
    const gateway = new ToolGateway({ pool, governor, sandboxManager: { run } as unknown as SandboxManager, logger, autonomy: controller });
    return { gateway, run };
  }
  const toolRequest = (taskId: string) => ({ agentId: DEV, taskId, tool: 'CODE_EXECUTION' as const, payload: { command: ['true'] } as never });

  it('Tool Gateway com o Stop engajado: PAUSED, a sandbox não roda, nenhuma reserva é criada', async () => {
    const { gateway, run } = toolGateway();
    const taskId = await insertTask('IN_PROGRESS');
    await stop.engage('FOUNDER_CLI', 'teste');

    const outcome = await gateway.execute(toolRequest(taskId));
    expect(outcome).toMatchObject({ status: 'PAUSED', pauseGate: 'EMERGENCY_STOP' });
    expect(run).not.toHaveBeenCalled();
    expect(await count('budget_reservations')).toBe(0);
    expect(await count(`tool_calls WHERE status = 'PAUSED'`)).toBe(1);

    await stop.release('FOUNDER_CLI', 'ok');
    expect((await gateway.execute(toolRequest(taskId))).status).toBe('SUCCESS');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('GovernedSandbox lança WorkPausedError (não um erro genérico) quando o Tool Gateway pausa', async () => {
    const { gateway } = toolGateway();
    await stop.engage('FOUNDER_CLI', 'teste');
    const sandbox = new GovernedSandbox(gateway, DEV, { taskId: await insertTask('IN_PROGRESS') });
    await expect(sandbox.run({ command: ['true'] } as never)).rejects.toThrow(WorkPausedError);
  });

  it('AI Gateway com o Stop engajado: PAUSED, e a chamada real ainda acontece depois do RELEASE (não é reaproveitada)', async () => {
    const ai = new AiGateway({ pool, governor, router: new ModelRouter({ mode: 'mock' }), logger, autonomy: controller });
    const request = { agentId: 'DIRETOR-001', correlationId: crypto.randomUUID(), prompt: 'resuma' };
    await stop.engage('FOUNDER_CLI', 'teste');

    expect(await ai.complete(request)).toMatchObject({ status: 'PAUSED', pauseGate: 'EMERGENCY_STOP' });
    expect(await count(`model_calls WHERE status = 'PAUSED'`)).toBe(1);

    await stop.release('FOUNDER_CLI', 'ok');
    expect((await ai.complete(request)).status).toBe('SUCCESS');
    expect(await count(`model_calls WHERE status = 'SUCCESS'`)).toBe(1);
  });

  it('a Experience NUNCA conta PAUSED como falha: task concluída continua SUCCESS e task bloqueada só acusa TASK_BLOCKED', async () => {
    const done = await insertTask('COMPLETED');
    const blocked = await insertTask('BLOCKED');
    for (const taskId of [done, blocked]) {
      await pool.query(
        `INSERT INTO tool_calls (agent_id, task_id, tool, status, duration_ms) VALUES ($1, $2, 'CODE_EXECUTION', 'PAUSED', 0)`,
        [DEV, taskId],
      );
      await pool.query(
        `INSERT INTO model_calls (agent_id, task_id, mode, provider, model, duration_ms, status) VALUES ($1, $2, 'mock', 'mock', 'mock-1', 0, 'PAUSED')`,
        [DEV, taskId],
      );
    }
    const doneExp = await recordExperienceForTask(pool, done);
    const blockedExp = await recordExperienceForTask(pool, blocked);
    const { rows } = await pool.query<{ id: string; outcome: string; failure_codes: string[] }>(
      `SELECT id, outcome, failure_codes FROM experiences WHERE id = ANY($1)`,
      [[doneExp.experienceId, blockedExp.experienceId]],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(doneExp.experienceId)).toMatchObject({ outcome: 'SUCCESS', failure_codes: [] });
    expect(byId.get(blockedExp.experienceId)).toMatchObject({ outcome: 'FAILURE', failure_codes: ['TASK_BLOCKED'] });
  });
});
