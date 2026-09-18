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
    const idempotencyKey = `ai-call:${request.agentId}:${request.correlationId ?? request.taskId ?? crypto.randomUUID()}`;

    const reservation = await reserveBudget(pool, governor, {
      purpose,
      amountBrl: estimate,
      idempotencyKey,
      taskId: request.taskId,
      correlationId: request.correlationId,
    });

    if (reservation.outcome === 'DENIED') {
      const modelCallId = await this.#recordCall({
        request,
        mode,
        status: 'BLOCKED',
        error: reservation.decision.allowed ? undefined : reservation.decision.reason,
      });
      return { status: 'BLOCKED', modelCallId, error: reservation.decision.allowed ? undefined : reservation.decision.reason };
    }

    const adapter = router.resolve();
    try {
      const result = await adapter.complete(request);
      if (reservation.reservationId) await settleReservation(pool, reservation.reservationId, estimate);
      const modelCallId = await this.#recordCall({
        request,
        mode,
        status: 'SUCCESS',
        result,
        costBrl: estimate,
        budgetReservationId: reservation.reservationId,
      });
      return { status: 'SUCCESS', content: result.content, modelCallId };
    } catch (error) {
      if (reservation.reservationId) await releaseReservation(pool, reservation.reservationId);
      const message = error instanceof ModelUnavailableError ? error.message : describeError(error).message;
      logger.warn({ agentId: request.agentId, mode, err: describeError(error) }, 'chamada de IA falhou');
      const modelCallId = await this.#recordCall({
        request,
        mode,
        status: 'ERROR',
        error: message,
        budgetReservationId: reservation.reservationId,
      });
      return { status: 'ERROR', modelCallId, error: message };
    }
  }

  async #recordCall(params: {
    request: AiCompletionRequest;
    mode: AiMode;
    status: AiCompletionStatus;
    result?: { provider: string; model: string; inputTokens: number; outputTokens: number; durationMs: number };
    costBrl?: number;
    error?: string;
    budgetReservationId?: string;
  }): Promise<string> {
    const { request, mode, status, result, error, budgetReservationId } = params;
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `INSERT INTO model_calls
         (agent_id, task_id, correlation_id, mode, provider, model, input_tokens, output_tokens, cost_brl, duration_ms, status, error, budget_reservation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
      ],
    );
    return rows[0]!.id;
  }
}
