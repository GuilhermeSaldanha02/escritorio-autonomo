import type { Queue } from 'bullmq';
import type { GovernedCapability, Governor } from '@escritorio/governor';
import type { EventBus, PublishResult } from './bus.js';
import { JOB_NAMES, type DiagnosticJobData } from './queues.js';

export interface DiagnosticRequest {
  message: string;
  /** Simula um job demorado (máx. 5 s). */
  durationMs?: number;
  /** Pede ao Worker uma capacidade governada — usado para provar o bloqueio. */
  requestedCapability?: GovernedCapability;
}

/**
 * Publica TEST_JOB_REQUESTED e enfileira o job de diagnóstico. O id do evento
 * de pedido vira o correlationId de tudo que o Worker registrar depois.
 */
export async function requestDiagnosticJob(
  bus: EventBus,
  queue: Queue,
  governor: Governor,
  request: DiagnosticRequest,
): Promise<PublishResult> {
  const correlationId = crypto.randomUUID();
  const payload = {
    message: request.message,
    ...(request.durationMs === undefined ? {} : { durationMs: request.durationMs }),
    ...(request.requestedCapability === undefined ? {} : { requestedCapability: request.requestedCapability }),
  };

  return bus.publish(
    { type: 'TEST_JOB_REQUESTED', payload, correlationId },
    {
      queue,
      jobName: JOB_NAMES.DIAGNOSTIC,
      attempts: 1 + governor.limits.MAX_TASK_RETRIES,
      data: (event): DiagnosticJobData => ({ requestEventId: event.id, correlationId, ...payload }),
    },
  );
}
