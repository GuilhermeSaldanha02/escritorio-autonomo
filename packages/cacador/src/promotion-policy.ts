import type { RewardStatus } from './reward-status.js';

export const ELIGIBILITY_STATUSES = ['ELIGIBLE', 'INELIGIBLE', 'UNKNOWN'] as const;
export type EligibilityStatus = (typeof ELIGIBILITY_STATUSES)[number];

export const AUTOMATION_POLICY_STATUSES = ['ALLOWED', 'DISALLOWED', 'UNKNOWN'] as const;
export type AutomationPolicyStatus = (typeof AUTOMATION_POLICY_STATUSES)[number];

export interface PromotionInput {
  rewardStatus: RewardStatus;
  eligibilityStatus: EligibilityStatus;
  automationPolicyStatus: AutomationPolicyStatus;
}

/**
 * Decide o que pode virar `OPPORTUNITY_FOUND` (M4-PLANO.md, ajuste 1 da
 * revisão externa). Regra central: ausência de informação nunca é
 * interpretada como permissão — `UNKNOWN` nunca equivale a `ALLOWED`/
 * `ELIGIBLE`, então esta função exige o valor explícito, nunca "diferente de
 * DISALLOWED/INELIGIBLE".
 *
 * `VERIFIED` e `PARTIALLY_VERIFIED` podem promover (o Diretor recebe as
 * incertezas de `PARTIALLY_VERIFIED` visíveis, não escondidas — a decisão de
 * agir com informação incompleta é dele, não deste código). `UNVERIFIED` e
 * `CONFLICTING` persistem mas nunca promovem — ficam disponíveis para
 * reavaliação futura, não para execução automática.
 */
export function canPromoteToOpportunityFound(input: PromotionInput): boolean {
  if (input.rewardStatus !== 'VERIFIED' && input.rewardStatus !== 'PARTIALLY_VERIFIED') return false;
  if (input.automationPolicyStatus !== 'ALLOWED') return false;
  if (input.eligibilityStatus !== 'ELIGIBLE') return false;
  return true;
}
