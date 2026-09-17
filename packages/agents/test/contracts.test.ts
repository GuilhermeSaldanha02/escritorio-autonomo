import { describe, expect, it } from 'vitest';
import {
  directorDecisionSchema,
  opportunityFoundSchema,
  reviewCompletedSchema,
  type DirectorDecision,
  type OpportunityFound,
  type ReviewCompleted,
} from '@escritorio/agents';

describe('OPPORTUNITY_FOUND (§13.1)', () => {
  const valid: OpportunityFound = {
    source: 'github-bounties',
    source_url: 'https://example.com/bounty/1',
    title: 'Corrigir bug',
    reward: { amount: 100, currency: 'BRL' },
    reward_verified: true,
    requirements: ['x'],
    ai_allowed: true,
    automation_allowed: true,
    payment_method: 'pix',
    evidence: ['https://example.com/e'],
    confidence: 0.8,
  };

  it('aceita um payload completo e válido', () => {
    expect(() => opportunityFoundSchema.parse(valid)).not.toThrow();
  });

  it('rejeita URL de fonte inválida', () => {
    expect(() => opportunityFoundSchema.parse({ ...valid, source_url: 'não é url' })).toThrow();
  });

  it('rejeita confiança fora de [0,1]', () => {
    expect(() => opportunityFoundSchema.parse({ ...valid, confidence: 1.5 })).toThrow();
  });

  it('rejeita campo desconhecido (contrato é estrito)', () => {
    expect(() => opportunityFoundSchema.parse({ ...valid, campo_extra: 1 })).toThrow();
  });
});

describe('DIRECTOR_DECISION (§13.2)', () => {
  const valid: DirectorDecision = {
    decision: 'EXECUTE',
    score: 0.8,
    estimated_cost: 0,
    estimated_runtime_minutes: 30,
    risk: 'LOW',
    reasoning_summary: 'ok',
    required_capabilities: [],
  };

  it('aceita um payload válido', () => {
    expect(() => directorDecisionSchema.parse(valid)).not.toThrow();
  });

  it('rejeita decisão fora do enum', () => {
    expect(() => directorDecisionSchema.parse({ ...valid, decision: 'MAYBE' })).toThrow();
  });

  it('rejeita capacidade fora do catálogo do Governor', () => {
    expect(() => directorDecisionSchema.parse({ ...valid, required_capabilities: ['NAO_EXISTE'] })).toThrow();
  });
});

describe('REVIEW_COMPLETED (§13.4)', () => {
  const valid: ReviewCompleted = {
    decision: 'PASSED',
    build: true,
    tests: { total: 1, passed: 1, failed: 0 },
    requirements: [{ description: 'x', met: true }],
    security_flags: [],
    reason: 'ok',
  };

  it('aceita um payload válido', () => {
    expect(() => reviewCompletedSchema.parse(valid)).not.toThrow();
  });

  it('rejeita decisão fora do enum', () => {
    expect(() => reviewCompletedSchema.parse({ ...valid, decision: 'MAYBE' })).toThrow();
  });
});
