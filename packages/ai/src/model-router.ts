import { ApiAdapter, type ApiAdapterOptions } from './adapters/api-adapter.js';
import { LocalAdapter, type LocalAdapterOptions } from './adapters/local-adapter.js';
import { MockAdapter } from './adapters/mock-adapter.js';
import type { AiAdapter, AiMode } from './types.js';

export interface ModelRouterOptions {
  mode: AiMode;
  local?: LocalAdapterOptions;
  api?: ApiAdapterOptions;
}

/**
 * Escolhe o adapter deterministicamente por `AI_MODE` — nunca por
 * heurística nem por decisão de um agente. `local`/`api` sem configuração
 * (o padrão desta fase do M3) continuam existindo como objetos reais; é a
 * própria chamada a `complete()` que rejeita com `ModelUnavailableError`
 * antes de tentar rede (packages/ai/src/adapters/*).
 */
export class ModelRouter {
  readonly #adapter: AiAdapter;

  constructor(options: ModelRouterOptions) {
    switch (options.mode) {
      case 'mock':
        this.#adapter = new MockAdapter();
        break;
      case 'local':
        this.#adapter = new LocalAdapter(options.local);
        break;
      case 'api':
        this.#adapter = new ApiAdapter(options.api);
        break;
    }
  }

  get mode(): AiMode {
    return this.#adapter.mode;
  }

  resolve(): AiAdapter {
    return this.#adapter;
  }
}
