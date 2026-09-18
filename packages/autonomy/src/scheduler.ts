import type { Pool } from '@escritorio/database';
import { EventStore } from '@escritorio/events';
import type { Governor } from '@escritorio/governor';
import type { AutonomyController } from './autonomy-controller.js';

export const SCHEDULE_NAMES = ['DISCOVERY', 'RECONCILIATION', 'PERFORMANCE_WINDOW', 'RECOVERY_SWEEP', 'LIFECYCLE_EVALUATION'] as const;
export type ScheduleName = (typeof SCHEDULE_NAMES)[number];

/** Intervalo de cada agenda, em ms, vindo da Constituição e nunca do código. */
export function scheduleIntervalMs(governor: Governor, name: ScheduleName): number {
  const a = governor.autonomy;
  switch (name) {
    case 'DISCOVERY':
      return a.DISCOVERY_INTERVAL_SECONDS * 1000;
    case 'RECONCILIATION':
      return a.RECONCILIATION_INTERVAL_SECONDS * 1000;
    case 'PERFORMANCE_WINDOW':
      return a.PERFORMANCE_WINDOW_HOURS * 3_600_000;
    case 'RECOVERY_SWEEP':
      return a.RECOVERY_SWEEP_INTERVAL_SECONDS * 1000;
    case 'LIFECYCLE_EVALUATION':
      return a.LIFECYCLE_EVALUATION_INTERVAL_SECONDS * 1000;
  }
}

export interface ScheduledRun {
  schedule: ScheduleName;
  /** Identidade lógica da execução: agenda + índice da janela. É a chave `UNIQUE` no Postgres. */
  windowKey: string;
  windowStart: Date;
  intervalMs: number;
  now: Date;
}

export type ScheduleAction = (run: ScheduledRun) => Promise<void>;

export type TickOutcome = 'DISPATCHED' | 'SKIPPED' | 'ALREADY_CLAIMED' | 'FAILED';

export interface TickResult {
  schedule: ScheduleName;
  windowKey: string;
  outcome: TickOutcome;
  /** Motivo do SKIPPED (o portão que negou) ou o erro do FAILED. */
  reason?: string;
}

export interface SchedulerDeps {
  pool: Pool;
  governor: Governor;
  controller: AutonomyController;
  /** O que cada agenda faz. A ação só ENFILEIRA ou registra; o trabalho em si continua nos handlers de sempre. */
  actions: Record<ScheduleName, ScheduleAction>;
}

/**
 * Scheduler determinístico (M6-PLANO.md, critérios 1 a 4). O Postgres é a
 * autoridade da identidade lógica: cada execução agendada é a linha
 * `(schedule_name, window_key)` em `scheduled_executions`, e o `UNIQUE` faz
 * reentrega, dois schedulers e ticks concorrentes produzirem UM efeito só. O
 * BullMQ (ou qualquer laço) só transporta o disparo do `runDue`.
 *
 * Cada janela é reivindicada ANTES de decidir: mesmo negada, ela é avaliada
 * uma única vez e o motivo fica registrado. Tick negado é pausa, não falha.
 * O tempo entra como parâmetro, então os testes não esperam tempo real.
 */
export class Scheduler {
  constructor(private readonly deps: SchedulerDeps) {}

  /** Roda toda agenda cuja janela atual ainda não foi reivindicada. Seguro para chamar a qualquer frequência. */
  async runDue(now: Date): Promise<TickResult[]> {
    const results: TickResult[] = [];
    for (const schedule of SCHEDULE_NAMES) results.push(await this.runTick(schedule, now));
    return results;
  }

  async runTick(schedule: ScheduleName, now: Date): Promise<TickResult> {
    const { pool, governor, controller, actions } = this.deps;
    const intervalMs = scheduleIntervalMs(governor, schedule);
    const windowIndex = Math.floor(now.getTime() / intervalMs);
    const windowKey = `${schedule}:${windowIndex}`;

    const claimed = await pool.query<{ id: string }>(
      `INSERT INTO scheduled_executions (schedule_name, window_key, status)
       VALUES ($1, $2, 'CLAIMED')
       ON CONFLICT (schedule_name, window_key) DO NOTHING
       RETURNING id`,
      [schedule, windowKey],
    );
    const id = claimed.rows[0]?.id;
    if (!id) return { schedule, windowKey, outcome: 'ALREADY_CLAIMED' };

    const decision = await controller.authorize({ origin: 'SCHEDULED' });
    if (!decision.allowed) {
      await pool.query(
        `UPDATE scheduled_executions SET status = 'SKIPPED', skip_reason = $2, updated_at = clock_timestamp() WHERE id = $1`,
        [id, decision.gate],
      );
      // Com a autonomia desligada (o padrão) só a linha fica: um evento por janela seria ruído.
      if (decision.gate !== 'AUTONOMY_DISABLED') {
        await new EventStore(pool).append({
          type: 'SCHEDULE_TICK_SKIPPED',
          payload: { schedule, windowKey, gate: decision.gate, reason: decision.reason },
          idempotencyKey: `tick-skipped:${windowKey}`,
        });
      }
      return { schedule, windowKey, outcome: 'SKIPPED', reason: decision.gate };
    }

    try {
      await actions[schedule]({ schedule, windowKey, windowStart: new Date(windowIndex * intervalMs), intervalMs, now });
      await pool.query(`UPDATE scheduled_executions SET status = 'DISPATCHED', updated_at = clock_timestamp() WHERE id = $1`, [id]);
      return { schedule, windowKey, outcome: 'DISPATCHED' };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await pool.query(
        `UPDATE scheduled_executions SET status = 'FAILED', skip_reason = $2, updated_at = clock_timestamp() WHERE id = $1`,
        [id, reason.slice(0, 500)],
      );
      return { schedule, windowKey, outcome: 'FAILED', reason };
    }
  }
}
