/**
 * "Verdade rica" do M4 sobre uma recompensa — nunca um booleano. `VERIFIED`
 * nunca é apresentado como garantia de pagamento (M4-PLANO.md).
 */
export const REWARD_STATUSES = ['VERIFIED', 'PARTIALLY_VERIFIED', 'UNVERIFIED', 'CONFLICTING'] as const;
export type RewardStatus = (typeof REWARD_STATUSES)[number];

/**
 * Deriva o campo legado `reward_verified` (M1-M3) a partir do `reward_status`
 * (M4) — única função de derivação, decisão registrada com a revisão externa
 * para nunca espalhar `rewardStatus === 'VERIFIED'` pelo código. Só o Caçador
 * (persistência de oportunidades descobertas via M4) chama isto; caminhos
 * legados (ex.: apps/api/src/routes/simulations.ts) continuam escrevendo
 * reward_verified diretamente e nunca tocam reward_status.
 *
 * Direção única, de propósito: reward_verified=false não contém informação
 * suficiente para saber se o status real é PARTIALLY_VERIFIED, UNVERIFIED ou
 * CONFLICTING — nunca inferir o inverso.
 */
export function toLegacyRewardVerified(rewardStatus: RewardStatus): boolean {
  return rewardStatus === 'VERIFIED';
}
