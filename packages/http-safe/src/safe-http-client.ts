import { lookup as dnsLookup } from 'node:dns/promises';
import { ResponseTooLargeError, SsrfBlockedError, TooManyRedirectsError } from './errors.js';
import { isPrivateOrLoopbackAddress } from './private-network.js';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export interface SafeHttpClientOptions {
  /**
   * Só para testes contra um servidor fake em localhost. Nunca `true` em
   * produção (GitHub, ou qualquer fonte real) — desliga o bloqueio de
   * endereço privado/loopback que existe justamente para isso.
   */
  allowPrivateNetworks?: boolean;
  maxRedirects?: number;
  maxResponseBytes?: number;
  timeoutMs?: number;
}

export interface SafeHttpResponse {
  status: number;
  headers: Headers;
  body: string;
}

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MiB
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Cliente HTTP com proteção contra SSRF (M4, Source Connectors) — camada
 * compartilhada por todo `SourceConnector`, nunca embutida num connector
 * específico (decisão da revisão externa). Valida protocolo e resolve DNS
 * antes de conectar, e revalida CADA hop de redirect — uma URL pública que
 * redireciona para `127.0.0.1` é bloqueada no redirect, não só na URL inicial.
 *
 * Limitação conhecida, não escondida: a validação de DNS acontece antes da
 * conexão real; entre a checagem e o `fetch` de fato, o `fetch` nativo
 * resolve o DNS de novo por conta própria — uma janela residual de DNS
 * rebinding não é fechada por este design (fechar isso exigiria pinar a
 * conexão no IP validado via um Agent/dispatcher customizado, fora do
 * escopo do M4). O que este cliente garante: nenhuma URL cujo DNS resolve
 * para um endereço privado/loopback/link-local no momento da checagem passa,
 * em nenhum hop da cadeia de redirects.
 */
export class SafeHttpClient {
  constructor(private readonly options: SafeHttpClientOptions = {}) {}

  async fetch(url: string, requestHeaders?: Record<string, string>): Promise<SafeHttpResponse> {
    const maxRedirects = this.options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    let currentUrl = url;
    for (let redirectCount = 0; ; redirectCount++) {
      await this.#validateTarget(currentUrl);
      const response = await this.#fetchOnce(currentUrl, requestHeaders);

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return this.#readBody(response, currentUrl);
        if (redirectCount >= maxRedirects) throw new TooManyRedirectsError(url);
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      return this.#readBody(response, currentUrl);
    }
  }

  async #validateTarget(target: string): Promise<void> {
    const parsed = new URL(target);
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
      throw new SsrfBlockedError(target, `protocolo não permitido: ${parsed.protocol}`);
    }
    if (this.options.allowPrivateNetworks) return;

    const addresses = await dnsLookup(parsed.hostname, { all: true }).catch((error: unknown) => {
      throw new SsrfBlockedError(target, `falha ao resolver DNS: ${String(error)}`);
    });
    for (const { address } of addresses) {
      if (isPrivateOrLoopbackAddress(address)) {
        throw new SsrfBlockedError(target, `host resolve para endereço privado/loopback: ${address}`);
      }
    }
  }

  async #fetchOnce(url: string, requestHeaders?: Record<string, string>): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      return await fetch(url, { redirect: 'manual', signal: controller.signal, headers: requestHeaders });
    } finally {
      clearTimeout(timeout);
    }
  }

  async #readBody(response: Response, url: string): Promise<SafeHttpResponse> {
    const maxBytes = this.options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    const reader = response.body?.getReader();
    if (!reader) return { status: response.status, headers: response.headers, body: '' };

    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLargeError(url, maxBytes);
      }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
    return { status: response.status, headers: response.headers, body };
  }
}
