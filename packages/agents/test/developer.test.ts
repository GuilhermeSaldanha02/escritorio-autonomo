import { describe, expect, it } from 'vitest';
import { developerTaskSchema, implementationReadySchema, runMockDeveloperTask, type DeveloperTask } from '@escritorio/agents';

function task(overrides: Partial<DeveloperTask> = {}): DeveloperTask {
  return {
    task_id: crypto.randomUUID(),
    objective: 'Corrigir bug de paginação',
    repository: 'https://example.com/repo.git',
    branch: 'feat/corrige-paginacao',
    acceptance_criteria: ['a paginação não perde itens', 'testes cobrem o caso de borda'],
    allowed_tools: ['read_file', 'edit_file', 'run_tests'],
    max_cost: 0,
    max_runtime_minutes: 30,
    ...overrides,
  };
}

describe('runMockDeveloperTask', () => {
  it('produz um IMPLEMENTATION_READY válido pelo contrato §13.3', () => {
    const result = runMockDeveloperTask(task());
    expect(() => implementationReadySchema.parse(result)).not.toThrow();
  });

  it('respeita o custo zero (Free-First / mock)', () => {
    expect(runMockDeveloperTask(task()).cost).toBe(0);
  });

  it('o número de testes acompanha os critérios de aceitação', () => {
    const result = runMockDeveloperTask(task({ acceptance_criteria: ['a', 'b', 'c'] }));
    expect(result.tests).toEqual({ total: 3, passed: 3, failed: 0 });
  });

  it('deixa explícito nas notas que é execução mock', () => {
    expect(runMockDeveloperTask(task()).notes).toMatch(/MOCK/);
  });
});

describe('contrato DEVELOPER_TASK', () => {
  it('valida uma tarefa bem formada', () => {
    expect(() => developerTaskSchema.parse(task())).not.toThrow();
  });

  it('rejeita task_id que não é uuid', () => {
    expect(() => developerTaskSchema.parse(task({ task_id: 'não-é-uuid' }))).toThrow();
  });

  it('exige ao menos um critério de aceitação', () => {
    expect(() => developerTaskSchema.parse(task({ acceptance_criteria: [] }))).toThrow();
  });
});
