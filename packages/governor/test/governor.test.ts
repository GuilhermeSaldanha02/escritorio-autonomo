import { describe, expect, it } from 'vitest';
import {
  GOVERNED_CAPABILITIES,
  GOVERNED_CAPABILITY_NAMES,
  GOVERNED_TOOL_NAMES,
  Governor,
  type GovernedCapability,
  loadConstitution,
} from '@escritorio/governor';

// Usa o constitution.yaml real do repositório: o teste prova a regra que vai
// para produção, não uma cópia feita para o teste passar.
const governor = new Governor(loadConstitution());

describe('Governor — capacidades proibidas', () => {
  it('bloqueia prospecção direta com a regra e a razão', () => {
    expect(governor.evaluate({ kind: 'CAPABILITY', capability: 'DIRECT_OUTREACH' })).toEqual({
      allowed: false,
      rule: 'DIRECT_OUTREACH',
      reason: expect.stringContaining('Ação proibida pela Constituição'),
    });
  });

  it.each(GOVERNED_CAPABILITY_NAMES)('bloqueia %s', (capability) => {
    const decision = governor.evaluate({ kind: 'CAPABILITY', capability });
    expect(decision).toMatchObject({ allowed: false, rule: GOVERNED_CAPABILITIES[capability].flag });
  });

  it('nega por padrão uma capacidade desconhecida vinda de entrada não confiável', () => {
    const decision = governor.evaluate({ kind: 'CAPABILITY', capability: 'FORMAT_DISK' as GovernedCapability });
    expect(decision).toMatchObject({ allowed: false, rule: 'UNKNOWN_CAPABILITY' });
  });
});

describe('Governor — orçamento', () => {
  const spend = { kind: 'SPEND', alreadySpentBrl: 0, approvedByFounder: false } as const;

  it('permite gasto zero (Free-First)', () => {
    expect(governor.evaluate({ ...spend, purpose: 'DEVELOPMENT_EXTERNAL_SERVICE', amountBrl: 0 })).toEqual({
      allowed: true,
    });
  });

  it('bloqueia qualquer gasto automático sem aprovação do fundador', () => {
    expect(governor.evaluate({ ...spend, purpose: 'EXPERIMENTAL_BOOTSTRAP', amountBrl: 1 })).toMatchObject({
      allowed: false,
      rule: 'AUTO_SPEND',
    });
  });

  it('mesmo aprovado, respeita a meta de R$0 em serviços de desenvolvimento', () => {
    const decision = governor.evaluate({
      ...spend,
      purpose: 'DEVELOPMENT_EXTERNAL_SERVICE',
      amountBrl: 0.01,
      approvedByFounder: true,
    });
    expect(decision).toMatchObject({ allowed: false, rule: 'DEVELOPMENT_EXTERNAL_SERVICES_TARGET_BRL' });
  });

  it('mesmo aprovado, respeita o teto acumulado de R$5 do bootstrap', () => {
    const base = { ...spend, purpose: 'EXPERIMENTAL_BOOTSTRAP', approvedByFounder: true } as const;
    expect(governor.evaluate({ ...base, amountBrl: 5 })).toEqual({ allowed: true });
    expect(governor.evaluate({ ...base, amountBrl: 2, alreadySpentBrl: 4 })).toMatchObject({
      allowed: false,
      rule: 'EXPERIMENTAL_BOOTSTRAP_MAX_BRL',
    });
  });

  it('rejeita valores negativos ou não finitos', () => {
    for (const amountBrl of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(governor.evaluate({ ...spend, purpose: 'EXPERIMENTAL_BOOTSTRAP', amountBrl })).toMatchObject({
        allowed: false,
        rule: 'INVALID_AMOUNT',
      });
    }
  });
});

describe('Governor — chamada de ferramenta (M3, Tool Gateway)', () => {
  it.each(GOVERNED_TOOL_NAMES)('permite a ferramenta conhecida %s', (tool) => {
    expect(governor.evaluate({ kind: 'TOOL_CALL', tool })).toEqual({ allowed: true });
  });

  it('nega por padrão uma ferramenta fora do registro — o Tool Gateway nunca executa o desconhecido', () => {
    expect(governor.evaluate({ kind: 'TOOL_CALL', tool: 'DELETE_PRODUCTION_DATABASE' })).toMatchObject({
      allowed: false,
      rule: 'UNKNOWN_TOOL',
    });
  });
});

describe('Governor — retries e concorrência', () => {
  it('permite até MAX_TASK_RETRIES=3 e bloqueia o quarto retry', () => {
    expect(governor.evaluate({ kind: 'TASK_RETRY', retryNumber: 3 })).toEqual({ allowed: true });
    expect(governor.evaluate({ kind: 'TASK_RETRY', retryNumber: 4 })).toMatchObject({
      allowed: false,
      rule: 'MAX_TASK_RETRIES',
    });
  });

  it('bloqueia uma terceira tarefa paralela (MAX_PARALLEL_TASKS=2)', () => {
    expect(governor.evaluate({ kind: 'TASK_START', runningTasks: 1 })).toEqual({ allowed: true });
    expect(governor.evaluate({ kind: 'TASK_START', runningTasks: 2 })).toMatchObject({
      allowed: false,
      rule: 'MAX_PARALLEL_TASKS',
    });
  });
});

describe('Governor — transições de lifecycle (M6)', () => {
  const STATUSES = ['PROBATION', 'ACTIVE', 'SLEEP', 'ARCHIVED', 'INEXISTENTE'];

  it('autoriza exatamente as três transições automáticas do M6 e nenhuma outra', () => {
    const allowed: string[] = [];
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        if (governor.evaluate({ kind: 'AGENT_LIFECYCLE_TRANSITION', from, to }).allowed) allowed.push(`${from}->${to}`);
      }
    }
    expect(allowed.sort()).toEqual(['ACTIVE->SLEEP', 'PROBATION->ACTIVE', 'SLEEP->ACTIVE']);
  });

  it('nega ARCHIVED como origem e como destino, com a regra e a razão', () => {
    for (const [from, to] of [
      ['SLEEP', 'ARCHIVED'],
      ['ACTIVE', 'ARCHIVED'],
      ['ARCHIVED', 'ACTIVE'],
    ] as const) {
      expect(governor.evaluate({ kind: 'AGENT_LIFECYCLE_TRANSITION', from, to })).toMatchObject({
        allowed: false,
        rule: 'LIFECYCLE_TRANSITION_NOT_ALLOWED',
      });
    }
  });

  it('é determinístico: mesma transição, mesma decisão', () => {
    const action = { kind: 'AGENT_LIFECYCLE_TRANSITION', from: 'ACTIVE', to: 'SLEEP' } as const;
    expect(governor.evaluate(action)).toEqual(governor.evaluate(action));
  });
});
