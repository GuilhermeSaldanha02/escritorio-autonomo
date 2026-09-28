/** O contrato de transporte é browser-safe; eventos locais são outra coisa. */
import type { OfficeAgent as ContractAgent, OfficeSnapshot as ContractSnapshot } from '@escritorio/office-contract';
export type { OfficeWorkstation, OfficeTimelineEvent, FinancialScopeSnapshot, AgentState, AgentRole, AgentLifecycleStatus } from '@escritorio/office-contract';
export { AGENT_STATES } from '@escritorio/office-contract';

/** Fixtures legadas podem omitir metadata por agente; LIVE sempre a valida. */
export type OfficeAgent = Omit<ContractAgent, 'metadata'> & { metadata?: ContractAgent['metadata'] };
export type OfficeSnapshot = Omit<ContractSnapshot, 'agents'> & { agents: OfficeAgent[] };

export interface OfficeEvent {
  type: 'SNAPSHOT_UPDATED' | 'TIMELINE_APPENDED';
}
export type OfficeEventHandler = (event: OfficeEvent) => void;
export type Unsubscribe = () => void;
