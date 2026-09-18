import { type Pool, type Queryable, withTransaction } from '@escritorio/database';
import { EventStore } from '@escritorio/events';
import type { Governor } from '@escritorio/governor';
import type { AutonomyController } from './autonomy-controller.js';
import {
  decideLifecycle,
  type LifecycleInput,
  type LifecycleStatus,
  type PauseInterval,
  pauseIntervals,
  type PerformanceAction,
  type WindowAssessment,
} from './lifecycle-policy.js';
import { resumePausedWork } from './paused-work.js';

const LIFECYCLE_STATUSES: readonly string[] = ['PROBATION', 'ACTIVE', 'SLEEP'];
/** Quantas avaliações recentes carregar: mais que o maior número de janelas consecutivas exigido. */
const WINDOWS_TO_LOAD = 10;

export interface LifecycleServiceDeps {
  pool: Pool;
  governor: Governor;
  controller: AutonomyController;
  /** Tentativas dos jobs retomados quando um agente acorda. */
  resumeAttempts: number;
}

export type LifecycleActor = 'LIFECYCLE_CONTROLLER' | 'FOUNDER';

export interface LifecycleResult {
  agentId: string;
  outcome: 'TRANSITIONED' | 'NONE';
  from?: LifecycleStatus;
  to?: LifecycleStatus;
  /** Motivo da transição, ou o porquê de não haver uma (inclusive o portão que negou). */
  reason: string;
}

const EVENT_FOR: Record<string, 'AGENT_ACTIVATED' | 'AGENT_SLEEP' | 'AGENT_WOKE'> = {
  'PROBATION>ACTIVE': 'AGENT_ACTIVATED',
  'ACTIVE>SLEEP': 'AGENT_SLEEP',
  'SLEEP>ACTIVE': 'AGENT_WOKE',
};

interface AgentRow {
  id: string;
  role: string;
  lifecycle_status: string;
}

/**
 * ÚNICO escritor de `agents.lifecycle_status` (um teste de arquitetura garante).
 * Aplica as decisões da política pura, sempre sob autorização do Governor, e cada
 * transição deixa uma linha append-only com a evidência (ids das avaliações de
 * `AgentPerformance`) e um evento. O M6 não arquiva, cria nem remove agente: a
 * autorização do Governor e o CHECK do banco negam ARCHIVED.
 *
 * Um humano também acorda ou dorme um agente, mas POR AQUI (`applyManual`), nunca
 * escrevendo na coluna: as mesmas regras, o mesmo histórico.
 */
export class LifecycleService {
  constructor(private readonly deps: LifecycleServiceDeps) {}

  async evaluateAll(now: Date): Promise<LifecycleResult[]> {
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `SELECT id FROM agents WHERE lifecycle_status = ANY($1) ORDER BY id`,
      [LIFECYCLE_STATUSES],
    );
    const results: LifecycleResult[] = [];
    for (const row of rows) results.push(await this.evaluateAgent(row.id, now));
    return results;
  }

  async evaluateAgent(agentId: string, now: Date): Promise<LifecycleResult> {
    const { pool, governor } = this.deps;
    const agent = await this.#loadAgent(pool, agentId);
    if (!agent || !LIFECYCLE_STATUSES.includes(agent.lifecycle_status)) {
      return { agentId, outcome: 'NONE', reason: 'AGENTE_FORA_DO_LIFECYCLE_AUTOMATICO' };
    }
    const current = agent.lifecycle_status as LifecycleStatus;
    const a = governor.autonomy;

    const [windows, pauses, last, hasEligibleDemand] = await Promise.all([
      this.#loadWindows(agentId),
      this.#loadPauses(agentId, now),
      this.#loadLastTransition(agentId),
      current === 'SLEEP' ? this.#hasEligibleDemand(agent) : Promise.resolve(false),
    ]);

    const input: LifecycleInput = {
      current,
      windows,
      pauses,
      lastTransitionAt: last?.occurredAt,
      sleepingSince: last?.toStatus === 'SLEEP' ? last.occurredAt : undefined,
      hasEligibleDemand,
      now,
      params: {
        minSample: a.LIFECYCLE_MIN_SAMPLE,
        promoteConsecutiveWindows: a.LIFECYCLE_PROMOTE_CONSECUTIVE_WINDOWS,
        sleepConsecutiveBadWindows: a.LIFECYCLE_SLEEP_CONSECUTIVE_BAD_WINDOWS,
        transitionCooldownMs: a.LIFECYCLE_TRANSITION_COOLDOWN_HOURS * 3_600_000,
        sleepMinDurationMs: a.SLEEP_MIN_DURATION_HOURS * 3_600_000,
      },
    };

    const decision = decideLifecycle(input);
    if (decision.action === 'NONE') return { agentId, outcome: 'NONE', reason: decision.reason };
    return this.#apply(agentId, current, decision.to, decision.reason, 'LIFECYCLE_CONTROLLER', decision.evidenceWindowIds);
  }

  /** Transição pedida por um humano: as mesmas autorizações e o mesmo histórico, com o ator FOUNDER. */
  async applyManual(agentId: string, to: LifecycleStatus, reason: string): Promise<LifecycleResult> {
    const agent = await this.#loadAgent(this.deps.pool, agentId);
    if (!agent || !LIFECYCLE_STATUSES.includes(agent.lifecycle_status)) {
      return { agentId, outcome: 'NONE', reason: 'AGENTE_FORA_DO_LIFECYCLE_AUTOMATICO' };
    }
    return this.#apply(agentId, agent.lifecycle_status as LifecycleStatus, to, reason, 'FOUNDER', []);
  }

  async #apply(
    agentId: string,
    from: LifecycleStatus,
    to: LifecycleStatus,
    reason: string,
    actor: LifecycleActor,
    evidenceWindowIds: readonly string[],
  ): Promise<LifecycleResult> {
    const { pool, controller } = this.deps;

    // Autorização: Emergency Stop (nada mutável com ele engajado) e o Governor (só as três transições do M6).
    const authorization = await controller.authorize({ origin: 'DIRECT', governed: { kind: 'AGENT_LIFECYCLE_TRANSITION', from, to } });
    if (!authorization.allowed) {
      return { agentId, outcome: 'NONE', from, to, reason: authorization.gate === 'GOVERNOR' ? authorization.rule : authorization.gate };
    }

    const applied = await withTransaction(pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`lifecycle:${agentId}`]);
      // Só aplica se o estado ainda é o que a decisão viu: duas avaliações concorrentes nunca transicionam duas vezes.
      const { rows } = await tx.query<{ id: string }>(
        `UPDATE agents SET lifecycle_status = $2 WHERE id = $1 AND lifecycle_status = $3 RETURNING id`,
        [agentId, to, from],
      );
      if (rows.length === 0) return false;

      await tx.query(
        `INSERT INTO agent_lifecycle_transitions (agent_id, from_status, to_status, reason, evidence, actor)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [agentId, from, to, reason, JSON.stringify(evidenceWindowIds), actor],
      );
      await new EventStore(tx).append({
        type: EVENT_FOR[`${from}>${to}`] ?? 'AGENT_WOKE',
        payload: { agentId, from, to, reason, actor, evidence: [...evidenceWindowIds] },
        agentId,
      });
      return true;
    });

    if (!applied) return { agentId, outcome: 'NONE', from, to, reason: 'ESTADO_MUDOU_ENQUANTO_DECIDIA' };
    // Um agente que acorda pode ter trabalho pausado esperando por ele: retoma pelo outbox, com identidade idempotente.
    if (from === 'SLEEP' && to === 'ACTIVE') await resumePausedWork(pool, this.deps.resumeAttempts);
    return { agentId, outcome: 'TRANSITIONED', from, to, reason };
  }

  async #loadAgent(db: Queryable, agentId: string): Promise<AgentRow | undefined> {
    const { rows } = await db.query<AgentRow>(`SELECT id, role, lifecycle_status FROM agents WHERE id = $1`, [agentId]);
    return rows[0];
  }

  async #loadWindows(agentId: string): Promise<WindowAssessment[]> {
    const { rows } = await this.deps.pool.query<{
      id: string;
      window_from: Date;
      window_to: Date;
      sample_size: number;
      recommended_action: PerformanceAction;
    }>(
      `SELECT id, window_from, window_to, sample_size, recommended_action
         FROM agent_performance WHERE agent_id = $1 ORDER BY window_to DESC LIMIT $2`,
      [agentId, WINDOWS_TO_LOAD],
    );
    return rows.map((row) => ({
      id: row.id,
      windowFrom: row.window_from,
      windowTo: row.window_to,
      sampleSize: row.sample_size,
      recommendedAction: row.recommended_action,
    }));
  }

  /** Períodos em que o agente esteve pausado: Emergency Stop (a empresa toda) e circuito aberto do próprio agente. */
  async #loadPauses(agentId: string, now: Date): Promise<PauseInterval[]> {
    const { pool } = this.deps;
    const [stop, circuit] = await Promise.all([
      pool.query<{ kind: string; occurred_at: Date }>(`SELECT kind, occurred_at FROM emergency_stop_events ORDER BY seq`),
      pool.query<{ event_type: string; occurred_at: Date }>(
        `SELECT event_type, occurred_at FROM circuit_breaker_events WHERE scope_type = 'AGENT' AND scope_key = $1 ORDER BY seq`,
        [agentId],
      ),
    ]);
    return [
      ...pauseIntervals(stop.rows.map((r) => ({ type: r.kind, at: r.occurred_at })), ['ENGAGED'], ['RELEASED'], now),
      // HALF_OPEN continua pausado: o circuito só termina em CLOSED.
      ...pauseIntervals(circuit.rows.map((r) => ({ type: r.event_type, at: r.occurred_at })), ['OPENED'], ['CLOSED'], now),
    ];
  }

  async #loadLastTransition(agentId: string): Promise<{ toStatus: string; occurredAt: Date } | undefined> {
    const { rows } = await this.deps.pool.query<{ to_status: string; occurred_at: Date }>(
      `SELECT to_status, occurred_at FROM agent_lifecycle_transitions WHERE agent_id = $1 ORDER BY seq DESC LIMIT 1`,
      [agentId],
    );
    return rows[0] ? { toStatus: rows[0].to_status, occurredAt: rows[0].occurred_at } : undefined;
  }

  /**
   * Há trabalho realmente ATRIBUÍVEL a este agente esperando por ele? Não basta existir
   * demanda para o papel em geral. O Caçador não tem: a descoberta nasce do Scheduler, e
   * quem o acorda é um humano.
   */
  async #hasEligibleDemand(agent: AgentRow): Promise<boolean> {
    const { pool } = this.deps;
    const exists = async (sql: string, params: unknown[] = []): Promise<boolean> => {
      const { rows } = await pool.query<{ found: boolean }>(`SELECT EXISTS (${sql}) AS found`, params);
      return rows[0]!.found;
    };
    switch (agent.role) {
      case 'DESENVOLVEDOR':
        return exists(`SELECT 1 FROM tasks WHERE assigned_agent_id = $1 AND status IN ('ASSIGNED', 'IN_PROGRESS')`, [agent.id]);
      case 'REVISOR':
        return exists(`SELECT 1 FROM tasks WHERE status IN ('IMPLEMENTATION_READY', 'IN_REVIEW')`);
      case 'DIRETOR':
        return exists(`SELECT 1 FROM opportunities WHERE status IN ('VERIFIED', 'EVALUATING')`);
      default:
        return false;
    }
  }
}
