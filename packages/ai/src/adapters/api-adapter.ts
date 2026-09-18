import type { AdapterResult, AiAdapter, AiCompletionRequest } from '../types.js';
import { ModelUnavailableError } from '../types.js';

export interface ApiAdapterOptions {
  /** Endpoint compatível com Chat Completions (`POST {baseUrl}/v1/chat/completions`). */
  baseUrl?: string;
  /** Nunca uma chave real neste milestone — sem isso, o adapter é NOT_CONFIGURED. */
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

interface ChatCompletionsResponse {
  choices: Array<{ message: { content: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Adapter real de contrato para uma API de IA paga (formato OpenAI Chat
 * Completions). Testado contra um servidor fake — sem `apiKey`/`baseUrl`
 * (o caso de produção nesta fase do M3), lança `ModelUnavailableError` antes
 * de qualquer chamada de rede: nenhuma chave real é usada, nenhum gasto
 * acontece. Ativar isso de verdade exige autorização explícita de gasto do
 * dono (Governor `SPEND`, `AUTO_SPEND`), não é decisão deste milestone.
 */
export class ApiAdapter implements AiAdapter {
  readonly mode = 'api' as const;
  readonly #baseUrl: string | undefined;
  readonly #apiKey: string | undefined;
  readonly #model: string;
  readonly #timeoutMs: number;

  constructor(options: ApiAdapterOptions = {}) {
    this.#baseUrl = options.baseUrl;
    this.#apiKey = options.apiKey;
    this.#model = options.model ?? 'api-model';
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async complete(request: AiCompletionRequest): Promise<AdapterResult> {
    if (!this.#baseUrl || !this.#apiKey) {
      throw new ModelUnavailableError('api', 'NOT_CONFIGURED — nenhuma baseUrl/apiKey de provedor pago configurada');
    }
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await fetch(`${this.#baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#apiKey}` },
        body: JSON.stringify({
          model: this.#model,
          messages: [{ role: 'user', content: request.prompt }],
          max_tokens: request.maxTokens,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ModelUnavailableError('api', `servidor respondeu ${response.status}`);
      }
      const body = (await response.json()) as ChatCompletionsResponse;
      const content = body.choices[0]?.message.content;
      if (content === undefined) {
        throw new ModelUnavailableError('api', 'resposta sem choices[0].message.content');
      }
      return {
        content,
        provider: 'api',
        model: this.#model,
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (error instanceof ModelUnavailableError) throw error;
      const reason = error instanceof Error && error.name === 'AbortError' ? 'timeout' : String(error);
      throw new ModelUnavailableError('api', reason);
    } finally {
      clearTimeout(timeout);
    }
  }
}
