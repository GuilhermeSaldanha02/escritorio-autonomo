import { describe, expect, it } from 'vitest';
import {
  type Actor,
  assertOpportunityTransition,
  assertTaskTransition,
  InvalidTransitionError,
  isTerminalOpportunity,
  isTerminalTask,
  OPPORTUNITY_STATUSES,
  TASK_STATUSES,
} from '@escritorio/shared';

const orchestrator: Actor = { kind: 'system', component: 'ORCHESTRATOR' };
const director: Actor = { kind: 'agent', role: 'DIRETOR' };
const payment: Actor = { kind: 'system', component: 'PAYMENT_CONFIRMATION' };

describe('ciclo da oportunidade (§11)', () => {
  it('aceita o caminho completo até PAID com os atores certos', () => {
    const path = [
      ['DISCOVERED', 'VERIFYING', orchestrator],
      ['VERIFYING', 'VERIFIED', orchestrator],
      ['VERIFIED', 'EVALUATING', director],
      ['EVALUATING', 'APPROVED', director],
      ['APPROVED', 'WORKING', orchestrator],
      ['WORKING', 'SUBMITTED', orchestrator],
      ['SUBMITTED', 'ACCEPTED', payment],
      ['ACCEPTED', 'PAYMENT_PENDING', payment],
      ['PAYMENT_PENDING', 'PAID', payment],
    ] as const;
    for (const [from, to, actor] of path) {
      expect(() => assertOpportunityTransition(from, to, actor)).not.toThrow();
    }
  });

  it('recusa pular etapas', () => {
    expect(() => assertOpportunityTransition('DISCOVERED', 'APPROVED', director)).toThrow(InvalidTransitionError);
    expect(() => assertOpportunityTransition('VERIFIED', 'WORKING', orchestrator)).toThrow(/não prevista/);
  });

  it('nenhum agente declara PAID, nem aceite, nem pagamento pendente', () => {
    for (const role of ['CACADOR', 'DIRETOR', 'DESENVOLVEDOR', 'REVISOR'] as const) {
      const agent: Actor = { kind: 'agent', role };
      expect(() => assertOpportunityTransition('PAYMENT_PENDING', 'PAID', agent)).toThrow(/fato externo/);
      expect(() => assertOpportunityTransition('SUBMITTED', 'ACCEPTED', agent)).toThrow(/fato externo/);
      expect(() => assertOpportunityTransition('ACCEPTED', 'PAYMENT_PENDING', agent)).toThrow(/fato externo/);
    }
  });

  it('PAID exige a confirmação de pagamento, nem o Orquestrador nem o fundador bastam', () => {
    expect(() => assertOpportunityTransition('PAYMENT_PENDING', 'PAID', orchestrator)).toThrow(/pagamento real/);
    expect(() =>
      assertOpportunityTransition('PAYMENT_PENDING', 'PAID', { kind: 'system', component: 'FOUNDER' }),
    ).toThrow(/pagamento real/);
  });

  it('estados finais não saem do lugar', () => {
    const terminals = OPPORTUNITY_STATUSES.filter(isTerminalOpportunity);
    expect(terminals.sort()).toEqual(['ABANDONED', 'EXPIRED', 'FAILED', 'INVALID', 'PAID', 'REJECTED']);
    for (const from of terminals) {
      for (const to of OPPORTUNITY_STATUSES) {
        expect(() => assertOpportunityTransition(from, to, payment)).toThrow(InvalidTransitionError);
      }
    }
  });
});

describe('ciclo da tarefa', () => {
  it('aceita o caminho feliz e o retorno da revisão reprovada', () => {
    const path = [
      ['CREATED', 'ASSIGNED'],
      ['ASSIGNED', 'IN_PROGRESS'],
      ['IN_PROGRESS', 'IMPLEMENTATION_READY'],
      ['IMPLEMENTATION_READY', 'IN_REVIEW'],
      ['IN_REVIEW', 'IN_PROGRESS'],
      ['IN_PROGRESS', 'IMPLEMENTATION_READY'],
      ['IMPLEMENTATION_READY', 'IN_REVIEW'],
      ['IN_REVIEW', 'COMPLETED'],
    ] as const;
    for (const [from, to] of path) expect(() => assertTaskTransition(from, to)).not.toThrow();
  });

  it('não conclui sem passar pela revisão', () => {
    expect(() => assertTaskTransition('IN_PROGRESS', 'COMPLETED')).toThrow(InvalidTransitionError);
    expect(() => assertTaskTransition('IMPLEMENTATION_READY', 'COMPLETED')).toThrow(InvalidTransitionError);
  });

  it('estados finais não saem do lugar', () => {
    const terminals = TASK_STATUSES.filter(isTerminalTask);
    expect(terminals.sort()).toEqual(['BLOCKED', 'CANCELLED', 'COMPLETED', 'FAILED']);
    for (const from of terminals) {
      for (const to of TASK_STATUSES) expect(() => assertTaskTransition(from, to)).toThrow(InvalidTransitionError);
    }
  });
});
