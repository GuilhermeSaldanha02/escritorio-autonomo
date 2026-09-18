/**
 * Circuit breaker por ESCOPO (M6-PLANO.md, critérios 10 a 12). Lógica pura: o
 * estado é a dobra dos eventos do escopo, nunca uma coluna mutável. O tempo
 * entra como parâmetro, então os testes são determinísticos.
 *
 * Um circuito aberto bloqueia só o seu escopo (a fonte GitHub não para o
 * Desenvolvedor nem a empresa) e nunca aciona o Emergency Stop.
 */
export const CIRCUIT_SCOPE_TYPES = ['SOURCE', 'AGENT'] as const;
export type CircuitScopeType = (typeof CIRCUIT_SCOPE_TYPES)[number];

export interface CircuitScope {
  type: CircuitScopeType;
  key: string;
}

export type CircuitEventType = 'FAILURE' | 'SUCCESS' | 'OPENED' | 'HALF_OPEN' | 'CLOSED';

export interface CircuitEvent {
  type: CircuitEventType;
  at: Date;
}

export type CircuitStatus = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface BreakerState {
  status: CircuitStatus;
  consecutiveFailures: number;
  /** Desfechos (sucesso ou falha) registrados no escopo, para o mínimo de amostra. */
  totalOutcomes: number;
  /** Instante do último OPENED ou HALF_OPEN. */
  since?: Date;
}

export interface BreakerPolicy {
  failureThreshold: number;
  cooldownMs: number;
  /** Mínimo de desfechos antes de o circuito poder abrir (1 = sem mínimo). */
  minSample: number;
}

export const INITIAL_BREAKER_STATE: BreakerState = { status: 'CLOSED', consecutiveFailures: 0, totalOutcomes: 0 };

/** Dobra os eventos do escopo, JÁ em ordem de `seq`, no estado atual. */
export function foldBreaker(events: readonly CircuitEvent[]): BreakerState {
  let state: BreakerState = { ...INITIAL_BREAKER_STATE };
  for (const event of events) {
    switch (event.type) {
      case 'FAILURE':
        state = { ...state, consecutiveFailures: state.consecutiveFailures + 1, totalOutcomes: state.totalOutcomes + 1 };
        break;
      case 'SUCCESS':
        state = { ...state, consecutiveFailures: 0, totalOutcomes: state.totalOutcomes + 1 };
        break;
      case 'OPENED':
        state = { ...state, status: 'OPEN', since: event.at };
        break;
      case 'HALF_OPEN':
        state = { ...state, status: 'HALF_OPEN', since: event.at };
        break;
      case 'CLOSED':
        state = { status: 'CLOSED', consecutiveFailures: 0, totalOutcomes: state.totalOutcomes };
        break;
    }
  }
  return state;
}

export type Admission = 'ADMIT' | 'PROBE' | 'DENY';

/**
 * Decide se uma tentativa entra. `CLOSED` entra; `OPEN` só depois do cooldown,
 * e então como UMA sonda (`PROBE`); `HALF_OPEN` nega enquanto a sonda está em
 * curso, mas uma sonda que nunca reportou (mais velha que o cooldown) libera
 * outra, para o circuito não travar aberto para sempre.
 */
export function admission(state: BreakerState, policy: BreakerPolicy, now: Date): Admission {
  if (state.status === 'CLOSED') return 'ADMIT';
  const elapsedMs = state.since ? now.getTime() - state.since.getTime() : Number.POSITIVE_INFINITY;
  return elapsedMs >= policy.cooldownMs ? 'PROBE' : 'DENY';
}

/** Um circuito CLOSED abre quando as falhas consecutivas chegam ao limiar e há amostra mínima. */
export function shouldOpen(state: BreakerState, policy: BreakerPolicy): boolean {
  return state.status === 'CLOSED' && state.consecutiveFailures >= policy.failureThreshold && state.totalOutcomes >= policy.minSample;
}
