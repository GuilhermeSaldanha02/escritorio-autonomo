import { createPool } from '@escritorio/database';
import { createRedisConnection, createSystemQueue, EventBus, EventStore } from '@escritorio/events';
import { Governor, loadConstitution } from '@escritorio/governor';
import { createLogger, describeError, exitOnShutdownSignals, loadConfig, loadEnvFile } from '@escritorio/shared';
import { buildServer } from './server.js';
import { createApiShutdown } from './shutdown.js';

/**
 * A API sobe mesmo com PostgreSQL ou Redis fora do ar: é o /health que
 * reporta o problema (503), em vez de o processo morrer sem explicar.
 */
async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  const logger = createLogger('api', config.LOG_LEVEL);
  const governor = new Governor(loadConstitution(config.CONSTITUTION_PATH));

  const pool = createPool(config.DATABASE_URL, logger, 'escritorio-api');
  const redis = createRedisConnection(config.REDIS_URL, 'producer', 'escritorio-api');
  redis.on('error', (error) => logger.warn({ err: describeError(error) }, 'erro de conexão com Redis'));
  const queue = createSystemQueue(redis, config.QUEUE_PREFIX);
  queue.on('error', (error) => logger.warn({ err: describeError(error) }, 'erro na fila BullMQ'));
  const store = new EventStore(pool);

  const app = await buildServer({
    logger,
    db: pool,
    redis,
    queue,
    bus: new EventBus(store),
    store,
    governor,
    aiMode: config.AI_MODE,
  });

  const shutdown = createApiShutdown({
    app,
    queue,
    redis,
    pool,
    logger,
    timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
  });
  exitOnShutdownSignals(process, shutdown, (code) => process.exit(code), logger);

  await app.listen({ host: config.API_HOST, port: config.API_PORT });
  logger.info({ aiMode: config.AI_MODE }, 'API pronta');
}

main().catch((error: unknown) => {
  createLogger('api').fatal({ err: describeError(error) }, 'API não conseguiu iniciar');
  process.exit(1);
});
