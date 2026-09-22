import { INITIAL_AGENTS } from '@escritorio/database';
import {
  AGENT_STATES, officeSnapshotSchema,
  type OfficeSnapshot, type OfficeGovernance, type FinancialScopeSnapshot,
} from '@escritorio/office-contract';
import { projectTimeline, type OfficeSourceEvent } from './timeline.js';
import { projectWorkstations } from './workstations.js';

export interface SourceAgent {
  id: string;
  role: string;
  lifecycleStatus: string;
  state: string;
  displayName?: string;
  responsibility?: string;
}
export interface SourceTask {
  id: string;
  status: string;
  assignedAgentId: string | null;
  retryCount: number;
  objective?: string;
}
export interface SourcePause {
  jobName: string;
  entityId: string;
  resumedAt: string | null;
}
export interface OfficeProjectionInput {
  observedAt: string;
  agents: SourceAgent[];
  tasks: SourceTask[];
  events: OfficeSourceEvent[];
  reviewEvidence?: OfficeSourceEvent[];
  pauses: SourcePause[];
  governance: OfficeGovernance | null;
  financial: { real: FinancialScopeSnapshot | null; simulation: FinancialScopeSnapshot | null };
}

const knownRoles = new Set(['CACADOR', 'DIRETOR', 'DESENVOLVEDOR', 'REVISOR']);
const knownLifecycle = new Set(['PROBATION', 'ACTIVE', 'SLEEP', 'ARCHIVED']);
const knownStates = new Set<string>(AGENT_STATES);
const publicId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const publicFounders = new Map(INITIAL_AGENTS.map(agent => [agent.id, agent]));

export function projectOfficeSnapshot(input: OfficeProjectionInput): OfficeSnapshot {
  const activeIds = new Set(input.agents.filter(agent => agent.lifecycleStatus !== 'ARCHIVED').map(agent => agent.id));
  const workstations = projectWorkstations(activeIds);
  const deskByAgent = new Map(workstations.filter(desk => desk.assignedAgentId).map(desk => [desk.assignedAgentId!, desk.id]));
  const agents = input.agents.filter(agent => publicId.test(agent.id)).map(agent => {
    const role = knownRoles.has(agent.role) ? agent.role : 'OUTRO';
    const founder = publicFounders.get(agent.id);
    const eligible = agent.role === 'DESENVOLVEDOR'
      ? input.tasks.filter(task => task.assignedAgentId === agent.id && task.status === 'IN_PROGRESS')
      : agent.role === 'REVISOR'
        ? input.tasks.filter(task => task.status === 'IN_REVIEW' && (input.reviewEvidence ?? input.events).some(event =>
          event.taskId === task.id && event.agentId === agent.id &&
          (event.type === 'REVIEW_STARTED' || (event.type === 'AGENT_STATE_CHANGED' && event.applied === true && event.newState === 'REVIEWING'))))
        : [];
    const candidate = eligible.length === 1 ? eligible[0]! : null;
    const paused = candidate !== null && input.pauses.some(pause => pause.entityId === candidate.id &&
      pause.jobName === (agent.role === 'REVISOR' ? 'review-task' : 'develop-task') && pause.resumedAt === null);
    const currentTask = candidate && !paused && publicId.test(candidate.id) ? {
      id: candidate.id,
      objective: `Tarefa ${candidate.id} em ${candidate.status.replaceAll('_', ' ').toLowerCase()}.`,
      status: candidate.status,
      retryCount: candidate.retryCount,
      startedAt: null,
    } : null;
    return {
      id: agent.id,
      displayName: founder?.displayName ?? agent.id,
      role: role as OfficeSnapshot['agents'][number]['role'],
      responsibility: founder?.responsibility ?? role,
      lifecycleStatus: (knownLifecycle.has(agent.lifecycleStatus) ? agent.lifecycleStatus : 'ARCHIVED') as OfficeSnapshot['agents'][number]['lifecycleStatus'],
      state: (knownStates.has(agent.state) ? agent.state : 'UNKNOWN') as OfficeSnapshot['agents'][number]['state'],
      stateSince: null,
      ...(deskByAgent.has(agent.id) ? { workstationId: deskByAgent.get(agent.id)! } : {}),
      currentTask,
      metadata: { quality: eligible.length > 1 ? 'AMBIGUOUS' as const : 'REPORTED' as const, availability: paused ? 'PAUSED' as const : 'REPORTED' as const },
    };
  });
  const governance = input.governance ?? { autonomyEnabled: null, autoSpendEnabled: null, emergencyStop: null, circuitBreaker: null, breakers: null, configurationSource: 'API' as const };
  return officeSnapshotSchema.parse({
    mode: 'LIVE', generatedAt: input.observedAt, agents, workstations,
    financial: input.financial, governance, timeline: projectTimeline(input.events),
    metadata: { observedAt: input.observedAt, connection: 'LIVE', sections: {
      agents: 'REPORTED', workstations: 'REPORTED',
      financial: input.financial.real && input.financial.simulation ? 'REPORTED' : 'UNAVAILABLE',
      governance: governance.emergencyStop !== null && governance.circuitBreaker !== null ? 'REPORTED' : 'UNAVAILABLE',
      timeline: 'REPORTED',
    } },
  });
}
