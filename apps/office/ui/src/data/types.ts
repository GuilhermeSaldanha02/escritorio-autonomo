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
  'UNKNOWN',
] as const;

export type AgentState = (typeof AGENT_STATES)[number];
export type AgentRole = 'CACADOR' | 'DIRETOR' | 'DESENVOLVEDOR' | 'REVISOR' | 'OUTRO';
export type AgentLifecycleStatus = 'PROBATION' | 'ACTIVE' | 'SLEEP' | 'ARCHIVED';
export type LedgerScope = 'REAL' | 'SIMULATION';
export type CircuitBreakerStatus = 'CLOSED' | 'OPEN' | 'HALF_OPEN' | 'PLANNED';

export interface CurrentTaskSummary {
  id: string;
  objective: string;
  status: string;
  retryCount: number;
  startedAt: string;
}

export interface OfficeAgent {
  id: string;
  displayName: string;
  role: AgentRole;
  responsibility: string;
  lifecycleStatus: AgentLifecycleStatus;
  state: AgentState;
  stateSince: string;
  workstationId?: string;
  currentTask: CurrentTaskSummary | null;
}

export interface OfficeWorkstation {
  id: string;
  roomId: string;
  status: 'OCCUPIED' | 'EMPTY';
  assignedAgentId: string | null;
}

export interface FinancialScopeSnapshot {
  cashCents: number;
  reserveCents: number;
  operationsCents: number;
  expansionCents: number;
}

export interface OfficeTimelineEvent {
  id: string;
  type: string;
  occurredAt: string;
  agentId?: string;
  summary: string;
  untrustedExternal?: string;
}

export interface OfficeEvent {
  type: 'SNAPSHOT_UPDATED' | 'TIMELINE_APPENDED';
}

export interface OfficeSnapshot {
  mode: 'DEMO';
  generatedAt: string;
  agents: OfficeAgent[];
  workstations: OfficeWorkstation[];
  financial: {
    real: FinancialScopeSnapshot;
    simulation: FinancialScopeSnapshot;
  };
  governance: {
    autonomyEnabled: boolean;
    autoSpendEnabled: boolean;
    emergencyStop: boolean;
    circuitBreaker: CircuitBreakerStatus;
  };
  timeline: OfficeTimelineEvent[];
}

export type OfficeEventHandler = (event: OfficeEvent) => void;
export type Unsubscribe = () => void;
