import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeSourceConnector } from '@escritorio/cacador';
import { type Pool, seedInitialAgents } from '@escritorio/database';
import { createQueues, createRedisConnection, EventBus, JOB_NAMES, OutboxDispatcher, QUEUE_NAMES } from '@escritorio/events';
import {
  advancePaymentStatus,
  confirmPayment,
  ledgerBalanceCents,
  reconcileFromDatabase,
} from '@escritorio/finance';
import { Governor, loadConstitution } from '@escritorio/governor';
import {
  DeterministicEmbeddingProvider,
  recordAgentPerformance,
  recordExperienceForTask,
  searchMemories,
  storeMemory,
} from '@escritorio/memory';
import { createDockerClient, SandboxManager } from '@escritorio/tools';
import { createOrchestratorWorker } from '@escritorio/worker';
import { createTestPool, logger, resetDatabase, testRedisUrl, uniqueQueuePrefix, waitFor } from './support.js';

/**
 * Critério 20 do M5: as duas trilhas compostas, sobre o ciclo REAL do
 * orquestrador (Postgres, Redis, BullMQ e Docker reais), no mesmo banco e na
 * mesma execução. Os dois lados já são provados separadamente em
 * memory-service.test.ts e payment-service.test.ts; este teste existe para a
 * categoria de erro que testes isolados não pegam (o E2E do M4 achou o bug de
 * ai_allowed assim). Nenhum código de produção novo.
 *
 *   (a) task → Experience → MemoryProposal → Memory → pgvector → AgentPerformance
 *   (b) SUBMITTED → ACCEPTED → PAYMENT_PENDING → PAID → receita → split → reconciliação
 *
 * Nada no sistema propõe memórias sozinho ainda, então o teste faz o papel do
 * proponente: monta a MemoryProposal a partir dos fatos da Experience.
 */
const governor = new Governor(loadConstitution());
const provider = new DeterministicEmbeddingProvider();
const DEV = 'DESENVOLVEDOR-001';

let pool: Pool;
let producer: Redis;
let consumer: Redis;
let queues: Map<string, Queue>;
let dispatcher: OutboxDispatcher;
let worker: ReturnType<typeof createOrchestratorWorker>;
let bus: EventBus;

beforeEach(async () => {
  pool = createTestPool();
  await resetDatabase(pool);
  await seedInitialAgents(pool);

  const prefix = uniqueQueuePrefix();
  producer = createRedisConnection(testRedisUrl(), 'producer', 'm5-composition-producer');
  consumer = createRedisConnection(testRedisUrl(), 'consumer', 'm5-composition-consumer');
  if (producer.status !== 'ready') await new Promise((resolve) => producer.once('ready', resolve));

  queues = createQueues(producer, prefix);
  dispatcher = new OutboxDispatcher({ pool, queues, logger, pollIntervalMs: 50 });
  dispatcher.start();

  const sandboxManager = new SandboxManager(createDockerClient(), logger);
  const connector = new FakeSourceConnector('github', [{ status: 'OK', candidates: [] }]);
  worker = createOrchestratorWorker({ connection: consumer, prefix, pool, governor, sandboxManager, connector, logger });
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

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params);
  return Number(rows[0]!.n);
}

describe('M5 — composição das duas trilhas sobre o ciclo real (critério 20)', () => {
  it(
    'task real → Experience → Memory → pgvector → AgentPerformance, e a mesma oportunidade → PAID → split → reconciliação',
    async () => {
      // ---- Ciclo real do orquestrador: oportunidade → Diretor → task → Desenvolvedor → Revisor ----
      const rewardCents = 50_000; // R$500, a recompensa verificada da própria oportunidade
      const { rows: oppRows } = await pool.query<{ id: string }>(
        `INSERT INTO opportunities
           (source, source_url, title, reward_amount, reward_currency, reward_verified, requirements,
            ai_allowed, automation_allowed, payment_method, confidence, required_capabilities)
         VALUES ('teste', $1, 'Oportunidade de composição', $2, 'BRL', true, '["critério único"]'::jsonb,
                 true, true, 'pix', 0.95, '{}')
         RETURNING id`,
        [`https://exemplo.test/${crypto.randomUUID()}`, rewardCents / 100],
      );
      const opportunityId = oppRows[0]!.id;
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

      const task = await waitFor(
        async () => {
          const { rows } = await pool.query<{ id: string; status: string }>(
            'SELECT id, status FROM tasks WHERE opportunity_id = $1',
            [opportunityId],
          );
          return rows[0]?.status === 'COMPLETED' ? rows[0] : undefined;
        },
        { timeoutMs: 60_000, label: 'task chegar a COMPLETED pelo ciclo real' },
      );

      // ---- Trilha (a): memória e performance ----
      const experience = await waitFor(
        async () => {
          const { rows } = await pool.query<{
            id: string;
            agent_id: string;
            capability: string;
            outcome: string;
            review_result: string | null;
            attempt_count: number;
          }>('SELECT id, agent_id, capability, outcome, review_result, attempt_count FROM experiences WHERE task_id = $1', [task.id]);
          return rows[0];
        },
        { timeoutMs: 20_000, label: 'Experience produzida pelo orquestrador' },
      );
      expect(experience).toMatchObject({ agent_id: DEV, outcome: 'SUCCESS', review_result: 'PASSED', attempt_count: 1 });
      expect(await count('experiences')).toBe(1);

      // O proponente monta a MemoryProposal só dos fatos da Experience; o validador decide.
      const content = `Task de ${experience.capability} concluída em ${experience.attempt_count} tentativa com review ${experience.review_result}.`;
      const stored = await storeMemory(
        pool,
        provider,
        { id: crypto.randomUUID(), experienceId: experience.id, content, confidence: 0.9, source: 'composition-test' },
        { trustLevel: 'INTERNAL', scope: { agentId: DEV } },
      );
      expect(stored.status).toBe('STORED');
      const rejected = await storeMemory(
        pool,
        provider,
        { id: crypto.randomUUID(), experienceId: experience.id, content: 'sem confiança suficiente', confidence: 0.1, source: 'composition-test' },
        { trustLevel: 'INTERNAL' },
      );
      expect(rejected.status).toBe('REJECTED');
      expect(await count('memories')).toBe(1);

      // pgvector: a consulta com o mesmo texto recupera a memória (distância 0), só para o escopo do agente dono.
      const found = await searchMemories(pool, provider, content, { scope: { agentId: DEV }, k: 3 });
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ experienceId: experience.id, trustLevel: 'INTERNAL' });
      expect(found[0]!.distance).toBeCloseTo(0, 6);
      expect(await searchMemories(pool, provider, content, { scope: { agentId: 'REVISOR-001' }, k: 3 })).toHaveLength(0);

      const window = { from: new Date(Date.now() - 3_600_000).toISOString(), to: new Date(Date.now() + 3_600_000).toISOString() };
      const performance = await recordAgentPerformance(pool, DEV, window);
      expect(performance.created).toBe(true);
      expect(performance.assessment).toMatchObject({ sampleSize: 1, tasksCompleted: 1, tasksFailed: 0, successRate: 1 });
      expect(performance.assessment.recommendedAction).toBe('INVESTIGATE'); // 1 amostra: incerteza, nunca promoção

      // ---- Trilha (b): a MESMA oportunidade que o ciclo real deixou em SUBMITTED ----
      const { rows: submitted } = await pool.query<{ status: string }>('SELECT status FROM opportunities WHERE id = $1', [opportunityId]);
      expect(submitted[0]?.status).toBe('SUBMITTED');

      expect(await advancePaymentStatus(pool, opportunityId, 'ACCEPT')).toBe('ACCEPTED');
      expect(await advancePaymentStatus(pool, opportunityId, 'CONFIRM_PENDING')).toBe('PAYMENT_PENDING');
      const evidence = {
        opportunityId,
        provenance: 'SIMULATED' as const,
        amountCents: rewardCents,
        currency: 'BRL',
        externalReference: `sim-${opportunityId}`,
        idempotencyKey: `payment:${opportunityId}:1`,
      };
      expect(await confirmPayment(pool, evidence)).toBe('CONFIRMED');

      const { rows: paid } = await pool.query<{ status: string }>('SELECT status FROM opportunities WHERE id = $1', [opportunityId]);
      expect(paid[0]?.status).toBe('PAID');

      const { rows: ledger } = await pool.query<{ entry_type: string; amount_cents: string; ledger_scope: string }>(
        'SELECT entry_type, amount_cents, ledger_scope FROM financial_ledger ORDER BY entry_type',
      );
      expect(ledger.map((r) => [r.entry_type, Number(r.amount_cents), r.ledger_scope])).toEqual([
        ['EXPANSION_ALLOCATION', 10_000, 'SIMULATION'],
        ['OPERATIONS_ALLOCATION', 15_000, 'SIMULATION'],
        ['RESERVE_ALLOCATION', 25_000, 'SIMULATION'],
        ['REVENUE', 50_000, 'SIMULATION'],
      ]);
      expect((await reconcileFromDatabase(pool)).status).toBe('RECONCILIATION_OK');

      // ---- Idempotência composta: reprocessar as duas trilhas não muda nada ----
      expect((await recordExperienceForTask(pool, task.id)).created).toBe(false);
      expect(await confirmPayment(pool, evidence)).toBe('ALREADY_CONFIRMED');
      expect((await recordAgentPerformance(pool, DEV, window)).created).toBe(false);
      expect(await count('experiences')).toBe(1);
      expect(await count('financial_ledger')).toBe(4);
      expect(await count('agent_performance')).toBe(1);

      // ---- Asserts transversais (revisão externa): nada disso vira caixa real nem decisão autônoma ----
      expect(await ledgerBalanceCents(pool, 'REAL')).toBe(0);
      expect(await ledgerBalanceCents(pool, 'SIMULATION')).toBe(rewardCents);
      expect(await count(`financial_ledger WHERE ledger_scope = 'REAL'`)).toBe(0);
      expect(await count(`payment_evidence WHERE provenance = 'EXTERNAL_VERIFIED'`)).toBe(0);
      const { rows: agents } = await pool.query<{ lifecycle_status: string }>('SELECT lifecycle_status FROM agents');
      expect(agents.every((agent) => agent.lifecycle_status === 'ACTIVE')).toBe(true);

      // Custo técnico (model_calls do ciclo) continua fora do ledger econômico: só os 4 lançamentos de receita.
      expect(await count('model_calls')).toBeGreaterThan(0);
    },
    150_000,
  );
});
