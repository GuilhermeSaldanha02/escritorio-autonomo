import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Pool, seedInitialAgents } from '@escritorio/database';
import {
  createQueues,
  createRedisConnection,
  EventBus,
  JOB_NAMES,
  OutboxDispatcher,
  QUEUE_NAMES,
} from '@escritorio/events';
import { Governor, loadConstitution } from '@escritorio/governor';
import { createDockerClient, SandboxManager } from '@escritorio/tools';
import { createOrchestratorWorker } from '@escritorio/worker';
import { createTestPool, logger, resetDatabase, testRedisUrl, uniqueQueuePrefix, waitFor } from './support.js';

/**
 * Fluxo alvo do M2 (docs/M2-PLANO.md) de ponta a ponta contra Postgres, Redis
 * e Docker reais: Oportunidade → Diretor → Task → Desenvolvedor em sandbox →
 * Revisor em sandbox independente → COMPLETED. Cobre os critérios de aceite
 * 3 a 10 do M2 (a transição atômica em si já é provada em transitions.test.ts).
 */
const governor = new Governor(loadConstitution());
let pool: Pool;
let producer: Redis;
let consumer: Redis;
let queues: Map<string, Queue>;
let dispatcher: OutboxDispatcher;
let prefix: string;
let bus: EventBus;
let worker: ReturnType<typeof createOrchestratorWorker>;

beforeEach(async () => {
  pool = createTestPool();
  await resetDatabase(pool);
  await seedInitialAgents(pool);

  prefix = uniqueQueuePrefix();
  producer = createRedisConnection(testRedisUrl(), 'producer', 'orchestrator-test-producer');
  consumer = createRedisConnection(testRedisUrl(), 'consumer', 'orchestrator-test-consumer');
  if (producer.status !== 'ready') await new Promise((resolve) => producer.once('ready', resolve));

  queues = createQueues(producer, prefix);
  dispatcher = new OutboxDispatcher({ pool, queues, logger, pollIntervalMs: 50 });
  dispatcher.start();

  const sandboxManager = new SandboxManager(createDockerClient(), logger);
  worker = createOrchestratorWorker({ connection: consumer, prefix, pool, governor, sandboxManager, logger });
  await worker.waitUntilReady();

  bus = new EventBus(pool);
});

afterEach(async () => {
  await dispatcher.stop();
  await worker.close();
  if (producer.status === 'ready') {
    await Promise.all([...queues.values()].map((queue) => queue.obliterate({ force: true })));
  }
  await Promise.all([producer.quit(), consumer.quit()]);
  await pool.end();
});

interface OpportunitySeed {
  automationAllowed?: boolean | null;
  aiAllowed?: boolean | null;
  rewardVerified?: boolean;
  rewardAmount?: number;
  confidence?: number;
  requiredCapabilities?: readonly string[];
}

async function discoverOpportunity(seed: OpportunitySeed = {}): Promise<{ opportunityId: string; correlationId: string }> {
  const {
    automationAllowed = true,
    aiAllowed = true,
    rewardVerified = true,
    rewardAmount = 500,
    confidence = 0.95,
    requiredCapabilities = [],
  } = seed;

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO opportunities
       (source, source_url, title, reward_amount, reward_currency, reward_verified, requirements,
        ai_allowed, automation_allowed, payment_method, confidence, required_capabilities)
     VALUES ('teste', $1, 'Oportunidade de teste', $2, 'BRL', $3, '["critério único"]'::jsonb,
             $4, $5, 'pix', $6, $7)
     RETURNING id`,
    [
      `https://exemplo.test/${crypto.randomUUID()}`,
      rewardAmount,
      rewardVerified,
      aiAllowed,
      automationAllowed,
      confidence,
      requiredCapabilities,
    ],
  );
  const opportunityId = rows[0]!.id;
  const correlationId = crypto.randomUUID();

  await bus.publish(
    { type: 'OPPORTUNITY_FOUND', payload: { source: 'teste' }, opportunityId, correlationId },
    {
      queue: QUEUE_NAMES.ORCHESTRATOR,
      jobName: JOB_NAMES.DECIDE_OPPORTUNITY,
      data: () => ({ opportunityId, correlationId }),
      attempts: governor.limits.MAX_TASK_RETRIES + 1,
      jobId: `decide-opportunity-${opportunityId}`,
    },
  );

  return { opportunityId, correlationId };
}

async function opportunityStatus(id: string): Promise<string | undefined> {
  const { rows } = await pool.query<{ status: string }>('SELECT status FROM opportunities WHERE id = $1', [id]);
  return rows[0]?.status;
}

async function taskForOpportunity(opportunityId: string): Promise<{ id: string; status: string; retry_count: number } | undefined> {
  const { rows } = await pool.query<{ id: string; status: string; retry_count: number }>(
    'SELECT id, status, retry_count FROM tasks WHERE opportunity_id = $1',
    [opportunityId],
  );
  return rows[0];
}

async function eventCount(taskId: string, type: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM events WHERE task_id = $1 AND type = $2`,
    [taskId, type],
  );
  return Number(rows[0]?.count ?? 0);
}

describe('Orquestrador — ciclo completo', () => {
  it(
    'cenário feliz: oportunidade aprovada percorre até COMPLETED, com Desenvolvedor e Revisor em sandboxes distintas',
    async () => {
      const { opportunityId } = await discoverOpportunity();

      const task = await waitFor(async () => await taskForOpportunity(opportunityId), {
        timeoutMs: 30_000,
        label: 'task criada para a oportunidade',
      });

      await waitFor(
        async () => {
          const current = await taskForOpportunity(opportunityId);
          return current?.status === 'COMPLETED' ? current : undefined;
        },
        { timeoutMs: 60_000, label: 'task chegar a COMPLETED' },
      );

      expect(await opportunityStatus(opportunityId)).toBe('SUBMITTED');

      // Eventos-chave da esteira, todos persistidos em ordem (critério 4).
      for (const type of ['TASK_CREATED', 'TASK_ASSIGNED', 'TASK_STARTED', 'IMPLEMENTATION_READY', 'REVIEW_STARTED', 'REVIEW_PASSED']) {
        expect(await eventCount(task.id, type)).toBeGreaterThanOrEqual(1);
      }

      // Critério 5: sandboxes distintas entre Desenvolvedor e Revisor.
      const { rows: implRows } = await pool.query<{ payload: { developer_sandbox_id: string } }>(
        `SELECT payload FROM events WHERE task_id = $1 AND type = 'IMPLEMENTATION_READY' ORDER BY occurred_at DESC LIMIT 1`,
        [task.id],
      );
      const { rows: reviewRows } = await pool.query<{ payload: { review_sandbox_id: string } }>(
        `SELECT payload FROM events WHERE task_id = $1 AND type = 'REVIEW_PASSED' ORDER BY occurred_at DESC LIMIT 1`,
        [task.id],
      );
      const developerSandboxId = implRows[0]?.payload.developer_sandbox_id;
      const reviewSandboxId = reviewRows[0]?.payload.review_sandbox_id;
      expect(developerSandboxId).toBeTruthy();
      expect(reviewSandboxId).toBeTruthy();
      expect(reviewSandboxId).not.toBe(developerSandboxId);

      // Critério 10: os agentes mudaram de estado durante o ciclo.
      const { rows: agentRows } = await pool.query<{ id: string; state: string }>(
        `SELECT id, state FROM agents WHERE id IN ('DESENVOLVEDOR-001', 'REVISOR-001')`,
      );
      for (const row of agentRows) expect(row.state).toBe('SUCCESS');
      const stateChanges = await eventCount(task.id, 'AGENT_STATE_CHANGED');
      expect(stateChanges).toBeGreaterThanOrEqual(2); // ao menos Desenvolvedor e Revisor mudaram de estado.
    },
    90_000,
  );

  it(
    'oportunidade que exige capacidade proibida gera ACTION_BLOCKED e nenhuma task é criada (critério 7)',
    async () => {
      const { opportunityId } = await discoverOpportunity({ requiredCapabilities: ['TRADING'] });

      await waitFor(
        async () => {
          const status = await opportunityStatus(opportunityId);
          return status === 'REJECTED' ? status : undefined;
        },
        { timeoutMs: 20_000, label: 'oportunidade ser rejeitada pelo Governor' },
      );

      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM events WHERE opportunity_id = $1 AND type = 'ACTION_BLOCKED'`,
        [opportunityId],
      );
      expect(Number(rows[0]?.count)).toBeGreaterThanOrEqual(1);

      const task = await taskForOpportunity(opportunityId);
      expect(task).toBeUndefined(); // nenhuma task foi criada.
    },
    30_000,
  );
});

describe('Orquestrador — retry e bloqueio (critério 6)', () => {
  /**
   * Usa uma task já em IMPLEMENTATION_READY com um evento cujo
   * resulting_snapshot_hash não bate com resulting_files — o primeiro portão
   * de reviewInSandbox recusa sem tocar o Docker (mesma prova de
   * packages/agents/test, aqui no nível do handler). Determinístico e rápido:
   * não depende do programa mock realmente falhar dentro de um container.
   */
  async function seedTaskAwaitingReview(retryCount: number): Promise<{ taskId: string; opportunityId: string }> {
    // Fixture inserida direto no banco (como em transitions.test.ts), sem passar
    // pelo DECIDE_OPPORTUNITY real: se a oportunidade fosse descoberta pelo
    // fluxo normal, o DEVELOP_TASK automático rodaria uma sandbox de verdade
    // em paralelo com esta manipulação manual da task — uma corrida que
    // corromperia o teste. Aqui não há nenhum Desenvolvedor real envolvido.
    const { rows: oppRows } = await pool.query<{ id: string }>(
      `INSERT INTO opportunities (source, source_url, title, status, automation_allowed, ai_allowed)
       VALUES ('teste', $1, 'Oportunidade forjada', 'WORKING', true, true) RETURNING id`,
      [`https://exemplo.test/forjada-${crypto.randomUUID()}`],
    );
    const opportunityId = oppRows[0]!.id;
    const { rows: taskRows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (opportunity_id, objective, status, retry_count) VALUES ($1, 'objetivo forjado', 'IMPLEMENTATION_READY', $2) RETURNING id`,
      [opportunityId, retryCount],
    );
    const taskId = taskRows[0]!.id;
    const correlationId = crypto.randomUUID();

    await bus.publish({
      type: 'IMPLEMENTATION_READY',
      payload: {
        changed_files: ['solution.js'],
        diff: 'auditoria',
        tests: { total: 1, passed: 1, failed: 0 },
        build: true,
        elapsed_time: 0,
        cost: 0,
        dependencies_added: [],
        notes: 'forjado para teste',
        resulting_files: { 'solution.js': 'module.exports = () => 1;' },
        resulting_snapshot_hash: '0'.repeat(64), // propositalmente errado
        developer_sandbox_id: 'sandbox-forjada',
      },
      taskId,
      opportunityId,
      correlationId,
      idempotencyKey: `task:${taskId}:implementation-ready:${retryCount}:forjado`,
    });

    await queues
      .get(QUEUE_NAMES.ORCHESTRATOR)!
      .add(JOB_NAMES.REVIEW_TASK, { taskId, correlationId }, { jobId: `review-task-${taskId}-${retryCount}-forjado` });

    return { taskId, opportunityId };
  }

  it('reprovação com retries disponíveis volta a IN_PROGRESS e reagenda o Desenvolvedor', async () => {
    const { taskId } = await seedTaskAwaitingReview(0);

    await waitFor(
      async () => {
        const { rows } = await pool.query<{ status: string; retry_count: number }>('SELECT status, retry_count FROM tasks WHERE id = $1', [taskId]);
        return rows[0]?.status === 'IN_PROGRESS' ? rows[0] : undefined;
      },
      { timeoutMs: 20_000, label: 'task voltar a IN_PROGRESS após reprovação' },
    );

    const { rows } = await pool.query<{ retry_count: number }>('SELECT retry_count FROM tasks WHERE id = $1', [taskId]);
    expect(rows[0]?.retry_count).toBe(1);
    expect(await eventCount(taskId, 'REVIEW_FAILED')).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('reprovação após esgotar MAX_TASK_RETRIES bloqueia a task e falha a oportunidade', async () => {
    const { taskId, opportunityId } = await seedTaskAwaitingReview(governor.limits.MAX_TASK_RETRIES);

    await waitFor(
      async () => {
        const { rows } = await pool.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [taskId]);
        return rows[0]?.status === 'BLOCKED' ? rows[0].status : undefined;
      },
      { timeoutMs: 20_000, label: 'task ser bloqueada após esgotar retries' },
    );

    expect(await eventCount(taskId, 'TASK_BLOCKED')).toBeGreaterThanOrEqual(1);
    expect(await opportunityStatus(opportunityId)).toBe('FAILED');
  }, 30_000);
});

describe('Orquestrador — MAX_PARALLEL_TASKS (critério 9)', () => {
  it('Governor recusa iniciar uma task quando o número de tasks em execução já atingiu o limite', async () => {
    // Duas tasks "em execução" (não precisam ser reais/completas — só ocupar a contagem).
    for (let i = 0; i < governor.limits.MAX_PARALLEL_TASKS; i += 1) {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO opportunities (source, source_url, title, status, automation_allowed, ai_allowed)
         VALUES ('teste', $1, 'Ocupante', 'WORKING', true, true) RETURNING id`,
        [`https://exemplo.test/ocupante-${i}-${crypto.randomUUID()}`],
      );
      await pool.query(`INSERT INTO tasks (opportunity_id, objective, status) VALUES ($1, 'ocupante', 'IN_PROGRESS')`, [rows[0]!.id]);
    }

    const { opportunityId } = await discoverOpportunity();
    const task = await waitFor(async () => await taskForOpportunity(opportunityId), {
      timeoutMs: 30_000,
      label: 'task extra criada além do limite de paralelismo',
    });

    // A task extra fica presa em ASSIGNED: o Governor nunca autoriza o início
    // enquanto MAX_PARALLEL_TASKS já estiver ocupado pelas duas de cima.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const { rows } = await pool.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [task.id]);
    expect(rows[0]?.status).toBe('ASSIGNED');
  }, 30_000);
});
