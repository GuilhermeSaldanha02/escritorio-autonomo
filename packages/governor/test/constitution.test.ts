import { describe, expect, it } from 'vitest';
import { ConstitutionError, loadConstitution, parseConstitution } from '@escritorio/governor';

describe('Constituição', () => {
  it('carrega o constitution.yaml do repositório com os valores da especificação', () => {
    const constitution = loadConstitution();
    expect(constitution.limites).toEqual({ MAX_TASK_RETRIES: 3, MAX_PARALLEL_TASKS: 2 });
    expect(constitution.free_first.DEVELOPMENT_EXTERNAL_SERVICES_TARGET_BRL).toBe(0);
    expect(constitution.free_first.EXPERIMENTAL_BOOTSTRAP_MAX_BRL).toBe(5);
    expect(Object.values(constitution.permissoes).every((value) => value === false)).toBe(true);
  });

  it('recusa uma constituição que libera trading', () => {
    const tampered = structuredClone(loadConstitution()) as unknown as {
      permissoes: Record<string, boolean>;
    };
    tampered.permissoes.ALLOW_TRADING = true;
    expect(() => parseConstitution(tampered)).toThrow(/permissoes\.ALLOW_TRADING/);
  });

  it('recusa chaves desconhecidas em vez de ignorá-las', () => {
    const tampered = { ...structuredClone(loadConstitution()), ALLOW_EVERYTHING: true };
    expect(() => parseConstitution(tampered)).toThrow(ConstitutionError);
  });

  it('entrega a constituição congelada: nenhum código altera regras em memória', () => {
    const constitution = loadConstitution();
    expect(Object.isFrozen(constitution.permissoes)).toBe(true);
    expect(() => {
      (constitution.limites as { MAX_TASK_RETRIES: number }).MAX_TASK_RETRIES = 99;
    }).toThrow(TypeError);
  });

  it('falha com erro claro quando o arquivo não existe', () => {
    expect(() => loadConstitution('config/inexistente.yaml')).toThrow(/Não foi possível ler a constituição/);
  });
});
