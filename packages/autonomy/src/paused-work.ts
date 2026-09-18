import { type Pool, type Queryable, withTransaction } from '@escritorio/database';
import { EventBus, JOB_NAMES, QUEUE_NAMES } from '@escritorio/events';

/**
 * Sinaliza que o trabalho em andamento foi barrado por uma PAUSA (Emergency
 * Stop, circuito aberto). Não é uma falha: quem captura (o worker) grava o
 * trabalho como pausado e RETORNA NORMALMENTE, porque lançar consumiria uma
 * tentativa do BullMQ e violaria "pausa não é falha" (critério 13).
 */
export class WorkPausedError extends Error {
  constructor(readonly gate: string, readonly reason: string) {
    super(`Trabalho pausado (${gate}): ${reason}`);
    this.name = 'WorkPausedError';
  }
}

/** Jobs que podem ser retomados, e qual campo do payload identifica a entidade. */
export const RESUMABLE_JOBS = {
  [JOB_NAMES.DECIDE_OPPORTUNITY]: 'opportunityId',
  [JOB_NAMES.DEVELOP_TASK]: 'taskId',
  [JOB_NAMES.REVIEW_TASK]: 'taskId',
} as const;

export type ResumableJobName = keyof typeof RESUMABLE_JOBS;

export function isResumableJob(name: string): name is ResumableJobName {
  return name in RESUMABLE_JOBS;
}

export interface PausedWorkInput {
  jobName: ResumableJobName;
  entityId: string;
  correlationId?: string;
  reason: string;
}

/**
 * Grava (idempotente) que um job ficou pausado. Devolve `true` só quando é uma
 * pausa NOVA: uma linha já pausada não vira evento de novo, então um job que
 * volta e é barrado outra vez não polui o timeline.
 */
export async function recordPausedWork(db: Queryable, input: PausedWorkInput): Promise<boolean> {
  const { rows } = await db.query(
    `INSERT INTO paused_work (job_name, entity_id, correlation_id, pause_reason)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (job_name, entity_id) DO UPDATE
       SET resumed_at = NULL, paused_at = clock_timestamp(), pause_reason = EXCLUDED.pause_reason
       WHERE paused_work.resumed_at IS NOT NULL
     RETURNING id`,
    [input.jobName, input.entityId, input.correlationId ?? null, input.reason],
  );
  return rows.length > 0;
}

export interface ResumeResult {
  resumed: number;
}

/**
 * Re-despacha o trabalho pausado pelo outbox transacional (evento e job na
 * mesma transação), com identidade idempotente por pausa: retomar duas vezes,
 * ou em paralelo, nunca duplica o job. `SKIP LOCKED` faz dois retomadores
 * concorrentes dividirem as linhas em vez de brigar por elas.
 *
 * `pausedBefore` limita a retomada às pausas mais antigas que isso (o recovery periódico usa o prazo de
 * "sem sinal de vida"; o RELEASE do fundador e o wake de agente retomam tudo).
 *
 * Só chame depois de o Emergency Stop estar liberado; o job re-passa pelo portão
 * e, se o circuito do escopo ainda estiver aberto, é pausado de novo.
 */
export async function resumePausedWork(pool: Pool, attempts: number, pausedBefore?: Date): Promise<ResumeResult> {
  return withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      job_name: ResumableJobName;
      entity_id: string;
      correlation_id: string | null;
      paused_at: Date;
    }>(
      `SELECT id, job_name, entity_id, correlation_id, paused_at
         FROM paused_work WHERE resumed_at IS NULL AND ($1::timestamptz IS NULL OR paused_at < $1) ORDER BY paused_at FOR UPDATE SKIP LOCKED`,
      [pausedBefore ?? null],
    );

    for (const row of rows) {
      const key = RESUMABLE_JOBS[row.job_name];
      const correlationId = row.correlation_id ?? crypto.randomUUID();
      await EventBus.publishIn(
        tx,
        {
          type: 'WORK_RESUMED',
          payload: { jobName: row.job_name, entityId: row.entity_id },
          correlationId,
          idempotencyKey: `work-resumed:${row.id}:${row.paused_at.getTime()}`,
        },
        {
          queue: QUEUE_NAMES.ORCHESTRATOR,
          jobName: row.job_name,
          data: () => ({ [key]: row.entity_id, correlationId }),
          attempts,
          jobId: `resume-${row.job_name}-${row.entity_id}-${row.paused_at.getTime()}`,
        },
      );
      await tx.query(`UPDATE paused_work SET resumed_at = clock_timestamp() WHERE id = $1`, [row.id]);
    }
    return { resumed: rows.length };
  });
}
