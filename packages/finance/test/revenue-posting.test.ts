import { describe, expect, it } from 'vitest';
import { buildRevenuePosting, type PaymentEvidence } from '../src/revenue-posting.js';

function evidence(overrides: Partial<PaymentEvidence> = {}): PaymentEvidence {
  return {
    opportunityId: 'opp-1',
    provenance: 'SIMULATED',
    amountCents: 10_101,
    currency: 'BRL',
    externalReference: 'sim-ref-1',
    idempotencyKey: 'payment:opp-1:1',
    ...overrides,
  };
}

describe('buildRevenuePosting', () => {
  it('produz REVENUE + os três buckets do split, somando exatamente o valor pago', () => {
    const entries = buildRevenuePosting(evidence());
    const total = entries
      .filter((e) => e.entryType !== 'REVENUE')
      .reduce((sum, e) => sum + e.amountCents, 0);
    expect(total).toBe(10_101);

    const revenue = entries.find((e) => e.entryType === 'REVENUE');
    expect(revenue?.amountCents).toBe(10_101);
  });

  it('evidência SIMULATED nunca produz lançamento de escopo REAL', () => {
    const entries = buildRevenuePosting(evidence({ provenance: 'SIMULATED' }));
    expect(entries.every((e) => e.ledgerScope === 'SIMULATION')).toBe(true);
  });

  it('evidência EXTERNAL_VERIFIED produz lançamentos de escopo REAL', () => {
    const entries = buildRevenuePosting(evidence({ provenance: 'EXTERNAL_VERIFIED' }));
    expect(entries.every((e) => e.ledgerScope === 'REAL')).toBe(true);
  });

  it('cada lançamento carrega uma idempotencyKey própria e determinística', () => {
    const entries = buildRevenuePosting(evidence({ idempotencyKey: 'payment:opp-1:1' }));
    const keys = entries.map((e) => e.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('payment:opp-1:1:REVENUE');
  });

  it('repostar a mesma evidência produz exatamente os mesmos lançamentos (determinismo)', () => {
    const a = buildRevenuePosting(evidence());
    const b = buildRevenuePosting(evidence());
    expect(a).toEqual(b);
  });

  it('propaga opportunityId e externalReference da evidência para todo lançamento', () => {
    const entries = buildRevenuePosting(evidence({ opportunityId: 'opp-42', externalReference: 'ext-42' }));
    expect(entries.every((e) => e.opportunityId === 'opp-42' && e.externalReference === 'ext-42')).toBe(true);
  });
});
