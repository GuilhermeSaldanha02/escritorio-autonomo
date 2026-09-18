import { reserveBudget, releaseReservation, settleReservation } from '@escritorio/budget';
import type { Pool } from '@escritorio/database';
import type { Governor, SpendPurpose } from '@escritorio/governor';
import { describeError, type Logger } from '@escritorio/shared';
import type { ModelRouter } from './model-router.js';
import { ModelUnavailableError, type AiCompletionRequest, type AiMode } from './types.js';

export interface AiGatewayDeps {
  pool: Pool;
  governor: Governor;
  router: ModelRouter;
  logger: Logger;
  /** Custo estimado da chamada, em BRL. Nenhum modo tem gasto real habilitado nesta fase do M3 — o padrão é sempre 0. */
  estimateCostBrl?: (request: AiCompletionRequest, mode: AiMode) => number;
  budgetPurpose?: SpendPurpose;
}

export type AiCompletionStatus = 'SUCCESS' | 'ERROR' | 'BLOCKED';

export interface AiCompletionOutcome {
  status: AiCompletionStatus;
  content?: string;
  modelCallId: string;
  error?: string;
}

const DEFAULT_PURPOSE: SpendPurpose = 'DEVELOPMENT_EXTERNAL_SERVICE';

function defaultEstimate(_request: AiCompletionRequest, _mode: AiMode): number {
  // Nenhum modo (mock/local/api) tem gasto real habilitado neste milestone —
  // ver docs/M3-PLANO.md. Ligar isso de verdade exige decisão própria.
  return 0;
}

/**
 * Ponto único de entrada para qualquer chamada de IA (M3, critério 1 e 12).
 * Agentes nunca falam com um adapter direto — só com `aiGateway.complete()`.
 *
 * Toda chamada passa por: reserva de orçamento (Governor) -> adapter (via
 * Model Router) -> registro em `model_calls` -> liquidação ou devolução da
 * reserva. Nenhum LLM participa da decisão de autorização (critério 8).
 */
export class AiGateway {
  constructor(private readonly deps: AiGatewayDeps) {}

  async complete(request: AiCompletionRequest): Promise<AiCompletionOutcome> {
    const { pool, governor, router, logger } = this.deps;
    const mode = router.mode;
    const estimate = (this.deps.estimateCostBrl ?? defaultEstimate)(request, mode);
    const purpose = this.deps.budgetPurpose ?? DEFAULT_PURPOSE;
    // Mesma chave usada na reserva de orçamento: identifica a operação
    // lógica, não a tentativa de entrega. Uma reentrega do BullMQ (ou
    // qualquer outro at-least-once) resolve para a mesma linha de auditoria,
    // não cria uma segunda (recomendação da revisão externa no fechamento
    // do M3 — ver docs/M3-INTELIGENCIA-GOVERNADA.md).
    const logicalCallId = `ai-call:${request.agentId}:${request.correlationId ?? request.taskId ?? crypto.randomUUID()}`;

    const existing = await this.#findByLogicalCallId(logicalCallId);
    if (existing) return existing;

    const reservation = await reserveBudget(pool, governor, {
      purpose,
      amountBrl: estimate,
      idempotencyKey: logicalCallId,
      taskId: request.taskId,
      correlationId: request.correlationId,
    });

    if (reservation.outcome === 'DENIED') {
      return this.#recordCall({
        request,
        mode,
        status: 'BLOCKED',
        error: reservation.decision.allowed ? undefined : reservation.decision.reason,
        logicalCallId,
      });
    }

    const adapter = router.resolve();
    try {
      const result = await adapter.complete(request);
      if (reservation.reservationId) await settleReservation(pool, reservation.reservationId, estimate);
      return this.#recordCall({
        request,
        mode,
        status: 'SUCCESS',
        result,
        costBrl: estimate,
        budgetReservationId: reservation.reservationId,
        logicalCallId,
      });
    } catch (error) {
      if (reservation.reservationId) await releaseReservation(pool, reservation.reservationId);
      const message = error instanceof ModelUnavailableError ? error.message : describeError(error).message;
      logger.warn({ agentId: request.agentId, mode, err: describeError(error) }, 'chamada de IA falhou');
      return this.#recordCall({
        request,
        mode,
        status: 'ERROR',
        error: message,
        budgetReservationId: reservation.reservationId,
        logicalCallId,
      });
    }
  }

  async #findByLogicalCallId(logicalCallId: string): Promise<AiCompletionOutcome | undefined> {
    const { rows } = await this.deps.pool.query<{ id: string; status: AiCompletionStatus; error: string | null }>(
      `SELECT id, status, error FROM model_calls WHERE logical_call_id = $1`,
      [logicalCallId],
    );
    const row = rows[0];
    if (!row) return undefined;
    // Reentrega: a operação lógica já foi resolvida antes. Não repete a
    // chamada ao adapter — `content` não é persistido (não é dado
    // financeiro/de auditoria obrigatório), só o resultado da tentativa
    // original importa para quem só usa isto como nota de auditoria.
    return { status: row.status, modelCallId: row.id, error: row.error ?? undefined };
  }

  async #recordCall(params: {
    request: AiCompletionRequest;
    mode: AiMode;
    status: AiCompletionStatus;
    result?: { content: string; provider: string; model: string; inputTokens: number; outputTokens: number; durationMs: number };
    costBrl?: number;
    error?: string;
    budgetReservationId?: string;
    logicalCallId: string;
  }): Promise<AiCompletionOutcome> {
    const { request, mode, status, result, error, budgetReservationId, logicalCallId } = params;
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `INSERT INTO model_calls
         (agent_id, task_id, correlation_id, mode, provider, model, input_tokens, output_tokens, cost_brl, duration_ms, status, error, budget_reservation_id, logical_call_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (logical_call_id) DO NOTHING
       RETURNING id`,
      [
        request.agentId,
        request.taskId ?? null,
        request.correlationId ?? null,
        mode,
        result?.provider ?? mode,
        result?.model ?? 'n/a',
        result?.inputTokens ?? 0,
        result?.outputTokens ?? 0,
        params.costBrl ?? 0,
        result?.durationMs ?? 0,
        status,
        error ?? null,
        budgetReservationId ?? null,
        logicalCallId,
      ],
    );
    const inserted = rows[0];
    if (inserted) return { status, content: result?.content, modelCallId: inserted.id, error };

    // Corrida genuína (duas chamadas concorrentes, não sequenciais) perdeu
    // para outra que já commitou a mesma logical_call_id — devolve o que
    // realmente ficou gravado, nunca insere uma segunda linha.
    const winner = await this.#findByLogicalCallId(logicalCallId);
    if (!winner) throw new Error(`model_calls com logical_call_id ${logicalCallId} deveria existir e não foi encontrado`);
    return winner;
  }
}
