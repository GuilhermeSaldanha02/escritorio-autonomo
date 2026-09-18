import { describe, expect, it } from 'vitest';
import { type RewardVerificationChecks, verifyReward } from '../src/verifier.js';

const ALL_PASS: RewardVerificationChecks = {
  bountyExistsAtSource: true,
  externalIdValid: true,
  rewardAmountPositive: true,
  currencyRecognized: true,
  targetExists: true,
  targetOpenIfRequired: true,
  identifiersConsistent: true,
  notExpired: true,
  paymentConditionsFound: true,
  eligibilityKnownCompatible: true,
  hasConflictingEvidence: false,
};

const HARD_CRITERIA: Array<keyof RewardVerificationChecks> = [
  'bountyExistsAtSource',
  'externalIdValid',
  'rewardAmountPositive',
  'currencyRecognized',
  'targetExists',
  'targetOpenIfRequired',
  'identifiersConsistent',
  'notExpired',
];

const SOFT_CRITERIA: Array<keyof RewardVerificationChecks> = ['paymentConditionsFound', 'eligibilityKnownCompatible'];

describe('verifyReward', () => {
  it('todos os critérios passando dá VERIFIED', () => {
    expect(verifyReward(ALL_PASS)).toBe('VERIFIED');
  });

  it.each(HARD_CRITERIA)('falha no critério duro %s dá UNVERIFIED, nunca VERIFIED por omissão', (key) => {
    expect(verifyReward({ ...ALL_PASS, [key]: false })).toBe('UNVERIFIED');
  });

  it.each(SOFT_CRITERIA)('falha só no critério leve %s dá PARTIALLY_VERIFIED, não UNVERIFIED nem VERIFIED', (key) => {
    expect(verifyReward({ ...ALL_PASS, [key]: false })).toBe('PARTIALLY_VERIFIED');
  });

  it('evidência conflitante vence qualquer outra checagem — nunca VERIFIED com contradição', () => {
    expect(verifyReward({ ...ALL_PASS, hasConflictingEvidence: true })).toBe('CONFLICTING');
  });

  it('conflito tem prioridade mesmo com critérios duros também falhando', () => {
    expect(verifyReward({ ...ALL_PASS, hasConflictingEvidence: true, targetExists: false })).toBe('CONFLICTING');
  });
});
