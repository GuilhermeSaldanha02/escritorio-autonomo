import type { Experience } from './experience.js';

export const RECOMMENDED_ACTIONS = ['PROMOTE', 'KEEP', 'INVESTIGATE'] as const;
export type RecommendedAction = (typeof RECOMMENDED_ACTIONS)[number];

export interface AgentPerformanceWindow {
  from: string;
  to: string;
}

export interface AgentPerformanceAssessment {
  agentId: string;
  window: AgentPerformanceWindow;
  sampleSize: number;
  tasksCompleted: number;
  tasksFailed: number;
  successRate: number;
  reviewPassRate: number | null;
  retryRate: number;
  avgDurationMs: number;
  totalTechnicalCostBrl: number;
  recommendedAction: RecommendedAction;
}

export class MixedAgentExperienceError extends Error {
  constructor(readonly expected: string, readonly found: string) {
    super(`Experience de agentId "${found}" não pertence à janela do agentId "${expected}"`);
    this.name = 'MixedAgentExperienceError';
  }
}

const MIN_SAMPLE_SIZE = 5;
const PROMOTE_THRESHOLD = 0.9;
const INVESTIGATE_THRESHOLD = 0.5;

/**
 * Recomendação determinística — nunca uma decisão autônoma. M5 calcula
 * `AgentPerformanceAssessment` com `recommendedAction`; só o M6
 * (Scheduler/Governor) transforma isso em transição de lifecycle real
 * (PROBATION→ACTIVE, ACTIVE→SLEEP, SLEEP→ARCHIVED). Amostra pequena demais
 * para decidir é tratada como incerteza, não como reprovação: vira
 * INVESTIGATE, não KEEP nem PROMOTE.
 */
function recommendAction(sampleSize: number, successRate: number, reviewPassRate: number | null): RecommendedAction {
  if (sampleSize < MIN_SAMPLE_SIZE) return 'INVESTIGATE';
  if (successRate < INVESTIGATE_THRESHOLD || (reviewPassRate !== null && reviewPassRate < INVESTIGATE_THRESHOLD)) {
    return 'INVESTIGATE';
  }
  if (successRate >= PROMOTE_THRESHOLD && (reviewPassRate === null || reviewPassRate >= PROMOTE_THRESHOLD)) {
    return 'PROMOTE';
  }
  return 'KEEP';
}

/**
 * Agrega `Experience` (fatos já apurados, nunca IA) de um único agente numa
 * janela temporal em `AgentPerformanceAssessment`. Quem recorta a janela e
 * filtra por agentId é a camada de persistência — esta função só valida que
 * o que recebeu é de fato um único agente (nunca soma performance de agentes
 * diferentes por engano) e agrega.
 */
export function calculateAgentPerformance(
  agentId: string,
  experiences: readonly Experience[],
  window: AgentPerformanceWindow,
): AgentPerformanceAssessment {
  for (const experience of experiences) {
    if (experience.agentId !== agentId) {
      throw new MixedAgentExperienceError(agentId, experience.agentId);
    }
  }

  const sampleSize = experiences.length;
  const tasksCompleted = experiences.filter((e) => e.outcome === 'SUCCESS').length;
  const tasksFailed = experiences.filter((e) => e.outcome === 'FAILURE').length;
  const successRate = sampleSize === 0 ? 0 : tasksCompleted / sampleSize;

  const reviewed = experiences.filter((e) => e.reviewResult !== null);
  const reviewPassRate =
    reviewed.length === 0 ? null : reviewed.filter((e) => e.reviewResult === 'PASSED').length / reviewed.length;

  const retried = experiences.filter((e) => e.attemptCount > 1).length;
  const retryRate = sampleSize === 0 ? 0 : retried / sampleSize;

  const avgDurationMs =
    sampleSize === 0 ? 0 : experiences.reduce((sum, e) => sum + e.durationMs, 0) / sampleSize;
  const totalTechnicalCostBrl = experiences.reduce((sum, e) => sum + e.technicalCostBrl, 0);

  return {
    agentId,
    window,
    sampleSize,
    tasksCompleted,
    tasksFailed,
    successRate,
    reviewPassRate,
    retryRate,
    avgDurationMs,
    totalTechnicalCostBrl,
    recommendedAction: recommendAction(sampleSize, successRate, reviewPassRate),
  };
}
