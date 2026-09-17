import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '@escritorio/api';
import { type Pool, seedInitialAgents } from '@escritorio/database';
import { createQueues, createRedisConnection, EventBus, EventStore, OutboxDispatcher } from '@escritorio/events';
import { Governor, loadConstitution } from '@escritorio/governor';
import { createDockerClient, SandboxManager } from '@escritorio/tools';
import { createOrchestratorWorker } from '@escritorio/worker';
import { createTestPool, logger, resetDatabase, testRedisUrl, uniqueQueuePrefix, waitFor } from './support.js';

/**
 * API de simulação (§19, passo 6 do M2) contra a esteira real: POST cria a
 * oportunidade simulada e dispara o ciclo; GET expõe a linha do tempo — a
 * mesma consulta que o Office 2D (fora do M2) vai usar mais tarde.
 */
const governor = new Governor(loadConstitution());
let pool: Pool;
let producer: Redis;
let consumer: Redis;
let queues: Map<string, Queue>;
let dispatcher: OutboxDispatcher;
let app: Awaited<ReturnType<typeof buildServer>>;
let worker: ReturnType<typeof createOrchestratorWorker>;

beforeEach(async () => {
  pool = createTestPool();
  await resetDatabase(pool);
  await seedInitialAgents(pool);

  const prefix = uniqueQueuePrefix();
  producer = createRedisConnection(testRedisUrl(), 'producer', 'sim-test-producer');
  consumer = createRedisConnection(testRedisUrl(), 'consumer', 'sim-test-consumer');
  if (producer.status !== 'ready') await new Promise((resolve) => producer.once('ready', resolve));

  queues = createQueues(producer, prefix);
  dispatcher = new OutboxDispatcher({ pool, queues, logger, pollIntervalMs: 50 });
  dispatcher.start();

  const sandboxManager = new SandboxManager(createDockerClient(), logger);
  worker = createOrchestratorWorker({ connection: consumer, prefix, pool, governor, sandboxManager, logger });
  await worker.waitUntilReady();

  app = await buildServer({
    logger,
    db: pool,
    redis: producer,
    bus: new EventBus(pool),
    store: new EventStore(pool),
    governor,
    aiMode: 'mock',
  });
});

afterEach(async () => {
  await dispatcher.stop();
  await worker.close();
  await app.close();
  if (producer.status === 'ready') {
    await Promise.all([...queues.values()].map((queue) => queue.obliterate({ force: true })));
  }
  await Promise.all([producer.quit(), consumer.quit()]);
  await pool.end();
});

describe('POST /simulations/opportunities', () => {
  it('cria a oportunidade simulada e dispara OPPORTUNITY_FOUND', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/simulations/opportunities',
      payload: { title: 'Bug bounty simulado' },
    });
    expect(response.statusCode).toBe(202);
    const body = response.json<{ opportunityId: string; correlationId: string; timelineUrl: string }>();
    expect(body.timelineUrl).toBe(`/opportunities/${body.opportunityId}/timeline`);

    const { rows } = await pool.query<{ status: string; title: string }>('SELECT status, title FROM opportunities WHERE id = $1', [
      body.opportunityId,
    ]);
    expect(rows[0]).toEqual({ status: 'DISCOVERED', title: 'Bug bounty simulado' });
  });

  it('rejeita capacidade fora do catálogo antes de gravar qualquer coisa', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/simulations/opportunities',
      payload: { requiredCapabilities: ['FORMAT_DISK'] },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /opportunities/:id/timeline', () => {
  it('responde 404 para oportunidade inexistente', async () => {
    const response = await app.inject({ method: 'GET', url: `/opportunities/${crypto.randomUUID()}/timeline` });
    expect(response.statusCode).toBe(404);
  });

  it(
    'acompanha o ciclo completo até COMPLETED, com a task e os eventos em ordem',
    async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/simulations/opportunities',
        payload: { title: 'Ciclo completo via API' },
      });
      const { opportunityId } = created.json<{ opportunityId: string }>();

      const finalState = await waitFor(
        async () => {
          const response = await app.inject({ method: 'GET', url: `/opportunities/${opportunityId}/timeline` });
          expect(response.statusCode).toBe(200);
          const body = response.json<{ opportunity: { status: string }; task: { status: string } | null; events: Array<{ type: string }> }>();
          return body.opportunity.status === 'SUBMITTED' && body.task?.status === 'COMPLETED' ? body : undefined;
        },
        { timeoutMs: 60_000, label: 'linha do tempo chegar a SUBMITTED/COMPLETED' },
      );

      const types = finalState.events.map((event) => event.type);
      // Ordem do fluxo alvo (§19), sem eventos fora de ordem.
      expect(types.indexOf('OPPORTUNITY_FOUND')).toBeLessThan(types.indexOf('TASK_CREATED'));
      expect(types.indexOf('TASK_CREATED')).toBeLessThan(types.indexOf('TASK_ASSIGNED'));
      expect(types.indexOf('IMPLEMENTATION_READY')).toBeLessThan(types.indexOf('REVIEW_PASSED'));
      expect(types).toContain('REVIEW_PASSED');
    },
    90_000,
  );
});
