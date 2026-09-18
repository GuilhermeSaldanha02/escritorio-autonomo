import { type Pool, type Queryable, withTransaction } from '@escritorio/database';
import { transitionPaymentStatus, type PaymentStatus } from './payment-state-machine.js';
import { reconcile, type ReconciliationReport } from './reconciliation.js';
import {
  buildRevenuePosting,
  type LedgerEntry,
  type LedgerEntryType,
  type LedgerScope,
  type PaymentEvidence,
  type PaymentProvenance,
} from './revenue-posting.js';

export class ExternalPaymentNotSupportedError extends Error {
  constructor() {
    super('EXTERNAL_VERIFIED só existe a partir do M8 — no M5 toda confirmação de pagamento é SIMULATED');
    this.name = 'ExternalPaymentNotSupportedError';
  }
}

export class OpportunityNotFoundError extends Error {
  constructor(readonly opportunityId: string) {
    super(`Opportunity "${opportunityId}" não existe`);
    this.name = 'OpportunityNotFoundError';
  }
}

export type PaymentConfirmationOutcome = 'CONFIRMED' | 'ALREADY_CONFIRMED';

const PAYMENT_LEDGER_SCOPE_LOCK = 'payment-confirmation';

async function lockedStatus(tx: Queryable, opportunityId: string): Promise<PaymentStatus | string> {
  const { rows } = await tx.query<{ status: string }>(`SELECT status FROM opportunities WHERE id = $1 FOR UPDATE`, [opportunityId]);
  if (!rows[0]) throw new OpportunityNotFoundError(opportunityId);
  return rows[0].status;
}

/**
 * Avança a oportunidade um passo na state machine de pagamento
 * (SUBMITTED → ACCEPTED → PAYMENT_PENDING). O último passo, → PAID, só
 * acontece dentro de `confirmPayment`, junto com a evidência e o ledger —
 * não existe um "marcar como pago" solto. Transição ilegal lança
 * `IllegalPaymentTransitionError` sem tocar em nada.
 */
export async function advancePaymentStatus(pool: Pool, opportunityId: string, event: 'ACCEPT' | 'CONFIRM_PENDING'): Promise<PaymentStatus> {
  return withTransaction(pool, async (tx) => {
    const current = await lockedStatus(tx, opportunityId);
    const next = transitionPaymentStatus(current as PaymentStatus, event);
    await tx.query(`UPDATE opportunities SET status = $2 WHERE id = $1`, [opportunityId, next]);
    return next;
  });
}

async function insertLedgerEntry(tx: Queryable, entry: LedgerEntry, description: string): Promise<void> {
  await tx.query(
    `INSERT INTO financial_ledger (entry_type, amount_cents, ledger_scope, description, opportunity_id, external_reference, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [entry.entryType, entry.amountCents, entry.ledgerScope, description, entry.opportunityId, entry.externalReference, entry.idempotencyKey],
  );
}

/**
 * Serviço único e idempotente que confirma um pagamento (critérios 14, 16 e
 * 17 do M5): grava a `PaymentEvidence`, lança REVENUE + split 50/30/20 e leva
 * a oportunidade a PAID, tudo na mesma transação — ou tudo, ou nada.
 *
 * A mesma `idempotencyKey` nunca posta duas vezes; e como a transação
 * serializa por oportunidade (`pg_advisory_xact_lock`, mesma disciplina do
 * orçamento no M3 e da deduplicação no M4), duas confirmações concorrentes
 * da mesma evidência resolvem em uma só receita. A oportunidade precisa
 * estar em PAYMENT_PENDING: não se paga o que não foi aceito.
 */
export async function confirmPayment(pool: Pool, evidence: PaymentEvidence): Promise<PaymentConfirmationOutcome> {
  if (evidence.provenance !== 'SIMULATED') throw new ExternalPaymentNotSupportedError();
  const entries = buildRevenuePosting(evidence);

  return withTransaction(pool, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${PAYMENT_LEDGER_SCOPE_LOCK}:${evidence.opportunityId}`]);

    const existing = await tx.query(`SELECT 1 FROM payment_evidence WHERE idempotency_key = $1`, [evidence.idempotencyKey]);
    if (existing.rows[0]) return 'ALREADY_CONFIRMED';

    const current = await lockedStatus(tx, evidence.opportunityId);
    const next = transitionPaymentStatus(current as PaymentStatus, 'CONFIRM_PAID');

    await tx.query(
      `INSERT INTO payment_evidence (opportunity_id, provenance, amount_cents, currency, external_reference, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [evidence.opportunityId, evidence.provenance, evidence.amountCents, evidence.currency, evidence.externalReference, evidence.idempotencyKey],
    );
    for (const entry of entries) {
      await insertLedgerEntry(tx, entry, `${entry.entryType} (${entry.ledgerScope}) da oportunidade ${evidence.opportunityId}`);
    }
    await tx.query(`UPDATE opportunities SET status = $2 WHERE id = $1`, [evidence.opportunityId, next]);
    return 'CONFIRMED';
  });
}

/**
 * Saldo derivado do ledger (nunca um campo mutável): créditos (REVENUE,
 * FOUNDER_SUBSIDY) menos débitos (OPERATING_COST) de UM escopo. Os
 * lançamentos de split (`*_ALLOCATION`) só repartem uma receita já contada —
 * somá-los dobraria o caixa. `scope = 'REAL'` é o único que responde por caixa
 * real: `SIMULATION` nunca entra nessa conta.
 */
export async function ledgerBalanceCents(pool: Pool, scope: LedgerScope): Promise<number> {
  const { rows } = await pool.query<{ balance: string }>(
    `SELECT COALESCE(SUM(CASE entry_type
                           WHEN 'REVENUE' THEN amount_cents
                           WHEN 'FOUNDER_SUBSIDY' THEN amount_cents
                           WHEN 'OPERATING_COST' THEN -amount_cents
                           ELSE 0
                         END), 0)::text AS balance
       FROM financial_ledger
      WHERE ledger_scope = $1`,
    [scope],
  );
  return Number(rows[0]?.balance ?? 0);
}

/** Lê o estado atual do banco e roda a reconciliação — só detecta, nunca escreve. */
export async function reconcileFromDatabase(pool: Pool): Promise<ReconciliationReport> {
  const [opportunities, evidences, ledger] = await Promise.all([
    pool.query<{ id: string; status: string }>(`SELECT id, status FROM opportunities`),
    pool.query<{
      opportunity_id: string;
      provenance: PaymentProvenance;
      amount_cents: string;
      currency: string;
      external_reference: string;
      idempotency_key: string;
    }>(`SELECT opportunity_id, provenance, amount_cents, currency, external_reference, idempotency_key FROM payment_evidence`),
    pool.query<{
      entry_type: LedgerEntryType;
      amount_cents: string;
      ledger_scope: LedgerScope;
      opportunity_id: string | null;
      external_reference: string | null;
      idempotency_key: string;
    }>(`SELECT entry_type, amount_cents, ledger_scope, opportunity_id, external_reference, idempotency_key FROM financial_ledger`),
  ]);

  return reconcile(
    opportunities.rows,
    evidences.rows.map((row) => ({
      opportunityId: row.opportunity_id,
      provenance: row.provenance,
      amountCents: Number(row.amount_cents),
      currency: row.currency,
      externalReference: row.external_reference,
      idempotencyKey: row.idempotency_key,
    })),
    ledger.rows.map((row) => ({
      entryType: row.entry_type,
      amountCents: Number(row.amount_cents),
      ledgerScope: row.ledger_scope,
      opportunityId: row.opportunity_id,
      externalReference: row.external_reference,
      idempotencyKey: row.idempotency_key,
    })),
  );
}
