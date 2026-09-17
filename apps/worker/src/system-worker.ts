import { UnrecoverableError, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { type EventStore, JOB_NAMES, QUEUE_NAMES } from '@escritorio/events';
import type { Governor } from '@escritorio/governor';
import { describeError, type Logger } from '@escritorio/shared';
import { createDiagnosticProcessor } from './diagnostic-processor.js';

export interface SystemWorkerDeps {
  connection: Redis;
  prefix: string;
  store: EventStore;
  governor: Governor;
  logger: Logger;
}

/** Consumidor da fila `system`. A concorrência é a da Constituição (MAX_PARALLEL_TASKS). */
export function createSystemWorker({ connection, prefix, store, governor, logger }: SystemWorkerDeps): Worker {
  const processDiagnostic = createDiagnosticProcessor({ store, governor, logger });

  const worker = new Worker(
    QUEUE_NAMES.SYSTEM,
    async (job) => {
      switch (job.name) {
        case JOB_NAMES.DIAGNOSTIC:
          return processDiagnostic(job);
        default:
          throw new UnrecoverableError(`Job desconhecido na fila ${QUEUE_NAMES.SYSTEM}: ${job.name}`);
      }
    },
    { connection, prefix, concurrency: governor.limits.MAX_PARALLEL_TASKS },
  );

  worker.on('failed', (job, error) => {
    logger.error(
      { jobId: job?.id, attemptsMade: job?.attemptsMade, err: describeError(error) },
      'job falhou',
    );
  });
  worker.on('error', (error) => {
    logger.error({ err: describeError(error) }, 'erro no Worker BullMQ');
  });

  return worker;
}
