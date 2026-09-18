import type { LifecycleService, RecoveryService, ScheduleAction, ScheduleName } from '@escritorio/autonomy';
import type { Pool } from '@escritorio/database';
import { EventBus, EventStore, JOB_NAMES, QUEUE_NAMES } from '@escritorio/events';
import { reconcileFromDatabase } from '@escritorio/finance';
import type { Governor } from '@escritorio/governor';
import { recordAgentPerformance } from '@escritorio/memory';

export interface ScheduleActionDeps {
  pool: Pool;
  governor: Governor;
  recovery: RecoveryService;
  lifecycle: LifecycleService;
}

/**
 * O que cada agenda faz quando o Scheduler a dispara (M6, critério 1). As ações só
 * ENFILEIRAM ou registram: o trabalho em si continua nos handlers de sempre, e tudo é
 * idempotente pela identidade da janela, então repetir uma ação nunca duplica efeito.
 */
export function createScheduleActions({ pool, governor, recovery, lifecycle }: ScheduleActionDeps): Record<ScheduleName, ScheduleAction> {
  const attempts = governor.limits.MAX_TASK_RETRIES + 1;

  return {
    // Descoberta: evento e job na mesma transação (outbox). O job passa pelo portão de jobs como qualquer outro.
    DISCOVERY: async (run) => {
      const correlationId = crypto.randomUUID();
      await new EventBus(pool).publish(
        { type: 'SCHEDULE_TICK_DISPATCHED', payload: { schedule: run.schedule, windowKey: run.windowKey }, correlationId, idempotencyKey: `schedule:${run.windowKey}` },
        {
          queue: QUEUE_NAMES.ORCHESTRATOR,
          jobName: JOB_NAMES.DISCOVER_OPPORTUNITIES,
          data: () => ({ correlationId }),
          attempts,
          jobId: `scheduled-${run.windowKey}`,
        },
      );
    },

    // Reconciliação só DETECTA (M5): registra o relatório como evento e nunca repara dinheiro.
    RECONCILIATION: async (run) => {
      const report = await reconcileFromDatabase(pool);
      await new EventStore(pool).append({
        type: 'RECONCILIATION_REPORTED',
        payload: {
          windowKey: run.windowKey,
          status: report.status,
          issueCount: report.issues.length,
          issueCodes: [...new Set(report.issues.map((issue) => issue.code))],
        },
        idempotencyKey: `reconciliation:${run.windowKey}`,
      });
    },

    // Avalia a janela ANTERIOR, já completa: [início da janela atual - intervalo, início da janela atual).
    PERFORMANCE_WINDOW: async (run) => {
      const to = run.windowStart;
      const from = new Date(to.getTime() - run.intervalMs);
      const { rows } = await pool.query<{ id: string }>(`SELECT id FROM agents WHERE lifecycle_status IN ('PROBATION', 'ACTIVE', 'SLEEP') ORDER BY id`);
      for (const agent of rows) await recordAgentPerformance(pool, agent.id, { from: from.toISOString(), to: to.toISOString() });
    },

    RECOVERY_SWEEP: async (run) => {
      await recovery.sweep(run.now);
    },

    LIFECYCLE_EVALUATION: async (run) => {
      await lifecycle.evaluateAll(run.now);
    },
  };
}
