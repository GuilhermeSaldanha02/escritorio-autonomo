import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from '@escritorio/database';
import {
  advancePaymentStatus,
  confirmPayment,
  ExternalPaymentNotSupportedError,
  IllegalPaymentTransitionError,
  ledgerBalanceCents,
  reconcileFromDatabase,
  type PaymentEvidence,
} from '@escritorio/finance';
import { createTestPool, resetDatabase } from './support.js';

/**
 * Critérios 14, 16, 17 e 18 do M5 contra Postgres real: o serviço único de
 * pagamento é idempotente e atômico, dinheiro simulado nunca vira caixa real,
 * e a reconciliação lê o estado de verdade do banco.
 */
let pool: Pool;

beforeAll(async () => {
  pool = createTestPool();
});

beforeEach(async () => {
  await resetDatabase(pool);
});

afterAll(async () => {
  await pool.end();
});

async function insertOpportunity(status = 'SUBMITTED'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO opportunities (source, source_url, title, status)
     VALUES ('teste', $1, 'Oportunidade de teste', $2) RETURNING id`,
    [`https://exemplo.test/${crypto.randomUUID()}`, status],
  );
  return rows[0]!.id;
}

async function pendingOpportunity(): Promise<string> {
  const id = await insertOpportunity('SUBMITTED');
  await advancePaymentStatus(pool, id, 'ACCEPT');
  await advancePaymentStatus(pool, id, 'CONFIRM_PENDING');
  return id;
}

function evidence(opportunityId: string, overrides: Partial<PaymentEvidence> = {}): PaymentEvidence {
  return {
    opportunityId,
    provenance: 'SIMULATED',
    amountCents: 10_101,
    currency: 'BRL',
    externalReference: `sim-${opportunityId}`,
    idempotencyKey: `payment:${opportunityId}:1`,
    ...overrides,
  };
}

async function status(opportunityId: string): Promise<string> {
  const { rows } = await pool.query<{ status: string }>(`SELECT status FROM opportunities WHERE id = $1`, [opportunityId]);
  return rows[0]!.status;
}

async function count(table: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  return Number(rows[0]!.n);
}

describe('trilha de pagamento simulado', () => {
  it('SUBMITTED → ACCEPTED → PAYMENT_PENDING → PAID, com receita e split 50/30/20 no escopo SIMULATION', async () => {
    const id = await insertOpportunity('SUBMITTED');
    expect(await advancePaymentStatus(pool, id, 'ACCEPT')).toBe('ACCEPTED');
    expect(await advancePaymentStatus(pool, id, 'CONFIRM_PENDING')).toBe('PAYMENT_PENDING');

    expect(await confirmPayment(pool, evidence(id))).toBe('CONFIRMED');
    expect(await status(id)).toBe('PAID');

    const { rows } = await pool.query<{ entry_type: string; amount_cents: string; ledger_scope: string }>(
      `SELECT entry_type, amount_cents, ledger_scope FROM financial_ledger ORDER BY entry_type`,
    );
    expect(rows.map((r) => [r.entry_type, Number(r.amount_cents), r.ledger_scope])).toEqual([
      ['EXPANSION_ALLOCATION', 2_020, 'SIMULATION'],
      ['OPERATIONS_ALLOCATION', 3_030, 'SIMULATION'],
      ['RESERVE_ALLOCATION', 5_051, 'SIMULATION'], // 5050 + 1 centavo de resíduo
      ['REVENUE', 10_101, 'SIMULATION'],
    ]);
    expect((await reconcileFromDatabase(pool)).status).toBe('RECONCILIATION_OK');
  });

  it('não permite pular etapas: confirmar pagamento de oportunidade só SUBMITTED não grava nada', async () => {
    const id = await insertOpportunity('SUBMITTED');
    await expect(confirmPayment(pool, evidence(id))).rejects.toThrow(IllegalPaymentTransitionError);
    expect(await status(id)).toBe('SUBMITTED');
    expect(await count('payment_evidence')).toBe(0);
    expect(await count('financial_ledger')).toBe(0);
  });
});

describe('isolamento SIMULATION x REAL', () => {
  it('pagamento simulado nunca soma no caixa REAL', async () => {
    const id = await pendingOpportunity();
    await confirmPayment(pool, evidence(id));
    expect(await ledgerBalanceCents(pool, 'SIMULATION')).toBe(10_101);
    expect(await ledgerBalanceCents(pool, 'REAL')).toBe(0);
  });

  it('EXTERNAL_VERIFIED é recusado no M5 e não deixa rastro', async () => {
    const id = await pendingOpportunity();
    await expect(confirmPayment(pool, evidence(id, { provenance: 'EXTERNAL_VERIFIED' }))).rejects.toThrow(
      ExternalPaymentNotSupportedError,
    );
    expect(await status(id)).toBe('PAYMENT_PENDING');
    expect(await count('financial_ledger')).toBe(0);
  });
});

describe('idempotência e concorrência (critério 17)', () => {
  it('confirmar a mesma evidência duas vezes lança a receita uma vez só', async () => {
    const id = await pendingOpportunity();
    expect(await confirmPayment(pool, evidence(id))).toBe('CONFIRMED');
    expect(await confirmPayment(pool, evidence(id))).toBe('ALREADY_CONFIRMED');
    expect(await count('payment_evidence')).toBe(1);
    expect(await count('financial_ledger')).toBe(4);
    expect(await ledgerBalanceCents(pool, 'SIMULATION')).toBe(10_101);
  });

  it('cinco confirmações simultâneas da mesma evidência resultam em uma única receita', async () => {
    const id = await pendingOpportunity();
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => confirmPayment(pool, evidence(id))));
    expect(outcomes.filter((o) => o === 'CONFIRMED')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'ALREADY_CONFIRMED')).toHaveLength(4);
    expect(await count('financial_ledger')).toBe(4);
    expect(await ledgerBalanceCents(pool, 'SIMULATION')).toBe(10_101);
  });

  it('duas confirmações simultâneas com chaves DIFERENTES: só uma vira receita, a outra é recusada', async () => {
    const id = await pendingOpportunity();
    const results = await Promise.allSettled([
      confirmPayment(pool, evidence(id, { idempotencyKey: 'payment:a' })),
      confirmPayment(pool, evidence(id, { idempotencyKey: 'payment:b' })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await count('financial_ledger')).toBe(4);
    expect(await ledgerBalanceCents(pool, 'SIMULATION')).toBe(10_101);
  });
});

describe('reconciliação sobre o estado real do banco (critério 18)', () => {
  it('detecta PAID sem receita (oportunidade forçada a PAID por fora do serviço)', async () => {
    const id = await insertOpportunity('PAID');
    const report = await reconcileFromDatabase(pool);
    expect(report.status).toBe('RECONCILIATION_MISMATCH');
    expect(report.issues.map((i) => i.code)).toContain('PAID_WITHOUT_REVENUE');
    expect(report.issues[0]?.opportunityId).toBe(id);
  });

  it('detecta receita duplicada inserida diretamente no ledger — e não conserta nada', async () => {
    const id = await pendingOpportunity();
    await confirmPayment(pool, evidence(id));
    await pool.query(
      `INSERT INTO financial_ledger (entry_type, amount_cents, ledger_scope, description, opportunity_id, external_reference, idempotency_key)
       VALUES ('REVENUE', 500, 'SIMULATION', 'receita duplicada forjada', $1, 'forjada', $2)`,
      [id, `payment:${id}:1:REVENUE:forjada`],
    );
    const before = await count('financial_ledger');
    const report = await reconcileFromDatabase(pool);
    expect(report.status).toBe('RECONCILIATION_MISMATCH');
    expect(report.issues.map((i) => i.code)).toContain('DUPLICATE_REVENUE');
    expect(await count('financial_ledger')).toBe(before);
  });
});
