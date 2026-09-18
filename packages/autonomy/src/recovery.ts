import { type Pool, withTransaction } from '@escritorio/database';
import { EventBus, JOB_NAMES, QUEUE_NAMES } from '@escritorio/events';
import type { Governor } from '@escritorio/governor';
import type { AutonomyController } from './autonomy-controller.js';

/** Quem remove sandboxes órfãs. Injetado: o pacote de autonomia não conhece o Docker. */
export interface SandboxReaper {
  reap(olderThanMs: number, now: Date): Promise<string[]>;
}

export interface RecoveryDeps {
  pool: Pool;
  governor: Governor;
  controller: AutonomyController;
  sandboxes?: SandboxReaper;
  /** Tentativas do job re-despachado (as mesmas dos jobs normais). */
  attempts: number;
}

export interface RecoveryReport {
  tasksRedispatched: number;
  reservationsReleased: number;
  sandboxesRemoved: number;
  /** Presente quando a varredura nem começou: um portão de pausa a barrou (não é falha). */
  skipped?: string;
}

/** Task em andamento e o job que a faz avançar. */
const JOB_FOR_STATUS: Record<string, string> = {
  ASSIGNED: JOB_NAMES.DEVELOP_TASK,
  IN_PROGRESS: JOB_NAMES.DEVELOP_TASK,
  IMPLEMENTATION_READY: JOB_NAMES.REVIEW_TASK,
  IN_REVIEW: JOB_NAMES.REVIEW_TASK,
};

const IN_FLIGHT = Object.keys(JOB_FOR_STATUS);

/**
 * Recovery (M6-PLANO.md, critérios 15 e 16): varredura IDEMPOTENTE, no boot e
 * periódica, só de estado TÉCNICO. Nunca toca em fato econômico: ledger,
 * pagamento e oportunidade `PAID` ficam fora do alcance, coerente com a
 * reconciliação do M5, que só detecta.
 *
 * "Sem sinal de vida" é medido com `RESERVATION_STALE_AFTER_SECONDS`: um
 * trabalho legítimo em andamento gera atividade (evento, transição) bem antes
 * desse prazo. É uma varredura de segurança, não o caminho normal.
 */
export class RecoveryService {
  constructor(private readonly deps: RecoveryDeps) {}

  async sweep(now: Date): Promise<RecoveryReport> {
    const { governor, controller, sandboxes } = this.deps;

    // Re-despachar trabalho é uma ação mutável: com o Stop engajado, a varredura espera.
    // O trabalho pausado é retomado pelo RELEASE; o recovery cobre só o que ficou órfão.
    const decision = await controller.authorize({ origin: 'DIRECT' });
    if (!decision.allowed) return { tasksRedispatched: 0, reservationsReleased: 0, sandboxesRemoved: 0, skipped: decision.gate };

    const staleMs = governor.autonomy.RESERVATION_STALE_AFTER_SECONDS * 1000;
    const cutoff = new Date(now.getTime() - staleMs);

    const tasksRedispatched = await this.#redispatchStuckTasks(cutoff);
    const reservationsReleased = await this.#releaseOrphanReservations(cutoff);
    const sandboxesRemoved = sandboxes ? (await sandboxes.reap(staleMs, now)).length : 0;
    return { tasksRedispatched, reservationsReleased, sandboxesRemoved };
  }

  /**
   * Task em andamento, parada há mais que o prazo, sem job pendente no outbox e
   * sem pausa registrada: re-despacha o passo dela. A identidade (estado + último
   * `updated_at`) é a chave do evento e do job, então repetir ou paralelizar a
   * varredura nunca duplica o despacho.
   */
  async #redispatchStuckTasks(cutoff: Date): Promise<number> {
    const { pool, attempts } = this.deps;
    return withTransaction(pool, async (tx) => {
      const { rows } = await tx.query<{ id: string; status: string; updated_at: Date; correlation_id: string | null }>(
        `SELECT t.id, t.status, t.updated_at,
                (SELECT e.correlation_id FROM events e WHERE e.task_id = t.id AND e.correlation_id IS NOT NULL ORDER BY e.occurred_at DESC LIMIT 1) AS correlation_id
           FROM tasks t
          WHERE t.status = ANY($1)
            AND t.updated_at < $2
            AND NOT EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id AND e.occurred_at >= $2)
            AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.dispatched_at IS NULL AND o.payload->>'taskId' = t.id::text)
            AND NOT EXISTS (SELECT 1 FROM paused_work p WHERE p.entity_id = t.id AND p.resumed_at IS NULL)
          ORDER BY t.updated_at
            FOR UPDATE OF t SKIP LOCKED`,
        [IN_FLIGHT, cutoff],
      );

      let redispatched = 0;
      for (const task of rows) {
        const jobName = JOB_FOR_STATUS[task.status]!;
        const identity = `recovery:redispatch:${task.id}:${task.status}:${task.updated_at.getTime()}`;
        const correlationId = task.correlation_id ?? crypto.randomUUID();
        const result = await EventBus.publishIn(
          tx,
          {
            type: 'RECOVERY_ACTION_TAKEN',
            payload: { action: 'REDISPATCH_TASK', taskId: task.id, status: task.status, jobName },
            taskId: task.id,
            correlationId,
            idempotencyKey: identity,
          },
          { queue: QUEUE_NAMES.ORCHESTRATOR, jobName, data: () => ({ taskId: task.id, correlationId }), attempts, jobId: identity },
        );
        if (result.created) redispatched += 1;
      }
      return redispatched;
    });
  }

  /**
   * Libera reserva `RESERVED` velha SOMENTE com prova de que nenhuma execução
   * viva legítima é dona dela. O TTL sozinho nunca basta: liberar a reserva de
   * uma execução em andamento autorizaria um gasto duplicado. O dono está vivo
   * se a task dela ainda está em andamento e ativa, ou se o fio de correlação
   * dela teve evento recente. Sem task nem correlação não há como provar nada:
   * a reserva fica.
   */
  async #releaseOrphanReservations(cutoff: Date): Promise<number> {
    const { pool } = this.deps;
    return withTransaction(pool, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `UPDATE budget_reservations r
            SET status = 'RELEASED', updated_at = clock_timestamp()
          WHERE r.status = 'RESERVED'
            AND r.updated_at < $1
            AND (r.task_id IS NOT NULL OR r.correlation_id IS NOT NULL)
            AND NOT EXISTS (
              SELECT 1 FROM tasks t
               WHERE t.id = r.task_id AND t.status = ANY($2) AND t.updated_at >= $1
            )
            AND NOT EXISTS (
              SELECT 1 FROM events e
               WHERE (e.correlation_id = r.correlation_id OR e.task_id = r.task_id) AND e.occurred_at >= $1
            )
        RETURNING r.id`,
        [cutoff, IN_FLIGHT],
      );
      for (const row of rows) {
        await EventBus.publishIn(tx, {
          type: 'RECOVERY_ACTION_TAKEN',
          payload: { action: 'RELEASE_RESERVATION', reservationId: row.id },
          idempotencyKey: `recovery:release:${row.id}`,
        });
      }
      return rows.length;
    });
  }
}
