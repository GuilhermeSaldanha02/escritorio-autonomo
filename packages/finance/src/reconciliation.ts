import type { LedgerEntry, PaymentEvidence } from './revenue-posting.js';

export const RECONCILIATION_STATUSES = ['RECONCILIATION_OK', 'RECONCILIATION_MISMATCH'] as const;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

export const RECONCILIATION_ISSUE_CODES = [
  'PAID_WITHOUT_REVENUE',
  'DUPLICATE_REVENUE',
  'SPLIT_MISSING',
  'SPLIT_DUPLICATED',
  'SPLIT_MISMATCH',
  'ORPHAN_LEDGER_ENTRY',
  'DUPLICATE_PAYMENT_CONFIRMATION',
] as const;
export type ReconciliationIssueCode = (typeof RECONCILIATION_ISSUE_CODES)[number];

export interface ReconciliationIssue {
  code: ReconciliationIssueCode;
  opportunityId: string | null;
  detail: string;
}

export interface ReconciliationReport {
  status: ReconciliationStatus;
  issues: readonly ReconciliationIssue[];
}

export interface PaidOpportunity {
  id: string;
  status: string;
}

const SPLIT_TYPES = ['RESERVE_ALLOCATION', 'OPERATIONS_ALLOCATION', 'EXPANSION_ALLOCATION'] as const;

/**
 * M5-PLANO.md — "reconciliação detecta, não conserta sozinha". Esta função
 * nunca escreve, nunca repara: produz evidência (`ReconciliationIssue[]`)
 * para uma decisão posterior, humana ou de um milestone futuro. Lógica pura
 * — quem busca opportunities/paymentEvidences/ledgerEntries no banco é a
 * camada de persistência.
 */
export function reconcile(
  opportunities: readonly PaidOpportunity[],
  paymentEvidences: readonly PaymentEvidence[],
  ledgerEntries: readonly LedgerEntry[],
): ReconciliationReport {
  const issues: ReconciliationIssue[] = [];
  const knownOpportunityIds = new Set(opportunities.map((o) => o.id));
  const evidenceIdempotencyKeys = paymentEvidences.map((e) => e.idempotencyKey);

  for (const entry of ledgerEntries) {
    if (entry.opportunityId && !knownOpportunityIds.has(entry.opportunityId)) {
      issues.push({
        code: 'ORPHAN_LEDGER_ENTRY',
        opportunityId: entry.opportunityId,
        detail: `Lançamento "${entry.idempotencyKey}" referencia opportunity "${entry.opportunityId}", que não existe`,
      });
      continue;
    }
    if (['REVENUE', ...SPLIT_TYPES].includes(entry.entryType)) {
      const hasOriginatingEvidence = evidenceIdempotencyKeys.some((key) => entry.idempotencyKey.startsWith(`${key}:`));
      if (!hasOriginatingEvidence) {
        issues.push({
          code: 'ORPHAN_LEDGER_ENTRY',
          opportunityId: entry.opportunityId,
          detail: `Lançamento "${entry.idempotencyKey}" (${entry.entryType}) não tem PaymentEvidence de origem`,
        });
      }
    }
  }

  for (const opportunity of opportunities) {
    if (opportunity.status !== 'PAID') continue;

    const entries = ledgerEntries.filter((e) => e.opportunityId === opportunity.id);
    const revenueEntries = entries.filter((e) => e.entryType === 'REVENUE');

    if (revenueEntries.length === 0) {
      issues.push({
        code: 'PAID_WITHOUT_REVENUE',
        opportunityId: opportunity.id,
        detail: `Opportunity "${opportunity.id}" está PAID mas não tem lançamento REVENUE`,
      });
      continue;
    }
    if (revenueEntries.length > 1) {
      issues.push({
        code: 'DUPLICATE_REVENUE',
        opportunityId: opportunity.id,
        detail: `Opportunity "${opportunity.id}" tem ${revenueEntries.length} lançamentos REVENUE`,
      });
      continue;
    }

    const revenue = revenueEntries[0]!;
    const splitByType = SPLIT_TYPES.map((type) => entries.filter((e) => e.entryType === type));

    const missing = SPLIT_TYPES.filter((_, i) => splitByType[i]!.length === 0);
    if (missing.length > 0) {
      issues.push({
        code: 'SPLIT_MISSING',
        opportunityId: opportunity.id,
        detail: `Opportunity "${opportunity.id}" tem REVENUE mas falta split: ${missing.join(', ')}`,
      });
      continue;
    }

    const duplicated = SPLIT_TYPES.filter((_, i) => splitByType[i]!.length > 1);
    if (duplicated.length > 0) {
      issues.push({
        code: 'SPLIT_DUPLICATED',
        opportunityId: opportunity.id,
        detail: `Opportunity "${opportunity.id}" tem split duplicado: ${duplicated.join(', ')}`,
      });
      continue;
    }

    const splitTotal = splitByType.reduce((sum, group) => sum + group[0]!.amountCents, 0);
    if (splitTotal !== revenue.amountCents) {
      issues.push({
        code: 'SPLIT_MISMATCH',
        opportunityId: opportunity.id,
        detail: `Opportunity "${opportunity.id}": split soma ${splitTotal} centavos, REVENUE é ${revenue.amountCents}`,
      });
    }
  }

  const byOpportunityAndReference = new Map<string, PaymentEvidence[]>();
  for (const evidence of paymentEvidences) {
    const key = `${evidence.opportunityId}:${evidence.externalReference}`;
    const group = byOpportunityAndReference.get(key) ?? [];
    group.push(evidence);
    byOpportunityAndReference.set(key, group);
  }
  for (const group of byOpportunityAndReference.values()) {
    if (group.length > 1) {
      issues.push({
        code: 'DUPLICATE_PAYMENT_CONFIRMATION',
        opportunityId: group[0]!.opportunityId,
        detail: `${group.length} confirmações de pagamento para a mesma referência externa "${group[0]!.externalReference}"`,
      });
    }
  }

  return {
    status: issues.length === 0 ? 'RECONCILIATION_OK' : 'RECONCILIATION_MISMATCH',
    issues,
  };
}
