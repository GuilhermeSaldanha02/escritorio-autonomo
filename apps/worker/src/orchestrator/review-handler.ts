import type { Job } from 'bullmq';
import { implementationReadySchema, reviewInSandbox, type ImplementationReady } from '@escritorio/agents';
import { type Pool, withTransaction } from '@escritorio/database';
import {
  JOB_NAMES,
  type JobDispatch,
  type ReviewTaskJobData,
  QUEUE_NAMES,
  transitionOpportunityIn,
  transitionTask,
  transitionTaskIn,
} from '@escritorio/events';
import type { Governor } from '@escritorio/governor';
import { GovernedSandbox, type ToolGateway } from '@escritorio/tool-gateway';
import type { Logger } from '@escritorio/shared';
import { z } from 'zod';
import { recordAgentStateChange } from './agent-state.js';
import { taskRowToContract, type TaskRow } from './mappers.js';

export interface ReviewHandlerDeps {
  pool: Pool;
  governor: Governor;
  toolGateway: ToolGateway;
  logger: Logger;
}

async function loadTask(pool: Pool, id: string): Promise<TaskRow | undefined> {
  const { rows } = await pool.query<TaskRow>(
    `SELECT id, opportunity_id, objective, acceptance_criteria, allowed_tools, status, retry_count, max_cost_brl, max_runtime_minutes
       FROM tasks WHERE id = $1`,
    [id],
  );
  return rows[0];
}

/** Task terminal (COMPLETED ou BLOCKED) → uma Experience, enfileirada na mesma transação que a encerra. */
function recordExperienceDispatch(taskId: string, correlationId: string, attempts: number): JobDispatch {
  return {
    queue: QUEUE_NAMES.ORCHESTRATOR,
    jobName: JOB_NAMES.RECORD_EXPERIENCE,
    data: () => ({ taskId, correlationId }),
    attempts,
    jobId: `record-experience-${taskId}`,
  };
}

const implementationEventPayloadSchema = implementationReadySchema.extend({ developer_sandbox_id: z.string() });

/** Pega o snapshot que o Desenvolvedor produziu por último para esta task (evento IMPLEMENTATION_READY mais recente). */
async function loadLatestImplementation(pool: Pool, taskId: string): Promise<ImplementationReady> {
  const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM events WHERE task_id = $1 AND type = 'IMPLEMENTATION_READY' ORDER BY occurred_at DESC LIMIT 1`,
    [taskId],
  );
  const payload = rows[0]?.payload;
  if (!payload) throw new Error(`Nenhum evento IMPLEMENTATION_READY encontrado para a task ${taskId}`);
  return implementationEventPayloadSchema.parse(payload);
}

/**
 * Processa `review-task`: leva a task de IMPLEMENTATION_READY até COMPLETED
 * ou de volta a IN_PROGRESS (retry) ou BLOCKED (limite de retries esgotado).
 *
 * O Revisor sempre roda numa sandbox nova (critério 5) — nunca reaproveita a
 * do Desenvolvedor, e nunca recebe quem implementou (packages/agents/src/reviewer.ts).
 */
export function createReviewHandler({ pool, governor, toolGateway, logger }: ReviewHandlerDeps) {
  return async function handleReviewTask(job: Job<ReviewTaskJobData>): Promise<void> {
    const { taskId, correlationId } = job.data;
    let task = await loadTask(pool, taskId);
    if (!task) {
      logger.warn({ taskId }, 'task não encontrada — job ignorado');
      return;
    }

    if (task.status === 'IMPLEMENTATION_READY') {
      await recordAgentStateChange(pool, 'REVISOR-001', 'REVIEWING', correlationId, `task:${taskId}:agent-state:reviewing:${task.retry_count}`, { taskId });
      await transitionTask(pool, {
        id: taskId,
        from: 'IMPLEMENTATION_READY',
        to: 'IN_REVIEW',
        idempotencyKey: `task:${taskId}:review-started:${task.retry_count}`,
        event: { type: 'REVIEW_STARTED', payload: { agentId: 'REVISOR-001' }, taskId, opportunityId: task.opportunity_id ?? undefined, correlationId },
      });
      task = await loadTask(pool, taskId);
      if (!task) return;
    }

    if (task.status !== 'IN_REVIEW') return; // já avançou (reentrega tardia) ou está bloqueada/cancelada.

    const implementation = await loadLatestImplementation(pool, taskId);
    const governedSandbox = new GovernedSandbox(toolGateway, 'REVISOR-001', { taskId, correlationId });
    const { review, sandboxId: reviewSandboxId } = await reviewInSandbox(governedSandbox, taskRowToContract(task), implementation);

    if (review.decision === 'PASSED') {
      await recordAgentStateChange(pool, 'REVISOR-001', 'SUCCESS', correlationId, `task:${taskId}:agent-state:review-passed:${task.retry_count}`, { taskId });
      const opportunityId = task.opportunity_id;
      await withTransaction(pool, async (tx) => {
        await transitionTaskIn(tx, {
          id: taskId,
          from: 'IN_REVIEW',
          to: 'COMPLETED',
          idempotencyKey: `task:${taskId}:completed`,
          event: {
            type: 'REVIEW_PASSED',
            payload: { ...review, review_sandbox_id: reviewSandboxId ?? null },
            taskId,
            opportunityId: opportunityId ?? undefined,
            correlationId,
          },
          dispatch: recordExperienceDispatch(taskId, correlationId, governor.limits.MAX_TASK_RETRIES + 1),
        });
        if (opportunityId) {
          await transitionOpportunityIn(tx, {
            id: opportunityId,
            from: 'WORKING',
            to: 'SUBMITTED',
            actor: { kind: 'system', component: 'ORCHESTRATOR' },
            idempotencyKey: `opportunity:${opportunityId}:submitted`,
            event: { type: 'TASK_COMPLETED', payload: { taskId }, taskId, opportunityId, correlationId },
          });
        }
      });
      return;
    }

    // FAILED: retry até MAX_TASK_RETRIES, depois BLOCKED (§13.4).
    const maxRetries = governor.limits.MAX_TASK_RETRIES;
    const nextRetryCount = task.retry_count + 1;
    const shouldRetry = task.retry_count < maxRetries;
    const opportunityId = task.opportunity_id;

    await recordAgentStateChange(pool, 'REVISOR-001', 'FAILED', correlationId, `task:${taskId}:agent-state:review-failed:${task.retry_count}`, { taskId });

    if (shouldRetry) {
      await withTransaction(pool, async (tx) => {
        await tx.query(`UPDATE tasks SET retry_count = $2 WHERE id = $1`, [taskId, nextRetryCount]);
        await transitionTaskIn(tx, {
          id: taskId,
          from: 'IN_REVIEW',
          to: 'IN_PROGRESS',
          idempotencyKey: `task:${taskId}:retry:${nextRetryCount}`,
          event: {
            type: 'REVIEW_FAILED',
            payload: { ...review, review_sandbox_id: reviewSandboxId ?? null, retry: nextRetryCount, maxRetries },
            taskId,
            opportunityId: opportunityId ?? undefined,
            correlationId,
          },
          dispatch: {
            queue: QUEUE_NAMES.ORCHESTRATOR,
            jobName: JOB_NAMES.DEVELOP_TASK,
            data: () => ({ taskId, correlationId }),
            attempts: maxRetries + 1,
            jobId: `develop-task-${taskId}-${nextRetryCount}`,
          },
        });
      });
      return;
    }

    await withTransaction(pool, async (tx) => {
      await transitionTaskIn(tx, {
        id: taskId,
        from: 'IN_REVIEW',
        to: 'BLOCKED',
        idempotencyKey: `task:${taskId}:blocked`,
        event: {
          type: 'TASK_BLOCKED',
          payload: { ...review, review_sandbox_id: reviewSandboxId ?? null, retry_count: task.retry_count, maxRetries },
          taskId,
          opportunityId: opportunityId ?? undefined,
          correlationId,
        },
        dispatch: recordExperienceDispatch(taskId, correlationId, maxRetries + 1),
      });
      if (opportunityId) {
        await transitionOpportunityIn(tx, {
          id: opportunityId,
          from: 'WORKING',
          to: 'FAILED',
          actor: { kind: 'system', component: 'ORCHESTRATOR' },
          idempotencyKey: `opportunity:${opportunityId}:failed`,
          event: {
            type: 'OPPORTUNITY_REJECTED',
            payload: { reason: `task ${taskId} bloqueada após ${maxRetries} retries` },
            taskId,
            opportunityId,
            correlationId,
          },
        });
      }
    });
  };
}
