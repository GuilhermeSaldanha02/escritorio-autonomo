import { createPool } from '@escritorio/database';
import { createDockerClient, SandboxManager } from '@escritorio/tools';
import { createQueues, createRedisConnection, EventStore, OutboxDispatcher } from '@escritorio/events';
import { Governor, loadConstitution } from '@escritorio/governor';
import {
  createLogger,
  describeError,
  exitOnShutdownSignals,
  loadConfig,
  loadEnvFile,
  withTimeout,
} from '@escritorio/shared';
import { createOrchestratorWorker } from './orchestrator/orchestrator-worker.js';
import { createWorkerShutdown } from './shutdown.js';
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
  const producer = createRedisConnection(config.REDIS_URL, 'producer', 'escritorio-worker-outbox');
  producer.on('error', (error) => logger.warn({ err: describeError(error) }, 'erro no Redis do dispatcher'));

  await withTimeout(pool.query('SELECT 1'), 10_000, 'PostgreSQL');
  await withTimeout(connection.ping(), 10_000, 'Redis');
  if (producer.status !== 'ready') {
    await withTimeout(new Promise((resolve) => producer.once('ready', resolve)), 10_000, 'Redis (dispatcher)');
  }
  logger.info('PostgreSQL e Redis conectados');

  const worker = createSystemWorker({
    connection,
    prefix: config.QUEUE_PREFIX,
    store: new EventStore(pool),
    governor,
    logger,
  });
  const sandboxManager = new SandboxManager(createDockerClient(), logger);
  const orchestratorWorker = createOrchestratorWorker({
    connection,
    prefix: config.QUEUE_PREFIX,
    pool,
    governor,
    sandboxManager,
    logger,
  });
  await Promise.all([worker.waitUntilReady(), orchestratorWorker.waitUntilReady()]);
  logger.info(
    { aiMode: config.AI_MODE, concurrency: governor.limits.MAX_PARALLEL_TASKS, queues: [worker.name, orchestratorWorker.name] },
    'Worker pronto e consumindo as filas',
  );

  const queues = createQueues(producer, config.QUEUE_PREFIX);
  // Lote e prazo curtos: com o Redis fora, a transação do lote segura uma conexão
  // do pool (máx. 5) por até batchSize × publishTimeoutMs.
  const dispatcher = new OutboxDispatcher({ pool, queues, logger, batchSize: 10, publishTimeoutMs: 1_500 });
  dispatcher.start();
  logger.info({ queues: [...queues.keys()] }, 'dispatcher do outbox iniciado');

  const shutdown = createWorkerShutdown({
    dispatcher,
    workers: [worker, orchestratorWorker],
    queues: queues.values(),
    producer,
    connection,
    pool,
    logger,
    timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
  });
  exitOnShutdownSignals(process, shutdown, (code) => process.exit(code), logger);
}

main().catch((error: unknown) => {
  createLogger('worker').fatal({ err: describeError(error) }, 'Worker não conseguiu iniciar');
  process.exit(1);
});
