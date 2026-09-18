import { releaseReservation, reserveBudget, settleReservation } from '@escritorio/budget';
import type { Pool } from '@escritorio/database';
import type { Governor, SpendPurpose } from '@escritorio/governor';
import { describeError, type Logger } from '@escritorio/shared';
import type { SandboxManager } from '@escritorio/tools';
import type { ToolCallRequest, ToolCallOutcome } from './types.js';

export interface ToolGatewayDeps {
  pool: Pool;
  governor: Governor;
  sandboxManager: SandboxManager;
  logger: Logger;
  budgetPurpose?: SpendPurpose;
}

const DEFAULT_PURPOSE: SpendPurpose = 'DEVELOPMENT_EXTERNAL_SERVICE';
/** Execução de código na sandbox do M2 não tem custo externo — sempre R$0. */
const CODE_EXECUTION_COST_BRL = 0;

/**
 * Ponto único de entrada para execução de ferramenta (M3, critérios 6 e 7).
 * Agentes nunca chamam `SandboxManager.run()` direto — só
 * `toolGateway.execute()`. O Tool Gateway não cria um segundo caminho de
 * execução no host: por baixo, é sempre o mesmo Sandbox Manager do M2
 * (container descartável, sem rede, não-root, com teto de recursos).
 */
export class ToolGateway {
  constructor(private readonly deps: ToolGatewayDeps) {}

  async execute(request: ToolCallRequest): Promise<ToolCallOutcome> {
    const { pool, governor, sandboxManager, logger } = this.deps;
    const purpose = this.deps.budgetPurpose ?? DEFAULT_PURPOSE;
    const idempotencyKey = `tool-call:${request.agentId}:${request.correlationId ?? request.taskId ?? crypto.randomUUID()}`;

    const decision = governor.evaluate({ kind: 'TOOL_CALL', tool: request.tool });
    if (!decision.allowed) {
      const toolCallId = await this.#recordCall({ request, status: 'BLOCKED', error: decision.reason });
      return { status: 'BLOCKED', toolCallId, error: decision.reason };
    }

    const reservation = await reserveBudget(pool, governor, {
      purpose,
      amountBrl: CODE_EXECUTION_COST_BRL,
      idempotencyKey,
      taskId: request.taskId,
      correlationId: request.correlationId,
    });
    if (reservation.outcome === 'DENIED') {
      const toolCallId = await this.#recordCall({
        request,
        status: 'BLOCKED',
        error: reservation.decision.allowed ? undefined : reservation.decision.reason,
      });
      return { status: 'BLOCKED', toolCallId, error: reservation.decision.allowed ? undefined : reservation.decision.reason };
    }

    try {
      const result = await sandboxManager.run(request.payload);
      if (reservation.reservationId) await settleReservation(pool, reservation.reservationId, CODE_EXECUTION_COST_BRL);
      const toolCallId = await this.#recordCall({
        request,
        status: 'SUCCESS',
        durationMs: result.durationMs,
        budgetReservationId: reservation.reservationId,
      });
      return {
        status: 'SUCCESS',
        toolCallId,
        result: {
          sandboxId: result.sandboxId,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
          oomKilled: result.oomKilled,
          durationMs: result.durationMs,
        },
      };
    } catch (error) {
      if (reservation.reservationId) await releaseReservation(pool, reservation.reservationId);
      const message = describeError(error).message;
      logger.warn({ agentId: request.agentId, tool: request.tool, err: describeError(error) }, 'chamada de ferramenta falhou');
      const toolCallId = await this.#recordCall({
        request,
        status: 'ERROR',
        error: message,
        budgetReservationId: reservation.reservationId,
      });
      return { status: 'ERROR', toolCallId, error: message };
    }
  }

  async #recordCall(params: {
    request: ToolCallRequest;
    status: 'SUCCESS' | 'ERROR' | 'BLOCKED';
    durationMs?: number;
    error?: string;
    budgetReservationId?: string;
  }): Promise<string> {
    const { request, status, error, budgetReservationId } = params;
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `INSERT INTO tool_calls (agent_id, task_id, correlation_id, tool, status, cost_brl, duration_ms, error, budget_reservation_id)
       VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8)
       RETURNING id`,
      [
        request.agentId,
        request.taskId ?? null,
        request.correlationId ?? null,
        request.tool,
        status,
        params.durationMs ?? 0,
        error ?? null,
        budgetReservationId ?? null,
      ],
    );
    return rows[0]!.id;
  }
}
