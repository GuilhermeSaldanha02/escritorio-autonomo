import type { Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StoredEvent } from '@escritorio/events';
import { createDiagnosticProcessor } from '@escritorio/worker';
import { startRuntime, type TestRuntime } from './runtime.js';
import { logger, waitFor } from './support.js';

/**
 * Ponta a ponta com serviços reais: HTTP (inject) → evento + outbox na mesma
 * transação → dispatcher → BullMQ/Redis → Worker → evento persistido.
 */
let rt: TestRuntime;

beforeAll(async () => {
  rt = await startRuntime();
});

afterAll(async () => {
  await rt?.close();
});

async function eventsFor(correlationId: string): Promise<StoredEvent[]> {
  const response = await rt.api.app.inject({ method: 'GET', url: `/events?correlationId=${correlationId}` });
  expect(response.statusCode).toBe(200);
  return response.json<{ events: StoredEvent[] }>().events;
}

async function eventsUntil(correlationId: string, type: string): Promise<StoredEvent[]> {
  return waitFor(
    async () => {
      const events = await eventsFor(correlationId);
      return events.some((event) => event.type === type) ? events : undefined;
    },
    { label: `${type} para ${correlationId}` },
  );
}

describe('GET /health com serviços reais', () => {
  it('responde 200 com PostgreSQL e Redis conectados', async () => {
    const response = await rt.api.app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      database: { status: 'connected' },
      redis: { status: 'connected' },
    });
  });
});

describe('job de diagnóstico', () => {
  it('atravessa API → outbox → fila → Worker e gera evento persistido', async () => {
    const response = await rt.api.app.inject({
      method: 'POST',
      url: '/diagnostics/test-jobs',
      payload: { message: 'fundação M1' },
    });
    expect(response.statusCode).toBe(202);
    const { correlationId, jobId, requestEventId } = response.json<{
      correlationId: string;
      jobId: string;
      requestEventId: string;
    }>();
    expect(jobId).toBe(requestEventId);

    const events = await eventsUntil(correlationId, 'TEST_JOB_COMPLETED');
    expect(events.map((event) => event.type)).toEqual(['TEST_JOB_REQUESTED', 'TEST_JOB_COMPLETED']);
    expect(events[1]?.payload).toMatchObject({ jobId, message: 'fundação M1', attempt: 1 });

    // Confere direto nas tabelas, sem passar pela API.
    const { rows } = await rt.api.pool.query(
      `SELECT e.type, o.dispatched_at IS NOT NULL AS dispatched
          FROM events e LEFT JOIN outbox o ON o.event_id = e.id
        WHERE e.correlation_id = $1 ORDER BY e.occurred_at`,
      [correlationId],
    );
    expect(rows).toEqual([
      { type: 'TEST_JOB_REQUESTED', dispatched: true },
      // O evento de conclusão não pede job: não tem linha no outbox.
      { type: 'TEST_JOB_COMPLETED', dispatched: false },
    ]);
  });

  it('Governor bloqueia ação proibida no Worker e registra ACTION_BLOCKED', async () => {
    const response = await rt.api.app.inject({
      method: 'POST',
      url: '/diagnostics/test-jobs',
      payload: { message: 'tentar operar trading', requestedCapability: 'TRADING' },
    });
    expect(response.statusCode).toBe(202);
    const { correlationId } = response.json<{ correlationId: string }>();

    const events = await eventsUntil(correlationId, 'ACTION_BLOCKED');
    expect(events.map((event) => event.type)).toEqual(['TEST_JOB_REQUESTED', 'ACTION_BLOCKED']);
    expect(events[1]?.payload).toMatchObject({
      rule: 'ALLOW_TRADING',
      action: { kind: 'CAPABILITY', capability: 'TRADING' },
    });
  });

  it('rejeita capacidade fora do catálogo antes de gravar qualquer coisa', async () => {
    const response = await rt.api.app.inject({
      method: 'POST',
      url: '/diagnostics/test-jobs',
      payload: { message: 'x', requestedCapability: 'FORMAT_DISK' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('reprocessar o mesmo job não duplica o evento', async () => {
    const process = createDiagnosticProcessor({ store: rt.worker.store, governor: rt.governor, logger });
    const correlationId = crypto.randomUUID();
    const job = {
      id: crypto.randomUUID(),
      name: 'diagnostic',
      queueName: 'system',
      attemptsMade: 0,
      data: { requestEventId: crypto.randomUUID(), correlationId, message: 'retry' },
    } as unknown as Job;

    const first = await process(job);
    const second = await process({ ...job, attemptsMade: 1 } as Job);
    expect(second).toEqual(first);

    const { rows } = await rt.worker.pool.query('SELECT count(*)::int AS total FROM events WHERE correlation_id = $1', [
      correlationId,
    ]);
    expect(rows[0]).toEqual({ total: 1 });
  });
});
