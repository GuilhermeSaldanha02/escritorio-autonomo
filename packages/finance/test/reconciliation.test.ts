import { describe, expect, it } from 'vitest';
import { buildRevenuePosting, type PaymentEvidence } from '../src/revenue-posting.js';
import { reconcile, type PaidOpportunity } from '../src/reconciliation.js';

function evidence(overrides: Partial<PaymentEvidence> = {}): PaymentEvidence {
  return {
    opportunityId: 'opp-1',
    provenance: 'SIMULATED',
    amountCents: 10_000,
    currency: 'BRL',
    externalReference: 'sim-ref-1',
    idempotencyKey: 'payment:opp-1:1',
    ...overrides,
  };
}

function paidOpportunity(overrides: Partial<PaidOpportunity> = {}): PaidOpportunity {
  return { id: 'opp-1', status: 'PAID', ...overrides };
}

describe('reconcile', () => {
  it('cenário saudável: PAID com REVENUE + split completo e correto é RECONCILIATION_OK', () => {
    const paymentEvidence = evidence();
    const ledgerEntries = buildRevenuePosting(paymentEvidence);
    const report = reconcile([paidOpportunity()], [paymentEvidence], ledgerEntries);
    expect(report).toEqual({ status: 'RECONCILIATION_OK', issues: [] });
  });

  it('opportunity não-PAID nunca é verificada quanto a REVENUE', () => {
    const report = reconcile([paidOpportunity({ status: 'SUBMITTED' })], [], []);
    expect(report.status).toBe('RECONCILIATION_OK');
  });

  it('detecta PAID_WITHOUT_REVENUE', () => {
    const report = reconcile([paidOpportunity()], [], []);
    expect(report.status).toBe('RECONCILIATION_MISMATCH');
    expect(report.issues).toEqual([
      { code: 'PAID_WITHOUT_REVENUE', opportunityId: 'opp-1', detail: expect.any(String) },
    ]);
  });

  it('detecta DUPLICATE_REVENUE', () => {
    const paymentEvidence = evidence();
    const entries = buildRevenuePosting(paymentEvidence);
    const revenue = entries.find((e) => e.entryType === 'REVENUE')!;
    const duplicated = [...entries, { ...revenue, idempotencyKey: `${revenue.idempotencyKey}:dup` }];
    const report = reconcile([paidOpportunity()], [paymentEvidence], duplicated);
    expect(report.issues.some((i) => i.code === 'DUPLICATE_REVENUE')).toBe(true);
  });

  it('detecta SPLIT_MISSING quando falta um bucket', () => {
    const paymentEvidence = evidence();
    const entries = buildRevenuePosting(paymentEvidence).filter((e) => e.entryType !== 'EXPANSION_ALLOCATION');
    const report = reconcile([paidOpportunity()], [paymentEvidence], entries);
    expect(report.issues).toEqual([
      { code: 'SPLIT_MISSING', opportunityId: 'opp-1', detail: expect.stringContaining('EXPANSION_ALLOCATION') },
    ]);
  });

  it('detecta SPLIT_DUPLICATED quando um bucket aparece duas vezes', () => {
    const paymentEvidence = evidence();
    const entries = buildRevenuePosting(paymentEvidence);
    const reserve = entries.find((e) => e.entryType === 'RESERVE_ALLOCATION')!;
    const duplicated = [...entries, { ...reserve, idempotencyKey: `${reserve.idempotencyKey}:dup` }];
    const report = reconcile([paidOpportunity()], [paymentEvidence], duplicated);
    expect(report.issues.some((i) => i.code === 'SPLIT_DUPLICATED')).toBe(true);
  });

  it('detecta SPLIT_MISMATCH quando a soma do split não bate com REVENUE', () => {
    const paymentEvidence = evidence();
    const entries = buildRevenuePosting(paymentEvidence).map((e) =>
      e.entryType === 'RESERVE_ALLOCATION' ? { ...e, amountCents: e.amountCents + 1 } : e,
    );
    const report = reconcile([paidOpportunity()], [paymentEvidence], entries);
    expect(report.issues).toEqual([
      { code: 'SPLIT_MISMATCH', opportunityId: 'opp-1', detail: expect.any(String) },
    ]);
  });

  it('detecta ORPHAN_LEDGER_ENTRY para opportunity inexistente', () => {
    const paymentEvidence = evidence();
    const entries = buildRevenuePosting(paymentEvidence);
    const report = reconcile([], [paymentEvidence], entries);
    expect(report.issues.some((i) => i.code === 'ORPHAN_LEDGER_ENTRY')).toBe(true);
  });

  it('detecta ORPHAN_LEDGER_ENTRY para lançamento sem PaymentEvidence de origem', () => {
    const paymentEvidence = evidence();
    const entries = buildRevenuePosting(paymentEvidence);
    const report = reconcile([paidOpportunity()], [], entries);
    expect(report.issues.some((i) => i.code === 'ORPHAN_LEDGER_ENTRY')).toBe(true);
  });

  it('não marca como órfão lançamento sem opportunityId (ex.: FOUNDER_SUBSIDY)', () => {
    const entries = [
      {
        entryType: 'FOUNDER_SUBSIDY' as const,
        amountCents: 500,
        ledgerScope: 'SIMULATION' as const,
        opportunityId: null as unknown as string,
        externalReference: null as unknown as string,
        idempotencyKey: 'subsidy:1',
      },
    ];
    const report = reconcile([], [], entries);
    expect(report.status).toBe('RECONCILIATION_OK');
  });

  it('detecta DUPLICATE_PAYMENT_CONFIRMATION para a mesma referência externa', () => {
    const first = evidence({ idempotencyKey: 'payment:opp-1:1' });
    const second = evidence({ idempotencyKey: 'payment:opp-1:2' });
    const report = reconcile([paidOpportunity()], [first, second], []);
    expect(report.issues.some((i) => i.code === 'DUPLICATE_PAYMENT_CONFIRMATION')).toBe(true);
  });

  it('nunca muta os dados recebidos (só detecta, não conserta)', () => {
    const paymentEvidence = evidence();
    const entries = buildRevenuePosting(paymentEvidence);
    const entriesCopy = JSON.parse(JSON.stringify(entries));
    reconcile([paidOpportunity()], [paymentEvidence], entries);
    expect(entries).toEqual(entriesCopy);
  });
});
