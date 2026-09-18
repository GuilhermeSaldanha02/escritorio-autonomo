import { describe, expect, it } from 'vitest';
import { canPromoteToOpportunityFound } from '../src/promotion-policy.js';

describe('canPromoteToOpportunityFound', () => {
  it('VERIFIED + ALLOWED + ELIGIBLE promove', () => {
    expect(
      canPromoteToOpportunityFound({ rewardStatus: 'VERIFIED', automationPolicyStatus: 'ALLOWED', eligibilityStatus: 'ELIGIBLE' }),
    ).toBe(true);
  });

  it('PARTIALLY_VERIFIED + ALLOWED + ELIGIBLE também promove — incerteza fica visível para o Diretor, não bloqueia', () => {
    expect(
      canPromoteToOpportunityFound({
        rewardStatus: 'PARTIALLY_VERIFIED',
        automationPolicyStatus: 'ALLOWED',
        eligibilityStatus: 'ELIGIBLE',
      }),
    ).toBe(true);
  });

  it.each(['UNVERIFIED', 'CONFLICTING'] as const)('%s nunca promove, mesmo com automação permitida e elegibilidade ok', (rewardStatus) => {
    expect(canPromoteToOpportunityFound({ rewardStatus, automationPolicyStatus: 'ALLOWED', eligibilityStatus: 'ELIGIBLE' })).toBe(false);
  });

  it('automation_policy_status = UNKNOWN nunca equivale a ALLOWED', () => {
    expect(
      canPromoteToOpportunityFound({ rewardStatus: 'VERIFIED', automationPolicyStatus: 'UNKNOWN', eligibilityStatus: 'ELIGIBLE' }),
    ).toBe(false);
  });

  it('eligibility_status = UNKNOWN nunca equivale a ELIGIBLE', () => {
    expect(
      canPromoteToOpportunityFound({ rewardStatus: 'VERIFIED', automationPolicyStatus: 'ALLOWED', eligibilityStatus: 'UNKNOWN' }),
    ).toBe(false);
  });

  it('DISALLOWED e INELIGIBLE bloqueiam explicitamente, não só por omissão', () => {
    expect(
      canPromoteToOpportunityFound({ rewardStatus: 'VERIFIED', automationPolicyStatus: 'DISALLOWED', eligibilityStatus: 'ELIGIBLE' }),
    ).toBe(false);
    expect(
      canPromoteToOpportunityFound({ rewardStatus: 'VERIFIED', automationPolicyStatus: 'ALLOWED', eligibilityStatus: 'INELIGIBLE' }),
    ).toBe(false);
  });
});
