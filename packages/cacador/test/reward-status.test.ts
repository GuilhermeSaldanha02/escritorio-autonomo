import { describe, expect, it } from 'vitest';
import { toLegacyRewardVerified } from '../src/reward-status.js';

describe('toLegacyRewardVerified', () => {
  it('só VERIFIED vira reward_verified=true', () => {
    expect(toLegacyRewardVerified('VERIFIED')).toBe(true);
  });

  it.each(['PARTIALLY_VERIFIED', 'UNVERIFIED', 'CONFLICTING'] as const)(
    '%s vira reward_verified=false — ausência de certeza nunca é permissão',
    (status) => {
      expect(toLegacyRewardVerified(status)).toBe(false);
    },
  );
});
