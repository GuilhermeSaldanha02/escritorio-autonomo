// src/data/types.ts

/**
 * Types that represent the read‑only projection of the Office.
 * They are derived from the approved M7‑OFFICE‑CONTRACT.
 */
export interface Agent {
  id: string;
  name: string;
  state: string; // one of the 12 visual states or "UNKNOWN"
  workstationId?: string;
  // additional UI‑only fields can be added here
}

export interface Workstation {
  id: string;
  x: number;
  y: number;
  // other layout properties as defined in layout.json
}

export interface Metrics {
  cashReal: number;
  cashSimulated: number;
  reserveReal: number;
  reserveSimulated: number;
  operationsReal: number;
  operationsSimulated: number;
  expansionReal: number;
  expansionSimulated: number;
  // ... other metric fields from the contract
}

export interface OfficeSnapshot {
  agents: Agent[];
  workstations: Workstation[];
  metrics: Metrics;
  // any other projection fields required by the UI (e.g., governor limits, flags)
  autonomyEnabled: boolean;
  autoSpendEnabled: boolean;
  emergencyStop: boolean;
  circuitBreakerActive: boolean;
  // raw fixture timestamp etc.
  generatedAt: string;
}

/** Event emitted for UI updates (e.g., timeline entries). */
export interface OfficeEvent {
  type: string; // e.g., "AGENT_STATE_CHANGED", "METRICS_UPDATED"
  payload: any;
}

/** Callback type for subscribing to events. */
export type OfficeEventHandler = (event: OfficeEvent) => void;

/** Unsubscribe function returned by subscribe. */
export type Unsubscribe = () => void;
