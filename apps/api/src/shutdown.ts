import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool } from '@escritorio/database';
import { createGracefulShutdown, type GracefulShutdown, type Logger } from '@escritorio/shared';

export interface ApiShutdownDeps {
  app: { close(): PromiseLike<unknown> };
  queue: Pick<Queue, 'close'>;
  redis: Pick<Redis, 'quit'>;
  pool: Pick<Pool, 'end'>;
  logger: Logger;
  timeoutMs: number;
}

/** Ordem: o HTTP para de aceitar e termina as requisições em curso; depois fila, Redis e PostgreSQL. */
export function createApiShutdown({ app, queue, redis, pool, logger, timeoutMs }: ApiShutdownDeps): GracefulShutdown {
  return createGracefulShutdown({
    logger,
    timeoutMs,
    steps: [
      { name: 'http', close: async () => void (await app.close()) },
      { name: 'queue', close: () => queue.close() },
      { name: 'redis', close: () => redis.quit() },
      { name: 'postgres', close: () => pool.end() },
    ],
  });
}
