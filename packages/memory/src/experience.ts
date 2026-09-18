export const EXPERIENCE_OUTCOMES = ['SUCCESS', 'FAILURE'] as const;
export type ExperienceOutcome = (typeof EXPERIENCE_OUTCOMES)[number];

export const REVIEW_RESULTS = ['PASSED', 'FAILED'] as const;
export type ReviewResult = (typeof REVIEW_RESULTS)[number];

/**
 * Entrada para `buildExperience` — os fatos já apurados de uma task, sem
 * nenhuma chamada de IA (M5-PLANO.md: "quem destila experiência em memória
 * sem IA real? Um resumo determinístico do resultado da task"). Quem monta
 * isto a partir de `tasks`/`events`/`model_calls`/`tool_calls` é uma camada
 * de persistência separada — este módulo só valida e normaliza.
 */
export interface ExperienceInput {
  taskId: string;
  agentId: string;
  capability: string;
  outcome: ExperienceOutcome;
  attemptCount: number;
  reviewResult?: ReviewResult;
  durationMs: number;
  technicalCostBrl: number;
  failureCodes?: readonly string[];
  evidenceRefs?: readonly string[];
}

export interface Experience {
  taskId: string;
  agentId: string;
  capability: string;
  outcome: ExperienceOutcome;
  attemptCount: number;
  reviewResult: ReviewResult | null;
  durationMs: number;
  technicalCostBrl: number;
  failureCodes: readonly string[];
  evidenceRefs: readonly string[];
  createdAt: string;
}

export class InvalidExperienceInputError extends Error {
  constructor(reason: string) {
    super(`Entrada de Experience inválida: ${reason}`);
    this.name = 'InvalidExperienceInputError';
  }
}

/**
 * Deriva uma `Experience` (fato histórico) determinística a partir de
 * evidência já persistida — nunca uma chamada de IA. `outcome=FAILURE` sem
 * nenhum `failureCode` é aceito (a causa pode não ter sido classificada),
 * mas `outcome=SUCCESS` com `reviewResult=FAILED` é uma contradição que este
 * builder recusa em vez de silenciosamente aceitar um fato inconsistente.
 */
export function buildExperience(input: ExperienceInput, now: () => Date = () => new Date()): Experience {
  if (input.attemptCount < 1) throw new InvalidExperienceInputError('attemptCount precisa ser >= 1');
  if (input.durationMs < 0) throw new InvalidExperienceInputError('durationMs precisa ser >= 0');
  if (input.technicalCostBrl < 0) throw new InvalidExperienceInputError('technicalCostBrl precisa ser >= 0');
  if (input.outcome === 'SUCCESS' && input.reviewResult === 'FAILED') {
    throw new InvalidExperienceInputError('outcome SUCCESS é inconsistente com reviewResult FAILED');
  }

  return {
    taskId: input.taskId,
    agentId: input.agentId,
    capability: input.capability,
    outcome: input.outcome,
    attemptCount: input.attemptCount,
    reviewResult: input.reviewResult ?? null,
    durationMs: input.durationMs,
    technicalCostBrl: input.technicalCostBrl,
    failureCodes: input.failureCodes ?? [],
    evidenceRefs: input.evidenceRefs ?? [],
    createdAt: now().toISOString(),
  };
}
