import type { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { buildServer, createApiShutdown } from '@escritorio/api';
import { type Pool, seedInitialAgents } from '@escritorio/database';
import { createQueues, createRedisConnection, EventBus, EventStore, OutboxDispatcher } from '@escritorio/events';
import { Governor, loadConstitution } from '@escritorio/governor';
import type { GracefulShutdown } from '@escritorio/shared';
import { createSystemWorker, createWorkerShutdown } from '@escritorio/worker';
import { createTestPool, logger, resetDatabase, testRedisUrl, uniqueQueuePrefix } from './support.js';

/**
 * API + Worker + dispatcher do outbox montados como em produção (mesmas
 * funções dos main.ts), cada lado com seu pool e suas conexões, contra
 * PostgreSQL e Redis reais. O prefixo de fila é único por runtime.
 */
export interface TestRuntime {
  governor: Governor;
  prefix: string;
  api: {
    app: Awaited<ReturnType<typeof buildServer>>;
    pool: Pool;
    redis: Redis;
    shutdown: GracefulShutdown;
  };
  worker: {
    pool: Pool;
    store: EventStore;
    producer: Redis;
    consumer: Redis;
    queues: Map<string, Queue>;
    dispatcher: OutboxDispatcher;
    bullWorker: Worker;
    shutdown: GracefulShutdown;
  };
  /** Remove as filas do teste e encerra os dois lados. Pode ser chamada depois de um shutdown manual. */
  close(): Promise<void>;
}

async function ready(redis: Redis): Promise<void> {
  if (redis.status !== 'ready') await new Promise((resolve) => redis.once('ready', resolve));
}

export async function startRuntime({ reset = true }: { reset?: boolean } = {}): Promise<TestRuntime> {
  const governor = new Governor(loadConstitution());
  const prefix = uniqueQueuePrefix();

  const apiPool = createTestPool();
  if (reset) {
    await resetDatabase(apiPool);
    await seedInitialAgents(apiPool);
  }
  const apiRedis = createRedisConnection(testRedisUrl(), 'producer', 'test-api');
  await ready(apiRedis);
  const app = await buildServer({
    logger,
    db: apiPool,
    redis: apiRedis,
    bus: new EventBus(apiPool),
    store: new EventStore(apiPool),
    governor,
    aiMode: 'mock',
  });
  const apiShutdown = createApiShutdown({ app, redis: apiRedis, pool: apiPool, logger, timeoutMs: 10_000 });

  const workerPool = createTestPool();
  const store = new EventStore(workerPool);
  const producer = createRedisConnection(testRedisUrl(), 'producer', 'test-worker-outbox');
  const consumer = createRedisConnection(testRedisUrl(), 'consumer', 'test-worker');
  await ready(producer);
  const queues = createQueues(producer, prefix);
  const dispatcher = new OutboxDispatcher({ pool: workerPool, queues, logger, pollIntervalMs: 50 });
  const bullWorker = createSystemWorker({ connection: consumer, prefix, store, governor, logger });
  await bullWorker.waitUntilReady();
  dispatcher.start();
  const workerShutdown = createWorkerShutdown({
    dispatcher,
    worker: bullWorker,
    queues: queues.values(),
    producer,
    connection: consumer,
    pool: workerPool,
    logger,
    timeoutMs: 10_000,
  });

  return {
    governor,
    prefix,
    api: { app, pool: apiPool, redis: apiRedis, shutdown: apiShutdown },
    worker: { pool: workerPool, store, producer, consumer, queues, dispatcher, bullWorker, shutdown: workerShutdown },
    async close() {
      await dispatcher.stop();
      await bullWorker.close();
      if (producer.status === 'ready') {
        await Promise.all([...queues.values()].map((queue) => queue.obliterate({ force: true })));
      }
      await apiShutdown('test-close');
      await workerShutdown('test-close');
    },
  };
}
