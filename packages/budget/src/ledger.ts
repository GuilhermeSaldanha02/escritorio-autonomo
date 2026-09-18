import { type Pool, type Queryable, withTransaction } from '@escritorio/database';
import type { Governor, GovernorDecision, SpendPurpose } from '@escritorio/governor';

/**
 * Reserva atômica de orçamento (M3, critério 5 — a mais delicada).
 *
 * Um `if (jaGasto + custo <= teto)` em memória não basta: duas chamadas
 * concorrentes podem ler o mesmo "já gasto" antes de qualquer uma escrever,
 * e as duas passarem no teste individualmente enquanto juntas estouram o
 * orçamento. `pg_advisory_xact_lock` serializa, dentro da transação, toda
 * tentativa de reserva da MESMA finalidade — a segunda só entra depois que
 * a primeira já commitou (ou reverteu), então sempre lê o "já gasto" real.
 *
 * Ciclo de vida: RESERVED (estimativa reservada antes de executar) ->
 * SETTLED (custo real confirmado) ou RELEASED (a chamada não ocorreu ou
 * falhou — devolve a reserva). O "já gasto" de uma finalidade é a soma de
 * RESERVED + SETTLED; RELEASED nunca conta.
 */

export type BudgetOutcome = 'RESERVED' | 'ALREADY_RESERVED' | 'DENIED';

export interface ReserveBudgetRequest {
  purpose: SpendPurpose;
  amountBrl: number;
  /** Mesma chave = mesma reserva; nunca duplica numa reentrega. */
  idempotencyKey: string;
  taskId?: string;
  correlationId?: string;
  approvedByFounder?: boolean;
}

export interface ReserveBudgetResult {
  outcome: BudgetOutcome;
  reservationId?: string;
  decision: GovernorDecision;
}

interface ReservationRow {
  id: string;
}

async function purposeAlreadySpent(tx: Queryable, purpose: SpendPurpose): Promise<number> {
  const { rows } = await tx.query<{ total: string }>(
    `SELECT COALESCE(SUM(CASE WHEN status = 'SETTLED' THEN actual_amount_brl ELSE estimated_amount_brl END), 0)::text AS total
       FROM budget_reservations
      WHERE purpose = $1 AND status IN ('RESERVED', 'SETTLED')`,
    [purpose],
  );
  return Number(rows[0]?.total ?? 0);
}

/**
 * Reserva um valor contra o orçamento de uma finalidade, se o Governor
 * permitir. Idempotente: a mesma `idempotencyKey` nunca cria duas reservas.
 */
export async function reserveBudget(pool: Pool, governor: Governor, request: ReserveBudgetRequest): Promise<ReserveBudgetResult> {
  return withTransaction(pool, async (tx) => {
    // Serializa por finalidade — nenhuma outra reserva da mesma finalidade
    // lê o "já gasto" enquanto esta transação não terminar.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [request.purpose]);

    const existing = await tx.query<ReservationRow>(`SELECT id FROM budget_reservations WHERE idempotency_key = $1`, [
      request.idempotencyKey,
    ]);
    if (existing.rows[0]) {
      return { outcome: 'ALREADY_RESERVED', reservationId: existing.rows[0].id, decision: { allowed: true } };
    }

    const alreadySpentBrl = await purposeAlreadySpent(tx, request.purpose);
    const decision = governor.evaluate({
      kind: 'SPEND',
      purpose: request.purpose,
      amountBrl: request.amountBrl,
      alreadySpentBrl,
      approvedByFounder: request.approvedByFounder ?? false,
    });
    if (!decision.allowed) return { outcome: 'DENIED', decision };

    const { rows } = await tx.query<ReservationRow>(
      `INSERT INTO budget_reservations (purpose, status, estimated_amount_brl, idempotency_key, task_id, correlation_id)
       VALUES ($1, 'RESERVED', $2, $3, $4, $5)
       RETURNING id`,
      [request.purpose, request.amountBrl, request.idempotencyKey, request.taskId ?? null, request.correlationId ?? null],
    );
    return { outcome: 'RESERVED', reservationId: rows[0]!.id, decision };
  });
}

/** Confirma o custo real de uma reserva. No-op se ela já não estiver RESERVED (idempotente). */
export async function settleReservation(pool: Pool, reservationId: string, actualAmountBrl: number): Promise<void> {
  await pool.query(
    `UPDATE budget_reservations
        SET status = 'SETTLED', actual_amount_brl = $2, updated_at = clock_timestamp()
      WHERE id = $1 AND status = 'RESERVED'`,
    [reservationId, actualAmountBrl],
  );
}

/** Devolve uma reserva não usada (chamada não ocorreu ou falhou antes de custar algo). */
export async function releaseReservation(pool: Pool, reservationId: string): Promise<void> {
  await pool.query(
    `UPDATE budget_reservations
        SET status = 'RELEASED', updated_at = clock_timestamp()
      WHERE id = $1 AND status = 'RESERVED'`,
    [reservationId],
  );
}
