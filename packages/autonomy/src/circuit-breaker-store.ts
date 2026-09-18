import { type Pool, type Queryable, withTransaction } from '@escritorio/database';
import { EventStore } from '@escritorio/events';
import type { Governor } from '@escritorio/governor';
import {
  admission,
  type Admission,
  type BreakerPolicy,
  type BreakerState,
  type CircuitEvent,
  type CircuitEventType,
  type CircuitScope,
  type CircuitScopeType,
  foldBreaker,
  shouldOpen,
} from './circuit-breaker.js';

/** Limiares por tipo de escopo, vindos da Constituição (nunca do código). */
export function breakerPolicyFrom(governor: Governor): (type: CircuitScopeType) => BreakerPolicy {
  const a = governor.autonomy;
  return (type) =>
    type === 'SOURCE'
      ? { failureThreshold: a.SOURCE_CIRCUIT_FAILURE_THRESHOLD, cooldownMs: a.SOURCE_CIRCUIT_COOLDOWN_SECONDS * 1000, minSample: 1 }
      : { failureThreshold: a.AGENT_CIRCUIT_CONSECUTIVE_FAILURES, cooldownMs: a.AGENT_CIRCUIT_COOLDOWN_SECONDS * 1000, minSample: a.AGENT_CIRCUIT_MIN_SAMPLE };
}

/** Uma decisão de admissão nunca lança: ela é lida pelo portão de autonomia, que nega se não conseguir ler. */
export interface BreakerGate {
  admit(scope: CircuitScope, now: Date): Promise<Admission>;
}

async function loadEvents(db: Queryable, scope: CircuitScope): Promise<CircuitEvent[]> {
  const { rows } = await db.query<{ event_type: CircuitEventType; occurred_at: Date }>(
    `SELECT event_type, occurred_at FROM circuit_breaker_events WHERE scope_type = $1 AND scope_key = $2 ORDER BY seq`,
    [scope.type, scope.key],
  );
  return rows.map((row) => ({ type: row.event_type, at: row.occurred_at }));
}

async function append(db: Queryable, scope: CircuitScope, type: CircuitEventType, at: Date, reason?: string): Promise<void> {
  await db.query(
    `INSERT INTO circuit_breaker_events (scope_type, scope_key, event_type, reason, occurred_at) VALUES ($1, $2, $3, $4, $5)`,
    [scope.type, scope.key, type, reason ?? null, at],
  );
}

const EVENT_FOR: Partial<Record<CircuitEventType, 'CIRCUIT_OPENED' | 'CIRCUIT_HALF_OPEN' | 'CIRCUIT_CLOSED'>> = {
  OPENED: 'CIRCUIT_OPENED',
  HALF_OPEN: 'CIRCUIT_HALF_OPEN',
  CLOSED: 'CIRCUIT_CLOSED',
};

/** Registra a transição no histórico do breaker e no Event Bus (o timeline e o Office leem daqui). */
async function transition(tx: Queryable, scope: CircuitScope, type: 'OPENED' | 'HALF_OPEN' | 'CLOSED', at: Date, reason: string): Promise<void> {
  await append(tx, scope, type, at, reason);
  await new EventStore(tx).append({
    type: EVENT_FOR[type]!,
    payload: { scopeType: scope.type, scopeKey: scope.key, reason },
  });
}

/**
 * Circuit breaker persistido, append-only, por escopo. Toda decisão que muda o
 * estado roda sob `pg_advisory_xact_lock` do escopo: duas tentativas
 * concorrentes nunca leem o mesmo estado e ambas viram "a sonda".
 */
export class CircuitBreakerStore implements BreakerGate {
  constructor(
    private readonly pool: Pool,
    private readonly policyFor: (type: CircuitScopeType) => BreakerPolicy,
  ) {}

  async state(scope: CircuitScope): Promise<BreakerState> {
    return foldBreaker(await loadEvents(this.pool, scope));
  }

  /** Decide a entrada. `PROBE` (a única sonda depois do cooldown) já grava o HALF_OPEN, no mesmo passo. */
  async admit(scope: CircuitScope, now: Date): Promise<Admission> {
    return withTransaction(this.pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`circuit:${scope.type}:${scope.key}`]);
      const state = foldBreaker(await loadEvents(tx, scope));
      const decision = admission(state, this.policyFor(scope.type), now);
      if (decision === 'PROBE') await transition(tx, scope, 'HALF_OPEN', now, 'cooldown vencido: uma única sonda');
      return decision;
    });
  }

  /**
   * Registra o desfecho técnico de uma tentativa. Falhas consecutivas até o
   * limiar abrem o circuito; uma sonda em HALF_OPEN que dá certo fecha; uma que
   * falha reabre (o cooldown recomeça).
   */
  async recordOutcome(scope: CircuitScope, outcome: 'SUCCESS' | 'FAILURE', now: Date, reason?: string): Promise<BreakerState> {
    return withTransaction(this.pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`circuit:${scope.type}:${scope.key}`]);
      const policy = this.policyFor(scope.type);
      const before = foldBreaker(await loadEvents(tx, scope));
      await append(tx, scope, outcome, now, reason);

      if (before.status === 'HALF_OPEN') {
        if (outcome === 'SUCCESS') await transition(tx, scope, 'CLOSED', now, 'sonda bem-sucedida');
        else await transition(tx, scope, 'OPENED', now, reason ?? 'sonda falhou');
      } else if (before.status === 'CLOSED' && outcome === 'FAILURE') {
        const after = foldBreaker(await loadEvents(tx, scope));
        if (shouldOpen(after, policy)) {
          await transition(tx, scope, 'OPENED', now, `${after.consecutiveFailures} falhas consecutivas`);
        }
      }
      return foldBreaker(await loadEvents(tx, scope));
    });
  }
}
