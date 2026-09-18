import { sha256Hex } from './hash.js';

/**
 * Conteúdo obtido por um Source Connector nunca adquire autoridade sobre
 * Constitution, Governor, prompts, permissões, ferramentas, orçamento ou
 * segredos — é dado, nunca instrução, mesmo com `AI_MODE=mock`. Por ora só
 * existe um nível: tudo que vem de um Source Connector é `UNTRUSTED_EXTERNAL`.
 */
export const TRUST_LEVELS = ['UNTRUSTED_EXTERNAL'] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

/**
 * Saída bruta de um Source Connector, antes do Normalizer separar
 * `raw_external_content` (evidência, preservada) de `normalized_content` (o
 * que o sistema usa). `rawHash` é sempre calculado a partir do conteúdo bruto
 * recebido, mesmo quando `truncated` é `true`.
 */
export interface RawCandidate {
  source: string;
  externalId: string;
  url: string;
  rawContent: string;
  rawHash: string;
  truncated: boolean;
  trustLevel: TrustLevel;
  fetchedAt: string;
  sourceUpdatedAt?: string;
}

export interface MakeRawCandidateInput {
  source: string;
  externalId: string;
  url: string;
  rawContent: string;
  truncated?: boolean;
  fetchedAt?: string;
  sourceUpdatedAt?: string;
}

export function makeRawCandidate(input: MakeRawCandidateInput): RawCandidate {
  return {
    source: input.source,
    externalId: input.externalId,
    url: input.url,
    rawContent: input.rawContent,
    rawHash: sha256Hex(input.rawContent),
    truncated: input.truncated ?? false,
    trustLevel: 'UNTRUSTED_EXTERNAL',
    fetchedAt: input.fetchedAt ?? new Date().toISOString(),
    sourceUpdatedAt: input.sourceUpdatedAt,
  };
}

/**
 * Estados de uma tentativa de descoberta — nunca um `throw` genérico para o
 * que é esperado da operação de uma fonte externa. `429` e mudança de schema
 * têm estado próprio (critérios 16/17 do M4): nunca `FAILED` indiferenciado.
 */
export const SOURCE_DISCOVERY_STATUSES = [
  'OK',
  'SOURCE_RATE_LIMITED',
  'SOURCE_PAYLOAD_TOO_LARGE',
  'SOURCE_SCHEMA_DRIFT',
  'SOURCE_UNAVAILABLE',
] as const;
export type SourceDiscoveryStatus = (typeof SOURCE_DISCOVERY_STATUSES)[number];

export interface SourceDiscoveryResult {
  status: SourceDiscoveryStatus;
  candidates: RawCandidate[];
  /** Presente quando `status === 'SOURCE_RATE_LIMITED'` — respeita `Retry-After` da fonte quando existir. */
  retryAfterMs?: number;
  error?: string;
}

/**
 * Contrato genérico que o Caçador consome — nunca fala com Algora, BountyHub
 * ou qualquer fonte diretamente. Adicionar uma segunda fonte não deve exigir
 * alterar quem chama `discover()`.
 */
export interface SourceConnector {
  readonly source: string;
  discover(): Promise<SourceDiscoveryResult>;
}
