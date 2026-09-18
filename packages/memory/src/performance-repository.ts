import type { Pool } from '@escritorio/database';
import { type AgentPerformanceAssessment, type AgentPerformanceWindow, calculateAgentPerformance } from './agent-performance.js';
import type { Experience } from './experience.js';

export interface RecordedPerformance {
  assessment: AgentPerformanceAssessment;
  created: boolean;
}

interface ExperienceRow {
  task_id: string;
  agent_id: string;
  capability: string;
  outcome: 'SUCCESS' | 'FAILURE';
  attempt_count: number;
  review_result: 'PASSED' | 'FAILED' | null;
  duration_ms: number;
  technical_cost_brl: string;
  failure_codes: string[];
  evidence_refs: string[];
  created_at: Date;
}

/**
 * Calcula e grava a avaliação de um agente numa janela [from, to) — critério
 * 11: sempre a partir de `experiences` (fatos com proveniência), nunca um
 * contador mutável. Como há uma Experience por task e a janela é semiaberta,
 * cada fato entra em exatamente uma janela (critério 12, sem dupla contagem).
 *
 * Só registra a recomendação: nenhuma transição de lifecycle acontece aqui
 * (critério 13 — isso é M6). A mesma janela nunca duplica a avaliação.
 */
export async function recordAgentPerformance(
  pool: Pool,
  agentId: string,
  window: AgentPerformanceWindow,
): Promise<RecordedPerformance> {
  const { rows } = await pool.query<ExperienceRow>(
    `SELECT task_id, agent_id, capability, outcome, attempt_count, review_result, duration_ms,
            technical_cost_brl::text, failure_codes, evidence_refs, created_at
       FROM experiences
      WHERE agent_id = $1 AND created_at >= $2 AND created_at < $3
      ORDER BY created_at, id`,
    [agentId, window.from, window.to],
  );
  const experiences: Experience[] = rows.map((row) => ({
    taskId: row.task_id,
    agentId: row.agent_id,
    capability: row.capability,
    outcome: row.outcome,
    attemptCount: row.attempt_count,
    reviewResult: row.review_result,
    durationMs: row.duration_ms,
    technicalCostBrl: Number(row.technical_cost_brl),
    failureCodes: row.failure_codes,
    evidenceRefs: row.evidence_refs,
    createdAt: row.created_at.toISOString(),
  }));
  const assessment = calculateAgentPerformance(agentId, experiences, window);

  const inserted = await pool.query(
    `INSERT INTO agent_performance (agent_id, window_from, window_to, sample_size, tasks_completed, tasks_failed, success_rate,
                                    review_pass_rate, retry_rate, avg_duration_ms, total_technical_cost_brl, recommended_action, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      agentId,
      window.from,
      window.to,
      assessment.sampleSize,
      assessment.tasksCompleted,
      assessment.tasksFailed,
      assessment.successRate,
      assessment.reviewPassRate,
      assessment.retryRate,
      assessment.avgDurationMs,
      assessment.totalTechnicalCostBrl,
      assessment.recommendedAction,
      `performance:${agentId}:${window.from}:${window.to}`,
    ],
  );
  return { assessment, created: inserted.rows.length > 0 };
}
