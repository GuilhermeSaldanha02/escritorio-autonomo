import type { Pool } from '@escritorio/database';
import { EventBus } from '@escritorio/events';
import type { AgentState } from '@escritorio/shared';

/**
 * Muda o estado técnico do agente e registra `AGENT_STATE_CHANGED` (critério
 * 10 do M2 — base para o Office visualizar o que cada agente está fazendo).
 *
 * Transação própria, separada da transição de task/opportunity do passo que
 * está começando: é só um sinal de UI/observabilidade, não uma garantia de
 * negócio — perder um `AGENT_STATE_CHANGED` isolado não corrompe o ciclo.
 * `idempotencyKey` evita duplicar o mesmo evento numa reentrega do job.
 */
export async function recordAgentStateChange(
  pool: Pool,
  agentId: string,
  newState: AgentState,
  correlationId: string,
  idempotencyKey: string,
  context: { taskId?: string; opportunityId?: string } = {},
): Promise<void> {
  const { rows } = await pool.query<{ state: AgentState }>(
    `UPDATE agents SET state = $1 WHERE id = $2 RETURNING state`,
    [newState, agentId],
  );
  const applied = rows.length > 0;
  await new EventBus(pool).publish({
    type: 'AGENT_STATE_CHANGED',
    payload: { agentId, newState, applied },
    agentId,
    taskId: context.taskId,
    opportunityId: context.opportunityId,
    correlationId,
    idempotencyKey,
  });
}
