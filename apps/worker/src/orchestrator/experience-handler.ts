import { UnrecoverableError, type Job } from 'bullmq';
import type { CircuitBreakerStore } from '@escritorio/autonomy';
import type { Pool } from '@escritorio/database';
import type { RecordExperienceJobData } from '@escritorio/events';
import { recordExperienceForTask, TaskNotAssignedError, TaskNotFinishedError } from '@escritorio/memory';
import type { Logger } from '@escritorio/shared';

export interface ExperienceHandlerDeps {
  pool: Pool;
  logger: Logger;
  /** M6: o desfecho terminal alimenta o circuito do agente. Ausente, nada é alimentado. */
  breakers?: CircuitBreakerStore;
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
export function createExperienceHandler({ pool, logger, breakers }: ExperienceHandlerDeps) {
  return async function handleRecordExperience(job: Job<RecordExperienceJobData>): Promise<void> {
    const { taskId } = job.data;
    try {
      const { experienceId, created } = await recordExperienceForTask(pool, taskId);
      logger.info({ taskId, experienceId, created }, 'experiência registrada');
      // Só o desfecho TERMINAL de uma task alimenta o circuito do agente, e só na criação:
      // uma reentrega nunca conta o mesmo desfecho duas vezes. Pausa nunca chega aqui:
      // uma task pausada não é terminal e não gera Experience (critérios 12 e 18).
      if (breakers && created) {
        const { rows } = await pool.query<{ agent_id: string; outcome: 'SUCCESS' | 'FAILURE' }>(
          'SELECT agent_id, outcome FROM experiences WHERE id = $1',
          [experienceId],
        );
        const row = rows[0];
        if (row) await breakers.recordOutcome({ type: 'AGENT', key: row.agent_id }, row.outcome, new Date(), 'desfecho terminal da task');
      }
    } catch (error) {
      if (error instanceof TaskNotFinishedError || error instanceof TaskNotAssignedError) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  };
}
