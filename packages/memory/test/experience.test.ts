import { describe, expect, it } from 'vitest';
import { buildExperience, type ExperienceInput, InvalidExperienceInputError } from '../src/experience.js';

function input(overrides: Partial<ExperienceInput> = {}): ExperienceInput {
  return {
    taskId: 'task-1',
    agentId: 'DESENVOLVEDOR-001',
    capability: 'CODE_EXECUTION',
    outcome: 'SUCCESS',
    attemptCount: 1,
    reviewResult: 'PASSED',
    durationMs: 1_000,
    technicalCostBrl: 0,
    ...overrides,
  };
}

describe('buildExperience', () => {
  it('constrói uma Experience com defaults para campos opcionais ausentes', () => {
    const fixedNow = () => new Date('2026-09-19T00:00:00Z');
    const result = buildExperience(input({ reviewResult: undefined, failureCodes: undefined, evidenceRefs: undefined }), fixedNow);
    expect(result.reviewResult).toBeNull();
    expect(result.failureCodes).toEqual([]);
    expect(result.evidenceRefs).toEqual([]);
    expect(result.createdAt).toBe('2026-09-19T00:00:00.000Z');
  });

  it('preserva failureCodes e evidenceRefs quando fornecidos', () => {
    const result = buildExperience(
      input({ outcome: 'FAILURE', reviewResult: 'FAILED', failureCodes: ['TIMEOUT'], evidenceRefs: ['event:123'] }),
    );
    expect(result.failureCodes).toEqual(['TIMEOUT']);
    expect(result.evidenceRefs).toEqual(['event:123']);
  });

  it.each([0, -1])('rejeita attemptCount menor que 1 (%i)', (attemptCount) => {
    expect(() => buildExperience(input({ attemptCount }))).toThrow(InvalidExperienceInputError);
  });

  it('rejeita durationMs negativo', () => {
    expect(() => buildExperience(input({ durationMs: -1 }))).toThrow(InvalidExperienceInputError);
  });

  it('rejeita technicalCostBrl negativo', () => {
    expect(() => buildExperience(input({ technicalCostBrl: -0.01 }))).toThrow(InvalidExperienceInputError);
  });

  it('rejeita outcome SUCCESS com reviewResult FAILED — fato inconsistente', () => {
    expect(() => buildExperience(input({ outcome: 'SUCCESS', reviewResult: 'FAILED' }))).toThrow(InvalidExperienceInputError);
  });

  it('aceita outcome FAILURE mesmo sem nenhum failureCode classificado', () => {
    expect(() => buildExperience(input({ outcome: 'FAILURE', reviewResult: undefined }))).not.toThrow();
  });
});
