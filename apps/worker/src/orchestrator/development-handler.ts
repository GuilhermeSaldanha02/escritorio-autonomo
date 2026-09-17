import type { Job } from 'bullmq';
import { runDeveloperTaskInSandbox } from '@escritorio/agents';
import type { Pool } from '@escritorio/database';
import {
  type DevelopTaskJobData,
  JOB_NAMES,
  QUEUE_NAMES,
  transitionTask,
} from '@escritorio/events';
import type { Governor } from '@escritorio/governor';
import type { SandboxManager } from '@escritorio/tools';
import type { Logger } from '@escritorio/shared';
import { recordAgentStateChange } from './agent-state.js';
import { taskRowToContract, type TaskRow } from './mappers.js';

export interface DevelopmentHandlerDeps {
  pool: Pool;
  governor: Governor;
  sandboxManager: SandboxManager;
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

async function runningTaskCount(pool: Pool, excludingTaskId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM tasks WHERE status IN ('IN_PROGRESS', 'IN_REVIEW') AND id <> $1`,
    [excludingTaskId],
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Processa `develop-task`: leva a task de ASSIGNED até IMPLEMENTATION_READY.
 * Idempotente por leitura de estado — uma reentrega do BullMQ (at-least-once)
 * relê o status atual em vez de assumir de onde o job payload diz que partiu.
 */
export function createDevelopmentHandler({ pool, governor, sandboxManager, logger }: DevelopmentHandlerDeps) {
  return async function handleDevelopTask(job: Job<DevelopTaskJobData>): Promise<void> {
    const { taskId, correlationId } = job.data;
    let task = await loadTask(pool, taskId);
    if (!task) {
      logger.warn({ taskId }, 'task não encontrada — job ignorado');
      return;
    }

    if (task.status === 'ASSIGNED') {
      // Critério 9 (revisão externa): MAX_PARALLEL_TASKS é uma garantia real do
      // Governor, não só a concorrência do BullMQ — garantia V1 single-worker,
      // documentada em docs/M2-PLANO.md.
      const running = await runningTaskCount(pool, taskId);
      const start = governor.evaluate({ kind: 'TASK_START', runningTasks: running });
      if (!start.allowed) {
        throw new Error(`Governor negou início da task (${start.rule}): ${start.reason}`);
      }

      await transitionTask(pool, {
        id: taskId,
        from: 'ASSIGNED',
        to: 'IN_PROGRESS',
        idempotencyKey: `task:${taskId}:started`,
        event: { type: 'TASK_STARTED', payload: { agentId: 'DESENVOLVEDOR-001' }, taskId, opportunityId: task.opportunity_id ?? undefined, correlationId },
      });
      task = await loadTask(pool, taskId);
      if (!task) return;
    }

    if (task.status !== 'IN_PROGRESS') return; // já avançou (reentrega tardia) ou está bloqueada/cancelada.

    await recordAgentStateChange(pool, 'DESENVOLVEDOR-001', 'CODING', correlationId, `task:${taskId}:agent-state:coding:${task.retry_count}`, { taskId });
    const { sandboxId: developerSandboxId, ...implementation } = await runDeveloperTaskInSandbox(
      sandboxManager,
      taskRowToContract(task),
    );
    await recordAgentStateChange(pool, 'DESENVOLVEDOR-001', implementation.build ? 'SUCCESS' : 'FAILED', correlationId, `task:${taskId}:agent-state:done:${task.retry_count}`, { taskId });

    await transitionTask(pool, {
      id: taskId,
      from: 'IN_PROGRESS',
      to: 'IMPLEMENTATION_READY',
      idempotencyKey: `task:${taskId}:implementation-ready:${task.retry_count}`,
      event: {
        // developer_sandbox_id acompanha o contrato só como auditoria (qual
        // sandbox produziu isto); o Revisor usa outra, nunca esta mesma.
        type: 'IMPLEMENTATION_READY',
        payload: { ...implementation, developer_sandbox_id: developerSandboxId },
        taskId,
        opportunityId: task.opportunity_id ?? undefined,
        correlationId,
      },
      dispatch: {
        queue: QUEUE_NAMES.ORCHESTRATOR,
        jobName: JOB_NAMES.REVIEW_TASK,
        data: () => ({ taskId, correlationId }),
        attempts: governor.limits.MAX_TASK_RETRIES + 1,
        jobId: `review-task-${taskId}-${task.retry_count}`,
      },
    });
  };
}
