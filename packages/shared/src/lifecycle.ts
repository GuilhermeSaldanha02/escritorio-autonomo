import type { AgentRole } from './agents.js';

/** Ciclo da oportunidade (especificação §11). Transições só por código. */
export const OPPORTUNITY_STATUSES = [
  'DISCOVERED',
  'VERIFYING',
  'VERIFIED',
  'EVALUATING',
  'APPROVED',
  'REJECTED',
  'WORKING',
  'SUBMITTED',
  'ACCEPTED',
  'PAYMENT_PENDING',
  'PAID',
  'EXPIRED',
  'INVALID',
  'ABANDONED',
  'FAILED',
] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

/** Ciclo da tarefa. Revisão reprovada volta a IN_PROGRESS até o limite de retries (§13.4). */
export const TASK_STATUSES = [
  'CREATED',
  'ASSIGNED',
  'IN_PROGRESS',
  'IMPLEMENTATION_READY',
  'IN_REVIEW',
  'COMPLETED',
  'FAILED',
  'BLOCKED',
  'CANCELLED',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Quem pede a transição. Agentes agem pelo papel; fatos externos (aceite,
 * pagamento) só entram por componentes de sistema — nenhum agente declara PAID.
 */
export type Actor =
  | { kind: 'agent'; role: AgentRole }
  | { kind: 'system'; component: 'ORCHESTRATOR' | 'PAYMENT_CONFIRMATION' | 'FOUNDER' };

const ABANDON = ['EXPIRED', 'ABANDONED'] as const;

const OPPORTUNITY_TRANSITIONS: Readonly<Record<OpportunityStatus, readonly OpportunityStatus[]>> = {
  DISCOVERED: ['VERIFYING', 'INVALID', ...ABANDON],
  VERIFYING: ['VERIFIED', 'INVALID', 'FAILED', ...ABANDON],
  VERIFIED: ['EVALUATING', ...ABANDON],
  EVALUATING: ['APPROVED', 'REJECTED', ...ABANDON],
  APPROVED: ['WORKING', ...ABANDON],
  WORKING: ['SUBMITTED', 'FAILED', ...ABANDON],
  SUBMITTED: ['ACCEPTED', 'FAILED', 'EXPIRED'],
  ACCEPTED: ['PAYMENT_PENDING'],
  PAYMENT_PENDING: ['PAID', 'FAILED'],
  PAID: [],
  REJECTED: [],
  EXPIRED: [],
  INVALID: [],
  ABANDONED: [],
  FAILED: [],
};

/** Fatos que só um componente de sistema pode registrar. */
const EXTERNAL_FACTS: ReadonlySet<OpportunityStatus> = new Set(['ACCEPTED', 'PAYMENT_PENDING', 'PAID']);

const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  CREATED: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['IN_PROGRESS', 'BLOCKED', 'CANCELLED'],
  IN_PROGRESS: ['IMPLEMENTATION_READY', 'FAILED', 'BLOCKED', 'CANCELLED'],
  IMPLEMENTATION_READY: ['IN_REVIEW', 'CANCELLED'],
  IN_REVIEW: ['COMPLETED', 'IN_PROGRESS', 'BLOCKED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  BLOCKED: [],
  CANCELLED: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly entity: 'opportunity' | 'task',
    readonly from: string,
    readonly to: string,
    reason: string,
  ) {
    super(`Transição inválida de ${entity}: ${from} → ${to} (${reason})`);
    this.name = 'InvalidTransitionError';
  }
}

function describeActor(actor: Actor): string {
  return actor.kind === 'agent' ? `agente ${actor.role}` : `sistema ${actor.component}`;
}

export function assertOpportunityTransition(from: OpportunityStatus, to: OpportunityStatus, actor: Actor): void {
  if (!OPPORTUNITY_TRANSITIONS[from].includes(to)) {
    throw new InvalidTransitionError('opportunity', from, to, 'não prevista no ciclo §11');
  }
  if (EXTERNAL_FACTS.has(to) && actor.kind === 'agent') {
    throw new InvalidTransitionError('opportunity', from, to, `${describeActor(actor)} não pode declarar fato externo`);
  }
  if (to === 'PAID' && !(actor.kind === 'system' && actor.component === 'PAYMENT_CONFIRMATION')) {
    throw new InvalidTransitionError('opportunity', from, to, 'PAID exige confirmação de pagamento real');
  }
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!TASK_TRANSITIONS[from].includes(to)) {
    throw new InvalidTransitionError('task', from, to, 'não prevista no ciclo da tarefa');
  }
}

export function isTerminalOpportunity(status: OpportunityStatus): boolean {
  return OPPORTUNITY_TRANSITIONS[status].length === 0;
}

export function isTerminalTask(status: TaskStatus): boolean {
  return TASK_TRANSITIONS[status].length === 0;
}
