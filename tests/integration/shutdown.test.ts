import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer, createApiShutdown } from '@escritorio/api';
import { seedInitialAgents, type Pool } from '@escritorio/database';
import { createRedisConnection, createSystemQueue, EventBus, EventStore, requestDiagnosticJob } from '@escritorio/events';
import { Governor, loadConstitution } from '@escritorio/governor';
import { createSystemWorker, createWorkerShutdown } from '@escritorio/worker';
import { createTestPool, logger, resetDatabase, testRedisUrl, uniqueQueuePrefix } from './support.js';

// Encerramento gracioso com BullMQ, Redis e PostgreSQL reais. Chama a mesma
// rotina que o SIGINT/SIGTERM dispara em produção (main.ts da API e do Worker).
const governor = new Governor(loadConstitution());
let setupPool: Pool;

beforeAll(async () => {
  setupPool = createTestPool();
  await resetDatabase(setupPool);
  await seedInitialAgents(setupPool);
});

afterAll(async () => {
  await setupPool.end();
});

async function startWorker() {
  const pool = createTestPool();
  const prefix = uniqueQueuePrefix();
  const producer = createRedisConnection(testRedisUrl(), 'producer', 'shutdown-producer');
  const consumer = createRedisConnection(testRedisUrl(), 'consumer', 'shutdown-worker');
  const queue = createSystemQueue(producer, prefix);
  const store = new EventStore(pool);
  const worker = createSystemWorker({ connection: consumer, prefix, store, governor, logger });
  await worker.waitUntilReady();
  const bus = new EventBus(store);
  return { pool, producer, consumer, queue, store, worker, bus };
}

describe('encerramento gracioso do Worker', () => {
  it('termina o job em andamento, grava o evento e só então fecha Redis e PostgreSQL', async () => {
    const { pool, producer, consumer, queue, worker, bus } = await startWorker();

    const active = new Promise<void>((resolve) => worker.once('active', () => resolve()));
    const { event } = await requestDiagnosticJob(bus, queue, governor, {
      message: 'job longo durante o encerramento',
      durationMs: 1_500,
    });
    await active;

    const shutdown = createWorkerShutdown({ worker, connection: consumer, pool, logger, timeoutMs: 10_000 });
    const startedAt = Date.now();
    expect(await shutdown('SIGTERM')).toBe('clean');

    // Esperou o job em vez de matá-lo no meio, e o evento dele está no banco.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_000);
    const { rows } = await setupPool.query('SELECT type FROM events WHERE correlation_id = $1 ORDER BY occurred_at', [
      event.correlationId,
    ]);
    expect(rows).toEqual([{ type: 'TEST_JOB_REQUESTED' }, { type: 'TEST_JOB_COMPLETED' }]);

    // Recursos realmente fechados.
    // quit() resolve com o OK do servidor; o status vira 'end' logo depois, no fechamento do socket.
    await expect.poll(() => consumer.status).toBe('end');
    expect(pool.ended).toBe(true);

    await queue.obliterate({ force: true });
    await queue.close();
    await producer.quit();
  });

  it('estoura o prazo quando o job não termina a tempo', async () => {
    const { pool, producer, consumer, queue, worker, bus } = await startWorker();

    const active = new Promise<void>((resolve) => worker.once('active', () => resolve()));
    await requestDiagnosticJob(bus, queue, governor, { message: 'lento demais', durationMs: 3_000 });
    await active;

    const shutdown = createWorkerShutdown({ worker, connection: consumer, pool, logger, timeoutMs: 300 });
    expect(await shutdown('SIGTERM')).toBe('timed-out');

    // Em produção o processo sai aqui. No teste, o encerramento continua em
    // segundo plano; esperamos ele terminar para não vazar conexões.
    await expect.poll(() => pool.ended, { timeout: 10_000, interval: 100 }).toBe(true);
    await queue.obliterate({ force: true });
    await queue.close();
    await producer.quit();
  });
});

describe('encerramento gracioso da API', () => {
  it('para o HTTP e fecha fila, Redis e PostgreSQL', async () => {
    const pool = createTestPool();
    const redis = createRedisConnection(testRedisUrl(), 'producer', 'shutdown-api');
    // O produtor não enfileira comandos offline: antes do 'ready', o /health diz 503 (correto).
    if (redis.status !== 'ready') await new Promise((resolve) => redis.once('ready', resolve));
    const queue = createSystemQueue(redis, uniqueQueuePrefix());
    const store = new EventStore(pool);
    const app = await buildServer({
      logger,
      db: pool,
      redis,
      queue,
      bus: new EventBus(store),
      store,
      governor,
      aiMode: 'mock',
    });
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);

    const shutdown = createApiShutdown({ app, queue, redis, pool, logger, timeoutMs: 5_000 });
    expect(await shutdown('SIGINT')).toBe('clean');

    await expect.poll(() => redis.status).toBe('end');
    expect(pool.ended).toBe(true);
    await expect(app.inject({ method: 'GET', url: '/health' })).rejects.toThrow();
  });
});
