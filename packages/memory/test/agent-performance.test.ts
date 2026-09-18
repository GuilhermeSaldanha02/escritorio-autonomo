import { describe, expect, it } from 'vitest';
import { buildExperience, type Experience, type ExperienceInput } from '../src/experience.js';
import { calculateAgentPerformance, MixedAgentExperienceError } from '../src/agent-performance.js';

const WINDOW = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-18T00:00:00.000Z' };

function exp(overrides: Partial<ExperienceInput> = {}): Experience {
  return buildExperience({
    taskId: `task-${Math.random()}`,
    agentId: 'CACADOR-001',
    capability: 'DISCOVERY',
    outcome: 'SUCCESS',
    attemptCount: 1,
    reviewResult: 'PASSED',
    durationMs: 1_000,
    technicalCostBrl: 0,
    ...overrides,
  });
}

describe('calculateAgentPerformance', () => {
  it('amostra vazia é INVESTIGATE, nunca PROMOTE nem KEEP por padrão', () => {
    const result = calculateAgentPerformance('CACADOR-001', [], WINDOW);
    expect(result.sampleSize).toBe(0);
    expect(result.successRate).toBe(0);
    expect(result.reviewPassRate).toBeNull();
    expect(result.recommendedAction).toBe('INVESTIGATE');
  });

  it('amostra abaixo do mínimo é INVESTIGATE mesmo com 100% de sucesso', () => {
    const experiences = Array.from({ length: 3 }, () => exp());
    const result = calculateAgentPerformance('CACADOR-001', experiences, WINDOW);
    expect(result.successRate).toBe(1);
    expect(result.recommendedAction).toBe('INVESTIGATE');
  });

  it('amostra suficiente com alta taxa de sucesso e review vira PROMOTE', () => {
    const experiences = Array.from({ length: 10 }, () => exp());
    const result = calculateAgentPerformance('CACADOR-001', experiences, WINDOW);
    expect(result.recommendedAction).toBe('PROMOTE');
  });

  it('taxa de sucesso baixa vira INVESTIGATE, mesmo com amostra grande', () => {
    const experiences = [
      ...Array.from({ length: 4 }, () => exp({ outcome: 'SUCCESS', reviewResult: 'PASSED' })),
      ...Array.from({ length: 6 }, () => exp({ outcome: 'FAILURE', reviewResult: 'FAILED' })),
    ];
    const result = calculateAgentPerformance('CACADOR-001', experiences, WINDOW);
    expect(result.successRate).toBeCloseTo(0.4);
    expect(result.recommendedAction).toBe('INVESTIGATE');
  });

  it('taxas medianas (nem PROMOTE nem INVESTIGATE) ficam em KEEP', () => {
    const experiences = [
      ...Array.from({ length: 7 }, () => exp({ outcome: 'SUCCESS', reviewResult: 'PASSED' })),
      ...Array.from({ length: 3 }, () => exp({ outcome: 'FAILURE', reviewResult: 'FAILED' })),
    ];
    const result = calculateAgentPerformance('CACADOR-001', experiences, WINDOW);
    expect(result.successRate).toBeCloseTo(0.7);
    expect(result.reviewPassRate).toBeCloseTo(0.7);
    expect(result.recommendedAction).toBe('KEEP');
  });

  it('calcula tasksCompleted, tasksFailed, retryRate, avgDurationMs e totalTechnicalCostBrl corretamente', () => {
    const experiences = [
      exp({ outcome: 'SUCCESS', attemptCount: 1, durationMs: 1_000, technicalCostBrl: 0 }),
      exp({ outcome: 'SUCCESS', attemptCount: 3, durationMs: 2_000, technicalCostBrl: 0 }),
      exp({ outcome: 'FAILURE', attemptCount: 2, durationMs: 3_000, technicalCostBrl: 0, reviewResult: 'FAILED' }),
    ];
    const result = calculateAgentPerformance('CACADOR-001', experiences, WINDOW);
    expect(result.tasksCompleted).toBe(2);
    expect(result.tasksFailed).toBe(1);
    expect(result.retryRate).toBeCloseTo(2 / 3);
    expect(result.avgDurationMs).toBeCloseTo(2_000);
    expect(result.totalTechnicalCostBrl).toBe(0);
  });

  it('reviewPassRate ignora experiences sem reviewResult, não conta como falha', () => {
    const experiences = [
      exp({ reviewResult: 'PASSED' }),
      exp({ reviewResult: undefined, outcome: 'FAILURE' }),
    ];
    const result = calculateAgentPerformance('CACADOR-001', experiences, WINDOW);
    expect(result.reviewPassRate).toBe(1);
  });

  it('recusa experience de outro agentId — nunca soma performance de agentes diferentes', () => {
    const experiences = [exp({ agentId: 'DIRETOR-001' })];
    expect(() => calculateAgentPerformance('CACADOR-001', experiences, WINDOW)).toThrow(MixedAgentExperienceError);
  });

  it('preserva a janela temporal recebida na resposta', () => {
    const result = calculateAgentPerformance('CACADOR-001', [], WINDOW);
    expect(result.window).toEqual(WINDOW);
  });
});
