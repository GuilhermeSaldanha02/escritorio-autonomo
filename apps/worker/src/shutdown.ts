import type { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool } from '@escritorio/database';
import type { OutboxDispatcher } from '@escritorio/events';
import { createGracefulShutdown, type GracefulShutdown, type Logger } from '@escritorio/shared';

export interface WorkerShutdownDeps {
  dispatcher: Pick<OutboxDispatcher, 'stop'>;
  workers: Iterable<Pick<Worker, 'close'>>;
  queues: Iterable<Pick<Queue, 'close'>>;
  producer: Pick<Redis, 'quit'>;
  connection: Pick<Redis, 'quit'>;
  pool: Pick<Pool, 'end'>;
  logger: Logger;
  timeoutMs: number;
}

/**
 * Ordem: o dispatcher para de publicar; o Worker para de pegar jobs e espera
 * os ativos terminarem (eles ainda gravam no banco e no outbox); só então filas,
 * Redis e PostgreSQL fecham. Se o prazo estourar,
 * o processo sai e o BullMQ devolve o job à fila como travado — o retry é
 * seguro porque os eventos do job são idempotentes.
 */
export function createWorkerShutdown({
  dispatcher,
  workers,
  queues,
  producer,
  connection,
  pool,
  logger,
  timeoutMs,
}: WorkerShutdownDeps): GracefulShutdown {
  return createGracefulShutdown({
    logger,
    timeoutMs,
    steps: [
      { name: 'outbox-dispatcher', close: () => dispatcher.stop() },
      { name: 'workers', close: () => Promise.all([...workers].map((worker) => worker.close())) },
      { name: 'queues', close: () => Promise.all([...queues].map((queue) => queue.close())) },
      { name: 'redis-producer', close: () => producer.quit() },
      { name: 'redis-consumer', close: () => connection.quit() },
      { name: 'postgres', close: () => pool.end() },
    ],
  });
}
