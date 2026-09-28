import palette from '../../../../../assets/office/palette.json';

export type VisualCategory =
  | 'IDLE'
  | 'SEARCHING'
  | 'ANALYZING'
  | 'WORKING'
  | 'WAITING'
  | 'BLOCKED'
  | 'COMPLETED'
  | 'FAILED'
  | 'SLEEPING'
  | 'UNKNOWN';

export interface VisualState {
  state: keyof typeof palette.states;
  label: string;
  category: VisualCategory;
  color: string;
  animation: 'idle' | 'scan' | 'think' | 'type' | 'wait' | 'alert' | 'celebrate' | 'sleep' | 'unknown';
}

const ANIMATIONS: Record<keyof typeof palette.states, VisualState['animation']> = {
  IDLE: 'idle',
  SEARCHING: 'scan',
  ANALYZING: 'think',
  THINKING: 'think',
  CODING: 'type',
  TESTING: 'type',
  REVIEWING: 'think',
  WAITING: 'wait',
  BLOCKED: 'alert',
  SUCCESS: 'celebrate',
  FAILED: 'alert',
  SLEEP: 'sleep',
  UNKNOWN: 'unknown',
};

export function visualStateResolver(rawState: unknown): VisualState {
  const state = typeof rawState === 'string' && rawState in palette.states
    ? rawState as keyof typeof palette.states
    : 'UNKNOWN';
  const entry = palette.states[state];

  return {
    state,
    label: entry.label,
    category: entry.category as VisualCategory,
    color: entry.color,
    animation: ANIMATIONS[state],
  };
}
