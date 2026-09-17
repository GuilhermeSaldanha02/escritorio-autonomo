import { describe, expect, it } from 'vitest';
import { decideReview, nextTaskStatusAfterReview, runMockDeveloperTask, type DeveloperTask, type ImplementationReady } from '@escritorio/agents';

function task(overrides: Partial<DeveloperTask> = {}): DeveloperTask {
  return {
    task_id: crypto.randomUUID(),
    objective: 'Corrigir bug',
    repository: 'https://example.com/repo.git',
    branch: 'feat/x',
    acceptance_criteria: ['critério 1', 'critério 2'],
    allowed_tools: ['run_tests'],
    max_cost: 0,
    max_runtime_minutes: 30,
    ...overrides,
  };
}

describe('decideReview', () => {
  it('aprova quando build e testes passam sem alertas de segurança', () => {
    const t = task();
    const review = decideReview(t, runMockDeveloperTask(t));
    expect(review.decision).toBe('PASSED');
    expect(review.requirements.every((r) => r.met)).toBe(true);
  });

  it('reprova quando o build falhou', () => {
    const implementation: ImplementationReady = {
      ...runMockDeveloperTask(task()),
      build: false,
    };
    const review = decideReview(task(), implementation);
    expect(review.decision).toBe('FAILED');
    expect(review.reason).toMatch(/build falhou/);
  });

  it('reprova quando há teste falhando', () => {
    const implementation: ImplementationReady = {
      ...runMockDeveloperTask(task()),
      tests: { total: 2, passed: 1, failed: 1 },
    };
    const review = decideReview(task(), implementation);
    expect(review.decision).toBe('FAILED');
    expect(review.reason).toMatch(/falhas: 1/);
  });

  it('reprova com qualquer alerta de segurança, mesmo com testes verdes', () => {
    const t = task();
    const review = decideReview(t, runMockDeveloperTask(t), ['dependência com CVE crítica']);
    expect(review.decision).toBe('FAILED');
    expect(review.security_flags).toEqual(['dependência com CVE crítica']);
  });

  it('nunca recebe o autor: mesmo resultado, mesma decisão, sem enviesar por quem fez', () => {
    const t = task();
    const implementation = runMockDeveloperTask(t);
    expect(decideReview(t, implementation)).toEqual(decideReview(t, implementation));
  });
});

describe('nextTaskStatusAfterReview', () => {
  const t = task();
  const passed = decideReview(t, runMockDeveloperTask(t));
  const failed = decideReview(t, { ...runMockDeveloperTask(t), build: false });

  it('revisão aprovada conclui a tarefa', () => {
    expect(nextTaskStatusAfterReview(passed, 0, 3)).toBe('COMPLETED');
  });

  it('revisão reprovada volta ao Desenvolvedor enquanto houver retries', () => {
    expect(nextTaskStatusAfterReview(failed, 0, 3)).toBe('IN_PROGRESS');
    expect(nextTaskStatusAfterReview(failed, 2, 3)).toBe('IN_PROGRESS');
  });

  it('esgotados os retries, bloqueia a tarefa (§13.4)', () => {
    expect(nextTaskStatusAfterReview(failed, 3, 3)).toBe('BLOCKED');
    expect(nextTaskStatusAfterReview(failed, 4, 3)).toBe('BLOCKED');
  });
});
