/**
 * Contratos do AI Gateway (M3). `mock` é o único modo operacional nesta
 * fase — `local`/`api` existem como adapters reais de contrato, testados
 * contra servidor fake, mas ficam NOT_CONFIGURED em operação real (decisão
 * da revisão externa: sem LLM local nem API paga neste milestone).
 */
export type AiMode = 'mock' | 'local' | 'api';

export interface AiCompletionRequest {
  agentId: string;
  taskId?: string;
  correlationId?: string;
  /** Prompt já resolvido — o Gateway não monta prompt, só transporta. */
  prompt: string;
  maxTokens?: number;
}

export type AiCallStatus = 'SUCCESS' | 'ERROR' | 'BLOCKED' | 'PAUSED';

/** O que um adapter devolve — sem custo nem decisão de orçamento, que são responsabilidade do Gateway. */
export interface AdapterResult {
  content: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

/** Todo adapter (mock/local/api) implementa isto. Agentes nunca falam com um adapter direto. */
export interface AiAdapter {
  readonly mode: AiMode;
  complete(request: AiCompletionRequest): Promise<AdapterResult>;
}

export class ModelUnavailableError extends Error {
  constructor(
    readonly mode: AiMode,
    reason: string,
  ) {
    super(`Modo de IA '${mode}' indisponível: ${reason}`);
    this.name = 'ModelUnavailableError';
  }
}
