import { describe, expect, it } from 'vitest';
import { Governor, loadConstitution } from '@escritorio/governor';
import { authorizeExecution, decide, type OpportunityFound } from '@escritorio/agents';

const governor = new Governor(loadConstitution());

function opportunity(overrides: Partial<OpportunityFound> = {}): OpportunityFound {
  return {
    source: 'github-bounties',
    source_url: 'https://example.com/bounty/1',
    title: 'Corrigir bug de paginação',
    reward: { amount: 200, currency: 'BRL' },
    reward_verified: true,
    requirements: ['corrigir o bug', 'adicionar teste'],
    ai_allowed: true,
    automation_allowed: true,
    payment_method: 'pix',
    evidence: ['https://example.com/evidencia'],
    confidence: 0.9,
    ...overrides,
  };
}

describe('decide (Diretor)', () => {
  it('rejeita quando a fonte não permite automação', () => {
    const result = decide(opportunity({ automation_allowed: false }));
    expect(result.decision).toBe('REJECT');
    expect(result.score).toBe(0);
  });

  it('manda para backlog quando a recompensa ainda não foi verificada', () => {
    const result = decide(opportunity({ reward_verified: false }));
    expect(result.decision).toBe('BACKLOG');
  });

  it('executa com alta confiança e recompensa verificada', () => {
    const result = decide(opportunity({ confidence: 0.95, reward: { amount: 300, currency: 'BRL' } }));
    expect(result.decision).toBe('EXECUTE');
    expect(result.estimated_cost).toBe(0);
    expect(result.risk).toBe('LOW');
  });

  it('investiga com sinal misto', () => {
    const result = decide(opportunity({ confidence: 0.6, reward: { amount: 100, currency: 'BRL' } })); // score = 0.6*0.7 + (100/500)*0.3 = 0.48
    expect(result.decision).toBe('INVESTIGATE');
  });

  it('mesma entrada produz sempre a mesma decisão (determinístico)', () => {
    const input = opportunity();
    expect(decide(input)).toEqual(decide(input));
  });

  it('marca risco médio quando IA não é permitida pela fonte', () => {
    const result = decide(opportunity({ ai_allowed: false, confidence: 0.95 }));
    expect(result.risk).toBe('MEDIUM');
  });
});

describe('authorizeExecution (segundo portão do Governor)', () => {
  it('nega quando a decisão não é EXECUTE, mesmo sem capacidade nenhuma', () => {
    const decision = decide(opportunity({ reward_verified: false }));
    expect(authorizeExecution(decision, governor)).toMatchObject({ allowed: false, rule: 'NOT_EXECUTE' });
  });

  it('autoriza EXECUTE sem capacidades exigidas', () => {
    const decision = decide(opportunity({ confidence: 0.95 }));
    expect(decision.decision).toBe('EXECUTE');
    expect(authorizeExecution(decision, governor)).toEqual({ allowed: true });
  });

  it('bloqueia EXECUTE que exigisse uma capacidade proibida — Governor tem a palavra final', () => {
    const decision = decide(opportunity({ confidence: 0.95 }), { requiredCapabilities: ['TRADING'] });
    expect(decision.decision).toBe('EXECUTE'); // o Diretor propõe...
    expect(authorizeExecution(decision, governor)).toMatchObject({ allowed: false, rule: 'ALLOW_TRADING' }); // ...o Governor dispõe.
  });
});
