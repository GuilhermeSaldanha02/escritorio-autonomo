import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import type { Redis } from 'ioredis';
import type { Pool, Queryable } from '@escritorio/database';
import type { EventBus, EventStore } from '@escritorio/events';
import type { Governor } from '@escritorio/governor';
import type { AiMode, Logger } from '@escritorio/shared';
import { diagnosticsRoutes } from './routes/diagnostics.js';
import { emergencyStopRoutes } from './routes/emergency-stop.js';
import { healthRoutes } from './routes/health.js';
import { simulationsRoutes } from './routes/simulations.js';
import { officeRoutes } from './routes/office.js';

export interface ApiDeps {
  logger: Logger;
  db: Queryable;
  redis: Redis;
  bus: EventBus;
  store: EventStore;
  governor: Governor;
  aiMode: AiMode;
  /** Só com os dois a rota administrativa do Emergency Stop existe. */
  pool?: Pool;
  adminSecret?: string;
}

/**
 * Monta a API sem abrir porta — os testes usam `inject`, o main chama `listen`.
 * Retorno inferido de propósito: carrega o Logger do pino, não o FastifyBaseLogger.
 */
export async function buildServer(deps: ApiDeps) {
  const app = Fastify({ loggerInstance: deps.logger });

  if (deps.pool) {
    await app.register(websocket, { options: { maxPayload: 2 * 1024 } });
    await app.register(officeRoutes, { pool: deps.pool });
  }

  await app.register(healthRoutes, { db: deps.db, redis: deps.redis, aiMode: deps.aiMode });
  await app.register(diagnosticsRoutes, {
    bus: deps.bus,
    store: deps.store,
    governor: deps.governor,
  });
  await app.register(simulationsRoutes, {
    db: deps.db,
    bus: deps.bus,
    governor: deps.governor,
  });

  if (deps.pool && deps.adminSecret) {
    await app.register(emergencyStopRoutes, { pool: deps.pool, governor: deps.governor, adminSecret: deps.adminSecret });
  }

  return app;
}
