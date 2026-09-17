import { type Job, UnrecoverableError } from 'bullmq';
import { diagnosticJobSchema, type EventStore } from '@escritorio/events';
import type { GovernedAction, Governor } from '@escritorio/governor';
import type { Logger } from '@escritorio/shared';

export type DiagnosticResult =
  | { outcome: 'COMPLETED'; eventId: string }
  | { outcome: 'BLOCKED'; eventId: string; rule: string };

interface Deps {
  store: EventStore;
  governor: Governor;
  logger: Logger;
}

/**
 * Processa o job de diagnóstico. Toda escrita usa chave de idempotência
 * derivada do jobId: um retry do BullMQ reencontra o mesmo evento em vez de
 * duplicá-lo.
 */
export function createDiagnosticProcessor({ store, governor, logger }: Deps) {
  return async function processDiagnostic(job: Job): Promise<DiagnosticResult> {
    const parsed = diagnosticJobSchema.safeParse(job.data);
    if (!parsed.success) {
      // Payload inválido não melhora com retry.
      throw new UnrecoverableError(`Dados inválidos no job ${job.id}: ${parsed.error.message}`);
    }
    if (job.id === undefined) {
      throw new UnrecoverableError('Job sem id: impossível garantir idempotência');
    }
    const data = parsed.data;
    const log = logger.child({ jobId: job.id, correlationId: data.correlationId });

    if (data.requestedCapability) {
      const action: GovernedAction = { kind: 'CAPABILITY', capability: data.requestedCapability };
      const decision = governor.evaluate(action);
      if (!decision.allowed) {
        // Modo autônomo (§10): registrar ACTION_BLOCKED, pular e continuar — sem contornar a regra.
        const { event } = await store.append({
          type: 'ACTION_BLOCKED',
          payload: {
            rule: decision.rule,
            reason: decision.reason,
            action,
            source: { queue: job.queueName, jobId: job.id },
          },
          correlationId: data.correlationId,
          idempotencyKey: `ACTION_BLOCKED:${job.id}`,
        });
        log.warn({ rule: decision.rule, eventId: event.id }, 'Governor bloqueou ação proibida');
        return { outcome: 'BLOCKED', eventId: event.id, rule: decision.rule };
      }
    }

    const { event, created } = await store.append({
      type: 'TEST_JOB_COMPLETED',
      payload: {
        jobId: job.id,
        message: data.message,
        attempt: job.attemptsMade + 1,
        workerPid: process.pid,
      },
      correlationId: data.correlationId,
      idempotencyKey: `TEST_JOB_COMPLETED:${job.id}`,
    });
    log.info({ eventId: event.id, created }, 'job de diagnóstico processado');
    return { outcome: 'COMPLETED', eventId: event.id };
  };
}
