import type { AdapterResult, AiAdapter, AiCompletionRequest } from '../types.js';
import { ModelUnavailableError } from '../types.js';

export interface LocalAdapterOptions {
  /** Endpoint compatível com Ollama (`POST {baseUrl}/api/generate`). Sem isso, o adapter é NOT_CONFIGURED. */
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

interface OllamaCompatibleResponse {
  response: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Adapter real de contrato para um LLM local (ex.: Ollama). Testado contra
 * um servidor fake nos testes de integração — sem `baseUrl` configurada
 * (o caso de produção nesta fase do M3), lança `ModelUnavailableError` antes
 * de qualquer tentativa de rede. Decisão da revisão externa: não ligar um
 * LLM local de verdade neste milestone (RAM da máquina de desenvolvimento).
 */
export class LocalAdapter implements AiAdapter {
  readonly mode = 'local' as const;
  readonly #baseUrl: string | undefined;
  readonly #model: string;
  readonly #timeoutMs: number;

  constructor(options: LocalAdapterOptions = {}) {
    this.#baseUrl = options.baseUrl;
    this.#model = options.model ?? 'local-model';
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async complete(request: AiCompletionRequest): Promise<AdapterResult> {
    if (!this.#baseUrl) {
      throw new ModelUnavailableError('local', 'NOT_CONFIGURED — nenhuma baseUrl de LLM local configurada');
    }
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await fetch(`${this.#baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.#model, prompt: request.prompt, stream: false }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ModelUnavailableError('local', `servidor respondeu ${response.status}`);
      }
      const body = (await response.json()) as OllamaCompatibleResponse;
      return {
        content: body.response,
        provider: 'local',
        model: this.#model,
        inputTokens: body.prompt_eval_count ?? 0,
        outputTokens: body.eval_count ?? 0,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (error instanceof ModelUnavailableError) throw error;
      const reason = error instanceof Error && error.name === 'AbortError' ? 'timeout' : String(error);
      throw new ModelUnavailableError('local', reason);
    } finally {
      clearTimeout(timeout);
    }
  }
}
