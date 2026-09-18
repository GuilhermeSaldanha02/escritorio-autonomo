import type { Pool } from '@escritorio/database';
import { buildExperience, type ExperienceOutcome, type ReviewResult } from './experience.js';

export class TaskNotFinishedError extends Error {
  constructor(readonly taskId: string, readonly status: string) {
    super(`Task "${taskId}" está em "${status}" — só COMPLETED, FAILED e BLOCKED viram Experience`);
    this.name = 'TaskNotFinishedError';
  }
}

export class TaskNotAssignedError extends Error {
  constructor(readonly taskId: string) {
    super(`Task "${taskId}" não tem agente atribuído — Experience precisa de um agente`);
    this.name = 'TaskNotAssignedError';
  }
}

export interface RecordedExperience {
  experienceId: string;
  created: boolean;
}

interface TaskRow {
  status: string;
  retry_count: number;
  assigned_agent_id: string | null;
  role: string | null;
  duration_ms: string;
}

/** COMPLETED é sucesso; FAILED e BLOCKED (sem transições de saída) são falha. */
const OUTCOME_BY_STATUS: Record<string, { outcome: ExperienceOutcome; failureCode?: string }> = {
  COMPLETED: { outcome: 'SUCCESS' },
  FAILED: { outcome: 'FAILURE', failureCode: 'TASK_FAILED' },
  BLOCKED: { outcome: 'FAILURE', failureCode: 'TASK_BLOCKED' },
};

/**
 * Deriva e grava a `Experience` de uma task terminal, só a partir de evidência
 * já persistida (critério 2) — nenhuma chamada de IA. Uma Experience por task
 * (`experience:<taskId>`): reentrega do job devolve a existente em vez de
 * duplicar (critério 3).
 *
 * `capability` é o `role` do agente atribuído: `tasks` não tem coluna de
 * capability, e o papel é o fato persistido — inventar outra fonte seria
 * fabricar dado. Códigos de falha vêm só de status, nunca do texto livre de
 * `error` (que pode carregar conteúdo externo não confiável).
 */
export async function recordExperienceForTask(pool: Pool, taskId: string): Promise<RecordedExperience> {
  const task = await pool.query<TaskRow>(
    `SELECT t.status, t.retry_count, t.assigned_agent_id, a.role,
            (EXTRACT(EPOCH FROM (t.updated_at - t.created_at)) * 1000)::bigint::text AS duration_ms
       FROM tasks t LEFT JOIN agents a ON a.id = t.assigned_agent_id
      WHERE t.id = $1`,
    [taskId],
  );
  const row = task.rows[0];
  if (!row) throw new TaskNotFinishedError(taskId, 'inexistente');
  const mapped = OUTCOME_BY_STATUS[row.status];
  if (!mapped) throw new TaskNotFinishedError(taskId, row.status);
  if (!row.assigned_agent_id || !row.role) throw new TaskNotAssignedError(taskId);

  const [reviews, modelCalls, toolCalls] = await Promise.all([
    pool.query<{ id: string; type: string }>(
      `SELECT id, type FROM events WHERE task_id = $1 AND type IN ('REVIEW_PASSED', 'REVIEW_FAILED') ORDER BY occurred_at, id`,
      [taskId],
    ),
    pool.query<{ id: string; status: string; cost_brl: string }>(
      `SELECT id, status, cost_brl::text FROM model_calls WHERE task_id = $1 ORDER BY created_at, id`,
      [taskId],
    ),
    pool.query<{ id: string; status: string; cost_brl: string }>(
      `SELECT id, status, cost_brl::text FROM tool_calls WHERE task_id = $1 ORDER BY created_at, id`,
      [taskId],
    ),
  ]);

  const lastReview = reviews.rows.at(-1);
  const reviewResult: ReviewResult | undefined = lastReview
    ? lastReview.type === 'REVIEW_PASSED'
      ? 'PASSED'
      : 'FAILED'
    : undefined;

  const failureCodes = new Set<string>();
  if (mapped.failureCode) failureCodes.add(mapped.failureCode);
  if (reviews.rows.some((event) => event.type === 'REVIEW_FAILED')) failureCodes.add('REVIEW_FAILED');
  // Só ERROR e BLOCKED são falha. PAUSED (Emergency Stop, circuito) é pausa: contá-la aqui
  // alimentaria o circuito do agente e fecharia o ciclo pausa -> falha -> SLEEP (critério 18).
  for (const call of modelCalls.rows) if (call.status === 'ERROR' || call.status === 'BLOCKED') failureCodes.add(`MODEL_CALL_${call.status}`);
  for (const call of toolCalls.rows) if (call.status === 'ERROR' || call.status === 'BLOCKED') failureCodes.add(`TOOL_CALL_${call.status}`);

  const technicalCostBrl = [...modelCalls.rows, ...toolCalls.rows].reduce((sum, call) => sum + Number(call.cost_brl), 0);
  const experience = buildExperience({
    taskId,
    agentId: row.assigned_agent_id,
    capability: row.role,
    outcome: mapped.outcome,
    attemptCount: row.retry_count + 1,
    reviewResult,
    durationMs: Math.max(0, Number(row.duration_ms)),
    technicalCostBrl,
    failureCodes: [...failureCodes].sort(),
    evidenceRefs: [
      `task:${taskId}`,
      ...reviews.rows.map((event) => `event:${event.id}`),
      ...modelCalls.rows.map((call) => `model_call:${call.id}`),
      ...toolCalls.rows.map((call) => `tool_call:${call.id}`),
    ],
  });

  const idempotencyKey = `experience:${taskId}`;
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO experiences (task_id, agent_id, capability, outcome, attempt_count, review_result, duration_ms,
                              technical_cost_brl, failure_codes, evidence_refs, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      experience.taskId,
      experience.agentId,
      experience.capability,
      experience.outcome,
      experience.attemptCount,
      experience.reviewResult,
      experience.durationMs,
      experience.technicalCostBrl,
      [...experience.failureCodes],
      [...experience.evidenceRefs],
      idempotencyKey,
    ],
  );
  if (inserted.rows[0]) return { experienceId: inserted.rows[0].id, created: true };

  const existing = await pool.query<{ id: string }>(`SELECT id FROM experiences WHERE idempotency_key = $1`, [idempotencyKey]);
  return { experienceId: existing.rows[0]!.id, created: false };
}
