import type { AdapterResult, AiAdapter, AiCompletionRequest } from '../types.js';

/**
 * Determinístico e gratuito — nenhuma "inteligência" real (§19: provar o
 * fluxo, não a inteligência). O `content` é derivado só do tamanho do
 * prompt, nunca de uma chamada externa.
 */
export class MockAdapter implements AiAdapter {
  readonly mode = 'mock' as const;

  async complete(request: AiCompletionRequest): Promise<AdapterResult> {
    const inputTokens = Math.ceil(request.prompt.length / 4);
    const outputTokens = Math.min(request.maxTokens ?? 32, 32);
    return {
      content: `[mock] resposta determinística para prompt de ${request.prompt.length} caracteres`,
      provider: 'mock',
      model: 'mock-1',
      inputTokens,
      outputTokens,
      durationMs: 0,
    };
  }
}
