import type { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool } from '@escritorio/database';
import { createGracefulShutdown, type GracefulShutdown, type Logger } from '@escritorio/shared';

export interface WorkerShutdownDeps {
  worker: Pick<Worker, 'close'>;
  connection: Pick<Redis, 'quit'>;
  pool: Pick<Pool, 'end'>;
  logger: Logger;
  timeoutMs: number;
}

/**
 * Ordem: o Worker para de pegar jobs e espera os ativos terminarem (eles ainda
 * gravam no banco); só então Redis e PostgreSQL fecham. Se o prazo estourar,
 * o processo sai e o BullMQ devolve o job à fila como travado — o retry é
 * seguro porque os eventos do job são idempotentes.
 */
export function createWorkerShutdown({ worker, connection, pool, logger, timeoutMs }: WorkerShutdownDeps): GracefulShutdown {
  return createGracefulShutdown({
    logger,
    timeoutMs,
    steps: [
      { name: 'worker', close: () => worker.close() },
      { name: 'redis', close: () => connection.quit() },
      { name: 'postgres', close: () => pool.end() },
    ],
  });
}
