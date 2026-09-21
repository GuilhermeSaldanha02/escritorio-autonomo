import type { OfficeSnapshot } from '../ui/src/data/types.js';

// Fixture local e read-only do M7-UI. Não representa estado operacional real.
export const OFFICE_DEMO_FIXTURE: { snapshot: OfficeSnapshot } = {
  snapshot: {
    mode: 'DEMO',
    generatedAt: '2026-09-21T12:00:00.000Z',
    agents: [
      { id: 'CACADOR-001', displayName: 'Caçador', role: 'CACADOR', responsibility: 'Pesquisa de oportunidades públicas', lifecycleStatus: 'ACTIVE', state: 'SEARCHING', stateSince: '2026-09-21T11:42:00.000Z', workstationId: 'desk-pros-01', currentTask: { id: 'task-pros-01', objective: 'Mapear oportunidades públicas', status: 'IN_PROGRESS', retryCount: 0, startedAt: '2026-09-21T11:42:00.000Z' } },
      { id: 'DIRETOR-001', displayName: 'Diretor', role: 'DIRETOR', responsibility: 'Priorização e governança', lifecycleStatus: 'ACTIVE', state: 'ANALYZING', stateSince: '2026-09-21T11:48:00.000Z', workstationId: 'desk-board-01', currentTask: { id: 'task-dir-01', objective: 'Avaliar proposta de oportunidade', status: 'IN_REVIEW', retryCount: 0, startedAt: '2026-09-21T11:48:00.000Z' } },
      { id: 'DESENVOLVEDOR-001', displayName: 'Desenvolvedor', role: 'DESENVOLVEDOR', responsibility: 'Implementação em sandbox', lifecycleStatus: 'ACTIVE', state: 'CODING', stateSince: '2026-09-21T11:29:00.000Z', workstationId: 'desk-eng-01', currentTask: { id: 'task-dev-01', objective: 'Implementar parser seguro de JSON', status: 'IN_PROGRESS', retryCount: 0, startedAt: '2026-09-21T11:29:00.000Z' } },
      { id: 'REVISOR-001', displayName: 'Revisor', role: 'REVISOR', responsibility: 'Auditoria independente e testes', lifecycleStatus: 'ACTIVE', state: 'WAITING', stateSince: '2026-09-21T11:55:00.000Z', workstationId: 'desk-qa-01', currentTask: null },
    ],
    workstations: [
      { id: 'desk-pros-01', roomId: 'room-prospecting', status: 'OCCUPIED', assignedAgentId: 'CACADOR-001' },
      { id: 'desk-pros-02', roomId: 'room-prospecting', status: 'EMPTY', assignedAgentId: null },
      { id: 'desk-board-01', roomId: 'room-boardroom', status: 'OCCUPIED', assignedAgentId: 'DIRETOR-001' },
      { id: 'desk-board-02', roomId: 'room-boardroom', status: 'EMPTY', assignedAgentId: null },
      { id: 'desk-eng-01', roomId: 'room-engineering', status: 'OCCUPIED', assignedAgentId: 'DESENVOLVEDOR-001' },
      { id: 'desk-eng-02', roomId: 'room-engineering', status: 'EMPTY', assignedAgentId: null },
      { id: 'desk-eng-03', roomId: 'room-engineering', status: 'EMPTY', assignedAgentId: null },
      { id: 'desk-qa-01', roomId: 'room-qa-review', status: 'OCCUPIED', assignedAgentId: 'REVISOR-001' },
      { id: 'desk-qa-02', roomId: 'room-qa-review', status: 'EMPTY', assignedAgentId: null },
    ],
    financial: {
      real: { cashCents: 184_250, reserveCents: 55_275, operationsCents: 92_125, expansionCents: 36_850 },
      simulation: { cashCents: 246_000, reserveCents: 73_800, operationsCents: 123_000, expansionCents: 49_200 },
    },
    governance: { autonomyEnabled: true, autoSpendEnabled: false, emergencyStop: false, circuitBreaker: 'CLOSED' },
    timeline: [
      { id: 'evt-001', type: 'AGENT_STATE_CHANGED', occurredAt: '2026-09-21T11:55:00.000Z', agentId: 'REVISOR-001', summary: 'Revisor aguardando próxima tarefa.' },
      { id: 'evt-002', type: 'OPPORTUNITY_FOUND', occurredAt: '2026-09-21T11:42:00.000Z', agentId: 'CACADOR-001', summary: 'Oportunidade identificada em fonte pública.', untrustedExternal: '<img src=x onerror=alert(1)> Fix memory leak in stream processor' },
      { id: 'evt-003', type: 'TASK_STARTED', occurredAt: '2026-09-21T11:29:00.000Z', agentId: 'DESENVOLVEDOR-001', summary: 'Tarefa de implementação iniciada.' },
    ],
  },
};
