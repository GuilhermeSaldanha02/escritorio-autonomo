import { UnrecoverableError, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { JOB_NAMES, QUEUE_NAMES } from '@escritorio/events';
import type { Governor } from '@escritorio/governor';
import type { Pool } from '@escritorio/database';
import type { SandboxManager } from '@escritorio/tools';
import { describeError, type Logger } from '@escritorio/shared';
import { createDevelopmentHandler } from './development-handler.js';
import { createOpportunityHandler } from './opportunity-handler.js';
import { createReviewHandler } from './review-handler.js';

export interface OrchestratorWorkerDeps {
  connection: Redis;
  prefix: string;
  pool: Pool;
  governor: Governor;
  sandboxManager: SandboxManager;
  logger: Logger;
}

/**
 * Consumidor da fila `orchestrator` — um job por transição do ciclo (§8.1):
 * `decide-opportunity` (Diretor), `develop-task` (Desenvolvedor em sandbox),
 * `review-task` (Revisor em sandbox independente). Cada handler é idempotente
 * por leitura de estado (packages/events/src/transitions.ts é quem garante
 * atomicidade), então uma reentrega do BullMQ nunca duplica trabalho nem pula
 * uma transição.
 *
 * Concorrência = MAX_PARALLEL_TASKS da Constituição — garantia real só para
 * um único processo Worker (V1); com múltiplos workers, o Governor também
 * checa `TASK_START` antes de cada task começar (development-handler.ts),
 * mas um limite verdadeiramente global entre processos fica para depois do M2.
 */
export function createOrchestratorWorker({ connection, prefix, pool, governor, sandboxManager, logger }: OrchestratorWorkerDeps): Worker {
  const handleDecideOpportunity = createOpportunityHandler({ pool, governor, logger });
  const handleDevelopTask = createDevelopmentHandler({ pool, governor, sandboxManager, logger });
  const handleReviewTask = createReviewHandler({ pool, governor, sandboxManager, logger });

  const worker = new Worker(
    QUEUE_NAMES.ORCHESTRATOR,
    async (job) => {
      switch (job.name) {
        case JOB_NAMES.DECIDE_OPPORTUNITY:
          return handleDecideOpportunity(job);
        case JOB_NAMES.DEVELOP_TASK:
          return handleDevelopTask(job);
        case JOB_NAMES.REVIEW_TASK:
          return handleReviewTask(job);
        default:
          throw new UnrecoverableError(`Job desconhecido na fila ${QUEUE_NAMES.ORCHESTRATOR}: ${job.name}`);
      }
    },
    { connection, prefix, concurrency: governor.limits.MAX_PARALLEL_TASKS },
  );

  worker.on('failed', (job, error) => {
    logger.error(
      { jobId: job?.id, jobName: job?.name, attemptsMade: job?.attemptsMade, err: describeError(error) },
      'job do orquestrador falhou',
    );
  });
  worker.on('error', (error) => {
    logger.error({ err: describeError(error) }, 'erro no Worker do orquestrador');
  });

  return worker;
}
