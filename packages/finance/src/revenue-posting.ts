import { computeSplit } from './split-policy.js';

export const PAYMENT_PROVENANCES = ['SIMULATED', 'EXTERNAL_VERIFIED'] as const;
export type PaymentProvenance = (typeof PAYMENT_PROVENANCES)[number];

export const LEDGER_SCOPES = ['SIMULATION', 'REAL'] as const;
export type LedgerScope = (typeof LEDGER_SCOPES)[number];

export const LEDGER_ENTRY_TYPES = [
  'REVENUE',
  'OPERATING_COST',
  'FOUNDER_SUBSIDY',
  'RESERVE_ALLOCATION',
  'OPERATIONS_ALLOCATION',
  'EXPANSION_ALLOCATION',
] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

export interface PaymentEvidence {
  opportunityId: string;
  provenance: PaymentProvenance;
  amountCents: number;
  currency: string;
  externalReference: string;
  idempotencyKey: string;
}

export interface LedgerEntry {
  entryType: LedgerEntryType;
  amountCents: number;
  ledgerScope: LedgerScope;
  opportunityId: string;
  externalReference: string;
  idempotencyKey: string;
}

/**
 * `SIMULATED PaymentEvidence → lançamentos de escopo SIMULATION` /
 * `EXTERNAL_VERIFIED PaymentEvidence → lançamentos de escopo REAL`
 * (M5-PLANO.md, ajuste 2 da revisão externa) — o isolamento nasce aqui, não
 * é uma flag adicionada depois: não existe caminho para produzir um
 * lançamento `REAL` a partir de uma evidência `SIMULATED`.
 */
function scopeForProvenance(provenance: PaymentProvenance): LedgerScope {
  return provenance === 'SIMULATED' ? 'SIMULATION' : 'REAL';
}

/**
 * Traduz um `PaymentEvidence` confirmado em lançamentos de `financial_ledger`
 * — REVENUE pelo valor cheio, mais os três buckets do split 50/30/20
 * (`computeSplit`), todos no mesmo `ledgerScope`. Função pura: não escreve
 * no banco, apenas decide o que deveria ser escrito. A idempotência de
 * cada lançamento é derivada de `evidence.idempotencyKey` + sufixo por tipo,
 * para a camada de persistência poder fazer INSERT ... ON CONFLICT DO NOTHING
 * sem depender de lógica adicional aqui.
 */
export function buildRevenuePosting(evidence: PaymentEvidence): LedgerEntry[] {
  const ledgerScope = scopeForProvenance(evidence.provenance);
  const split = computeSplit(evidence.amountCents);

  const entry = (entryType: LedgerEntryType, amountCents: number): LedgerEntry => ({
    entryType,
    amountCents,
    ledgerScope,
    opportunityId: evidence.opportunityId,
    externalReference: evidence.externalReference,
    idempotencyKey: `${evidence.idempotencyKey}:${entryType}`,
  });

  return [
    entry('REVENUE', evidence.amountCents),
    entry('RESERVE_ALLOCATION', split.reserveCents),
    entry('OPERATIONS_ALLOCATION', split.operationsCents),
    entry('EXPANSION_ALLOCATION', split.expansionCents),
  ];
}
