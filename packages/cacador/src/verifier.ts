import type { RewardStatus } from './reward-status.js';

/**
 * Checagens determinísticas para `VERIFIED` (M4-PLANO.md — "não é detector de
 * golpe"): dá para verificar evidência e risco, não provar que alguém vai
 * pagar. Cada campo é um fato que o Verifier recebe já apurado (pela
 * evidência normalizada do connector/enricher) — este módulo só decide, não
 * coleta evidência.
 */
export interface RewardVerificationChecks {
  /** A bounty existe na fonte oficial permitida (ex.: Algora), não só citada em texto livre. */
  bountyExistsAtSource: boolean;
  externalIdValid: boolean;
  rewardAmountPositive: boolean;
  currencyRecognized: boolean;
  targetExists: boolean;
  /** `true` quando a fonte não exige "aberta", ou quando exige e está aberta. */
  targetOpenIfRequired: boolean;
  /** URL/ID da fonte e do alvo (ex.: issue) apontam para a mesma coisa. */
  identifiersConsistent: boolean;
  notExpired: boolean;
  paymentConditionsFound: boolean;
  /** `true` só quando a elegibilidade foi checada e é explicitamente compatível — nunca por omissão. */
  eligibilityKnownCompatible: boolean;
  /** Evidências de fontes diferentes se contradizem (ex.: uma diz aberta, outra diz fechada). */
  hasConflictingEvidence: boolean;
}

const HARD_CRITERIA: ReadonlyArray<keyof RewardVerificationChecks> = [
  'bountyExistsAtSource',
  'externalIdValid',
  'rewardAmountPositive',
  'currencyRecognized',
  'targetExists',
  'targetOpenIfRequired',
  'identifiersConsistent',
  'notExpired',
];

const SOFT_CRITERIA: ReadonlyArray<keyof RewardVerificationChecks> = ['paymentConditionsFound', 'eligibilityKnownCompatible'];

/**
 * Decide `reward_status` a partir das checagens. Conflito declarado tem
 * prioridade sobre tudo — evidência que se contradiz nunca vira `VERIFIED`
 * só porque os outros critérios passaram. Falha num critério "duro" (a
 * oportunidade existe? não expirou? moeda reconhecida?) é `UNVERIFIED`, não
 * `CONFLICTING` — é ausência de confirmação, não contradição. Falha só num
 * critério "leve" (condições de pagamento, elegibilidade) é
 * `PARTIALLY_VERIFIED`: o suficiente para o Diretor decidir com a incerteza
 * visível, não para tratar como comprovado.
 */
export function verifyReward(checks: RewardVerificationChecks): RewardStatus {
  if (checks.hasConflictingEvidence) return 'CONFLICTING';
  if (HARD_CRITERIA.some((key) => !checks[key])) return 'UNVERIFIED';
  if (SOFT_CRITERIA.some((key) => !checks[key])) return 'PARTIALLY_VERIFIED';
  return 'VERIFIED';
}
