import { createPool } from '@escritorio/database';
import { createRedisConnection, EventStore } from '@escritorio/events';
import { Governor, loadConstitution } from '@escritorio/governor';
import { createLogger, describeError, loadConfig, loadEnvFile, withTimeout } from '@escritorio/shared';
import { createSystemWorker } from './system-worker.js';

/**
 * Processo independente da interface: continua trabalhando com o navegador
 * fechado (especificação §1). Falha cedo se PostgreSQL ou Redis não respondem.
 */
async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  const logger = createLogger('worker', config.LOG_LEVEL);
  const governor = new Governor(loadConstitution(config.CONSTITUTION_PATH));

  const pool = createPool(config.DATABASE_URL, logger, 'escritorio-worker');
  const connection = createRedisConnection(config.REDIS_URL, 'consumer', 'escritorio-worker');

  await withTimeout(pool.query('SELECT 1'), 10_000, 'PostgreSQL');
  await withTimeout(connection.ping(), 10_000, 'Redis');
  logger.info('PostgreSQL e Redis conectados');

  const worker = createSystemWorker({
    connection,
    prefix: config.QUEUE_PREFIX,
    store: new EventStore(pool),
    governor,
    logger,
  });
  await worker.waitUntilReady();
  logger.info(
    { aiMode: config.AI_MODE, concurrency: governor.limits.MAX_PARALLEL_TASKS, queue: worker.name },
    'Worker pronto e consumindo a fila',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'encerrando: aguardando jobs em andamento');
    // close() espera os jobs ativos terminarem antes de soltar a fila.
    await worker.close();
    await connection.quit();
    await pool.end();
    logger.info('Worker encerrado');
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      shutdown(signal).catch((error: unknown) => {
        logger.error({ err: describeError(error) }, 'falha ao encerrar');
        process.exitCode = 1;
      });
    });
  }
}

main().catch((error: unknown) => {
  createLogger('worker').fatal({ err: describeError(error) }, 'Worker não conseguiu iniciar');
  process.exit(1);
});
