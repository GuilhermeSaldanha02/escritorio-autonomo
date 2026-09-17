/** Catálogo de papéis, estados e ciclo de vida dos agentes (especificação §6, §7 e §15). */

export const AGENT_ROLES = ['CACADOR', 'DIRETOR', 'DESENVOLVEDOR', 'REVISOR'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const AGENT_STATES = [
  'IDLE',
  'SEARCHING',
  'ANALYZING',
  'THINKING',
  'CODING',
  'TESTING',
  'REVIEWING',
  'WAITING',
  'BLOCKED',
  'SUCCESS',
  'FAILED',
  'SLEEP',
] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/** Rótulo exibido na interface — o estado técnico é o que persiste. */
export const AGENT_STATE_LABELS: Readonly<Record<AgentState, string>> = {
  IDLE: 'OCIOSO',
  SEARCHING: 'PESQUISANDO',
  ANALYZING: 'ANALISANDO',
  THINKING: 'PENSANDO',
  CODING: 'PROGRAMANDO',
  TESTING: 'TESTANDO',
  REVIEWING: 'REVISANDO',
  WAITING: 'AGUARDANDO',
  BLOCKED: 'BLOQUEADO',
  SUCCESS: 'CONCLUIDO',
  FAILED: 'FALHOU',
  SLEEP: 'DORMINDO',
};

export const AGENT_LIFECYCLE_STATUSES = ['PROBATION', 'ACTIVE', 'SLEEP', 'ARCHIVED'] as const;
export type AgentLifecycleStatus = (typeof AGENT_LIFECYCLE_STATUSES)[number];
