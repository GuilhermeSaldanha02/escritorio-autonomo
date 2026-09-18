import type { SourceConnector, SourceDiscoveryResult } from './source-connector.js';

export interface SourcePolicyOptions {
  /** Nunca martela o endpoint indefinidamente — teto explícito de novas tentativas. */
  maxRetries: number;
  /** Usado só quando a fonte não informa Retry-After/x-ratelimit-reset. */
  defaultRetryAfterMs?: number;
  /** Injetável nos testes — nunca espera de verdade em unidade/integração. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Envolve um `SourceConnector` com retry/backoff (M4-PLANO.md, critério 16 —
 * "cada connector tem rate limit, timeout, retry/backoff e tratamento
 * explícito de 429, sem busy-loop"). O connector em si só CONSTATA o estado
 * `SOURCE_RATE_LIMITED`; decidir esperar e tentar de novo é responsabilidade
 * desta camada, separada por propósito — testar a detecção não exige esperar
 * de verdade, e testar o backoff não precisa reimplementar a detecção.
 *
 * Respeita o `retryAfterMs` que a própria fonte informou sempre que existir;
 * só cai no default quando a fonte não deu nenhuma pista. Esgotado
 * `maxRetries`, devolve o último `SOURCE_RATE_LIMITED` tal como veio — nunca
 * insiste além do teto, nunca finge sucesso.
 */
export function withSourcePolicy(connector: SourceConnector, options: SourcePolicyOptions): SourceConnector {
  const sleep = options.sleep ?? realSleep;
  return {
    source: connector.source,
    async discover(): Promise<SourceDiscoveryResult> {
      let attempt = 0;
      for (;;) {
        const result = await connector.discover();
        if (result.status !== 'SOURCE_RATE_LIMITED') return result;
        if (attempt >= options.maxRetries) return result;
        attempt += 1;
        await sleep(result.retryAfterMs ?? options.defaultRetryAfterMs ?? 1_000);
      }
    },
  };
}
