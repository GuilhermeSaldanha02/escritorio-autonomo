import type { Queue } from 'bullmq';
import Fastify from 'fastify';
import type { Redis } from 'ioredis';
import type { Queryable } from '@escritorio/database';
import type { EventBus, EventStore } from '@escritorio/events';
import type { Governor } from '@escritorio/governor';
import type { AiMode, Logger } from '@escritorio/shared';
import { diagnosticsRoutes } from './routes/diagnostics.js';
import { healthRoutes } from './routes/health.js';

export interface ApiDeps {
  logger: Logger;
  db: Queryable;
  redis: Redis;
  queue: Queue;
  bus: EventBus;
  store: EventStore;
  governor: Governor;
  aiMode: AiMode;
}

/**
 * Monta a API sem abrir porta — os testes usam `inject`, o main chama `listen`.
 * Retorno inferido de propósito: carrega o Logger do pino, não o FastifyBaseLogger.
 */
export async function buildServer(deps: ApiDeps) {
  const app = Fastify({ loggerInstance: deps.logger });

  await app.register(healthRoutes, { db: deps.db, redis: deps.redis, aiMode: deps.aiMode });
  await app.register(diagnosticsRoutes, {
    bus: deps.bus,
    store: deps.store,
    queue: deps.queue,
    governor: deps.governor,
  });

  return app;
}
