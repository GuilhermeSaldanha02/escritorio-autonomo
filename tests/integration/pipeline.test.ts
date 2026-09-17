import type { Job, Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@escritorio/api';
import { seedInitialAgents, type Pool } from '@escritorio/database';
import {
  createRedisConnection,
  createSystemQueue,
  EventBus,
  EventStore,
  type StoredEvent,
} from '@escritorio/events';
import { Governor, loadConstitution } from '@escritorio/governor';
import { createDiagnosticProcessor, createSystemWorker } from '@escritorio/worker';
import { createTestPool, logger, resetDatabase, testRedisUrl, uniqueQueuePrefix, waitFor } from './support.js';

/**
 * Ponta a ponta com serviços reais: HTTP (inject) → evento persistido →
 * BullMQ/Redis → Worker → evento persistido. Nada de PostgreSQL ou Redis simulado.
 */
let pool: Pool;
let producer: Redis;
let consumer: Redis;
let queue: Queue;
let worker: Worker;
let app: Awaited<ReturnType<typeof buildServer>>;
let store: EventStore;
const governor = new Governor(loadConstitution());

beforeAll(async () => {
  pool = createTestPool();
  await resetDatabase(pool);
  await seedInitialAgents(pool);

  const prefix = uniqueQueuePrefix();
  producer = createRedisConnection(testRedisUrl(), 'producer', 'integration-api');
  consumer = createRedisConnection(testRedisUrl(), 'consumer', 'integration-worker');
  queue = createSystemQueue(producer, prefix);
  store = new EventStore(pool);

  worker = createSystemWorker({ connection: consumer, prefix, store, governor, logger });
  await worker.waitUntilReady();

  app = await buildServer({
    logger,
    db: pool,
    redis: producer,
    queue,
    bus: new EventBus(store),
    store,
    governor,
    aiMode: 'mock',
  });
});

afterAll(async () => {
  await app?.close();
  await worker?.close();
  await queue?.obliterate({ force: true });
  await queue?.close();
  await producer?.quit();
  await consumer?.quit();
  await pool?.end();
});

async function eventsFor(correlationId: string): Promise<StoredEvent[]> {
  const response = await app.inject({ method: 'GET', url: `/events?correlationId=${correlationId}` });
  expect(response.statusCode).toBe(200);
  return response.json<{ events: StoredEvent[] }>().events;
}

async function eventsUntil(correlationId: string, type: string): Promise<StoredEvent[]> {
  return waitFor(
    async () => {
      const events = await eventsFor(correlationId);
      return events.some((event) => event.type === type) ? events : undefined;
    },
    { label: `${type} para ${correlationId}` },
  );
}

describe('GET /health com serviços reais', () => {
  it('responde 200 com PostgreSQL e Redis conectados', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      database: { status: 'connected' },
      redis: { status: 'connected' },
    });
  });
});

describe('job de diagnóstico', () => {
  it('atravessa API → fila → Worker e gera evento persistido', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/diagnostics/test-jobs',
      payload: { message: 'fundação M1' },
    });
    expect(response.statusCode).toBe(202);
    const { correlationId, jobId, requestEventId } = response.json<{
      correlationId: string;
      jobId: string;
      requestEventId: string;
    }>();
    expect(jobId).toBe(requestEventId);

    const events = await eventsUntil(correlationId, 'TEST_JOB_COMPLETED');
    expect(events.map((event) => event.type)).toEqual(['TEST_JOB_REQUESTED', 'TEST_JOB_COMPLETED']);
    expect(events[1]?.payload).toMatchObject({ jobId, message: 'fundação M1', attempt: 1 });

    // Confere direto na tabela, sem passar pela API.
    const { rows } = await pool.query('SELECT type FROM events WHERE correlation_id = $1 ORDER BY occurred_at', [
      correlationId,
    ]);
    expect(rows).toEqual([{ type: 'TEST_JOB_REQUESTED' }, { type: 'TEST_JOB_COMPLETED' }]);
  });

  it('Governor bloqueia ação proibida no Worker e registra ACTION_BLOCKED', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/diagnostics/test-jobs',
      payload: { message: 'tentar operar trading', requestedCapability: 'TRADING' },
    });
    expect(response.statusCode).toBe(202);
    const { correlationId } = response.json<{ correlationId: string }>();

    const events = await eventsUntil(correlationId, 'ACTION_BLOCKED');
    expect(events.map((event) => event.type)).toEqual(['TEST_JOB_REQUESTED', 'ACTION_BLOCKED']);
    expect(events[1]?.payload).toMatchObject({
      rule: 'ALLOW_TRADING',
      action: { kind: 'CAPABILITY', capability: 'TRADING' },
    });
  });

  it('rejeita capacidade fora do catálogo antes de enfileirar', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/diagnostics/test-jobs',
      payload: { message: 'x', requestedCapability: 'FORMAT_DISK' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('reprocessar o mesmo job não duplica o evento', async () => {
    const process = createDiagnosticProcessor({ store, governor, logger });
    const correlationId = crypto.randomUUID();
    const job = {
      id: crypto.randomUUID(),
      name: 'diagnostic',
      queueName: 'system',
      attemptsMade: 0,
      data: { requestEventId: crypto.randomUUID(), correlationId, message: 'retry' },
    } as unknown as Job;

    const first = await process(job);
    const second = await process({ ...job, attemptsMade: 1 } as Job);
    expect(second).toEqual(first);

    const { rows } = await pool.query('SELECT count(*)::int AS total FROM events WHERE correlation_id = $1', [
      correlationId,
    ]);
    expect(rows[0]).toEqual({ total: 1 });
  });
});
