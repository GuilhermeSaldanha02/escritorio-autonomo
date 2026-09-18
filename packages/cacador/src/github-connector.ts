import type { SafeHttpClient } from '@escritorio/http-safe';
import { makeRawCandidate, type RawCandidate, type SourceConnector, type SourceDiscoveryResult } from './source-connector.js';

/**
 * Estratégias de descoberta do GitHubConnector (M4-PLANO.md, decisão
 * intermediária): cada uma é só um SINAL — issue com label de bounty, ou
 * mencionando a convenção `/bounty`, ou referenciando a Algora, não satisfaz
 * `VERIFIED` sozinha. É o Verifier, não o connector, que decide isso.
 */
export const DEFAULT_GITHUB_BOUNTY_QUERIES = [
  'label:bounty is:issue is:open',
  '"/bounty" in:body is:issue is:open',
  'algora.io in:body is:issue is:open',
] as const;

export interface GitHubConnectorOptions {
  httpClient: SafeHttpClient;
  /** Obrigatório: a API do GitHub rejeita requisições sem User-Agent. */
  userAgent: string;
  /** V1 começa sem token (ajuste da revisão externa) — opcional para quando isso mudar. */
  token?: string;
  queries?: readonly string[];
  perPage?: number;
  baseUrl?: string;
}

interface GitHubSearchIssueItem {
  node_id: string;
  html_url: string;
  updated_at?: string;
}

const DEFAULT_BASE_URL = 'https://api.github.com';
const DEFAULT_PER_PAGE = 10;

function isSearchResponseShape(value: unknown): value is { items: GitHubSearchIssueItem[] } {
  if (typeof value !== 'object' || value === null) return false;
  const items = (value as Record<string, unknown>).items;
  if (!Array.isArray(items)) return false;
  return items.every((item) => {
    if (typeof item !== 'object' || item === null) return false;
    const record = item as Record<string, unknown>;
    return typeof record.node_id === 'string' && typeof record.html_url === 'string';
  });
}

function parseRetryAfterMs(headers: Headers): number | undefined {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return seconds * 1000;
  }
  const reset = headers.get('x-ratelimit-reset');
  if (reset) {
    const resetEpochSeconds = Number(reset);
    if (Number.isFinite(resetEpochSeconds)) {
      const deltaMs = resetEpochSeconds * 1000 - Date.now();
      return deltaMs > 0 ? deltaMs : 0;
    }
  }
  return undefined;
}

/**
 * Source Connector real do M4. Consulta `GET /search/issues` do GitHub —
 * pública, documentada, sem chave obrigatória (V1 roda sem token). Cada
 * query configurada roda em sequência (nunca em paralelo — o endpoint de
 * Search do GitHub tem limite de 10/min não autenticado, bem mais restrito
 * que o REST geral); a primeira que não vier `OK` interrompe e o resultado
 * agregado reflete essa falha, em vez de misturar candidatos parciais com
 * um estado de erro silencioso.
 */
export class GitHubConnector implements SourceConnector {
  readonly source = 'github';

  constructor(private readonly options: GitHubConnectorOptions) {}

  async discover(): Promise<SourceDiscoveryResult> {
    const candidates: RawCandidate[] = [];
    for (const query of this.options.queries ?? DEFAULT_GITHUB_BOUNTY_QUERIES) {
      const result = await this.#discoverOne(query);
      if (result.status !== 'OK') return result;
      candidates.push(...result.candidates);
    }
    return { status: 'OK', candidates };
  }

  async #discoverOne(query: string): Promise<SourceDiscoveryResult> {
    const baseUrl = this.options.baseUrl ?? DEFAULT_BASE_URL;
    const perPage = this.options.perPage ?? DEFAULT_PER_PAGE;
    const url = `${baseUrl}/search/issues?q=${encodeURIComponent(query)}&per_page=${perPage}`;

    const headers: Record<string, string> = {
      'User-Agent': this.options.userAgent,
      Accept: 'application/vnd.github+json',
    };
    if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;

    const response = await this.options.httpClient.fetch(url, headers);

    if (response.status === 403 || response.status === 429) {
      return { status: 'SOURCE_RATE_LIMITED', candidates: [], retryAfterMs: parseRetryAfterMs(response.headers) };
    }
    if (response.status !== 200) {
      return { status: 'SOURCE_UNAVAILABLE', candidates: [], error: `GitHub devolveu status ${response.status}` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch (error) {
      return { status: 'SOURCE_SCHEMA_DRIFT', candidates: [], error: `resposta não é JSON válido: ${String(error)}` };
    }
    if (!isSearchResponseShape(parsed)) {
      return { status: 'SOURCE_SCHEMA_DRIFT', candidates: [], error: 'formato inesperado da resposta de busca do GitHub' };
    }

    const candidates = parsed.items.map((item) =>
      makeRawCandidate({
        source: this.source,
        externalId: item.node_id,
        url: item.html_url,
        rawContent: JSON.stringify(item),
        sourceUpdatedAt: item.updated_at,
      }),
    );
    return { status: 'OK', candidates };
  }
}
