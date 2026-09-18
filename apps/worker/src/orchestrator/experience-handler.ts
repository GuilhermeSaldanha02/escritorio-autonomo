import { UnrecoverableError, type Job } from 'bullmq';
import type { Pool } from '@escritorio/database';
import type { RecordExperienceJobData } from '@escritorio/events';
import { recordExperienceForTask, TaskNotAssignedError, TaskNotFinishedError } from '@escritorio/memory';
import type { Logger } from '@escritorio/shared';

export interface ExperienceHandlerDeps {
  pool: Pool;
  logger: Logger;
}

/**
 * Processa `record-experience`: deriva e grava a `Experience` de uma task
 * terminal (M5, critério 2). O job só carrega o id da task — o handler lê o
 * estado do banco, nunca confia em dado velho do payload.
 *
 * Idempotente: reentrega do BullMQ devolve a Experience existente (critério
 * 3). Task que não terminou, ou sem agente, é erro de programação e não de
 * infraestrutura, então não adianta tentar de novo (`UnrecoverableError`).
 */
export function createExperienceHandler({ pool, logger }: ExperienceHandlerDeps) {
  return async function handleRecordExperience(job: Job<RecordExperienceJobData>): Promise<void> {
    const { taskId } = job.data;
    try {
      const { experienceId, created } = await recordExperienceForTask(pool, taskId);
      logger.info({ taskId, experienceId, created }, 'experiência registrada');
    } catch (error) {
      if (error instanceof TaskNotFinishedError || error instanceof TaskNotAssignedError) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  };
}
