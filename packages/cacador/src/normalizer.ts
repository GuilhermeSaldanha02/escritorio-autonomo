import type { RawCandidate, TrustLevel } from './source-connector.js';

const DEFAULT_MAX_RAW_CONTENT_BYTES = 256 * 1024; // 256 KiB
const DEFAULT_MAX_NORMALIZED_CONTENT_BYTES = 64 * 1024; // 64 KiB

export interface NormalizerOptions {
  maxRawContentBytes?: number;
  maxNormalizedContentBytes?: number;
}

export type NormalizationStatus = 'OK' | 'SOURCE_PAYLOAD_TOO_LARGE';

/**
 * Candidato depois do Normalizer: `rawExternalContent` é evidência (preservada
 * para auditoria, nunca usada diretamente pelo resto do pipeline);
 * `normalizedContent` é o que o Verifier e o restante do sistema de fato leem.
 * Nunca um único campo "texto limpo" — separar os dois é o que impede que uma
 * tentativa de prompt-injection no bruto vaze para onde teria mais chance de
 * ser tratada como instrução.
 */
export interface NormalizedCandidate {
  status: NormalizationStatus;
  source: string;
  externalId: string;
  url: string;
  rawExternalContent: string;
  normalizedContent: string;
  rawHash: string;
  trustLevel: TrustLevel;
  fetchedAt: string;
  sourceUpdatedAt?: string;
}

/**
 * Remove caracteres de controle (exceto quebras de linha/tab) — conteúdo
 * externo não confiável não deveria carregar bytes de controle arbitrários
 * para dentro do que o sistema trata como texto.
 */
function stripControlCharacters(text: string): string {
  // eslint-disable-next-line no-control-regex -- remoção deliberada de bytes de controle de conteúdo não confiável
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function truncateToByteLimit(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= maxBytes) return text;
  return buffer.subarray(0, maxBytes).toString('utf8');
}

/**
 * Normaliza um `RawCandidate` em `NormalizedCandidate`. Nunca lança para um
 * payload grande — devolve `status: 'SOURCE_PAYLOAD_TOO_LARGE'` com o
 * conteúdo bruto cortado no limite (nunca None: `rawHash` já veio calculado
 * do `RawCandidate` a partir do conteúdo completo, então a auditoria não
 * perde o rastro mesmo quando o corpo persistido é truncado).
 */
export function normalizeCandidate(candidate: RawCandidate, options: NormalizerOptions = {}): NormalizedCandidate {
  const maxRawContentBytes = options.maxRawContentBytes ?? DEFAULT_MAX_RAW_CONTENT_BYTES;
  const maxNormalizedContentBytes = options.maxNormalizedContentBytes ?? DEFAULT_MAX_NORMALIZED_CONTENT_BYTES;

  const rawTooLarge = byteLength(candidate.rawContent) > maxRawContentBytes;
  const rawExternalContent = rawTooLarge ? truncateToByteLimit(candidate.rawContent, maxRawContentBytes) : candidate.rawContent;

  const cleaned = stripControlCharacters(rawExternalContent).trim();
  const normalizedTooLarge = byteLength(cleaned) > maxNormalizedContentBytes;
  const normalizedContent = normalizedTooLarge ? truncateToByteLimit(cleaned, maxNormalizedContentBytes) : cleaned;

  return {
    status: rawTooLarge || candidate.truncated || normalizedTooLarge ? 'SOURCE_PAYLOAD_TOO_LARGE' : 'OK',
    source: candidate.source,
    externalId: candidate.externalId,
    url: candidate.url,
    rawExternalContent,
    normalizedContent,
    rawHash: candidate.rawHash,
    trustLevel: candidate.trustLevel,
    fetchedAt: candidate.fetchedAt,
    sourceUpdatedAt: candidate.sourceUpdatedAt,
  };
}
