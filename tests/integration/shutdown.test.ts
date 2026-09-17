import { afterEach, describe, expect, it } from 'vitest';
import { EventBus, requestDiagnosticJob } from '@escritorio/events';
import { createWorkerShutdown } from '@escritorio/worker';
import { startRuntime, type TestRuntime } from './runtime.js';
import { logger } from './support.js';

// Encerramento gracioso com BullMQ, Redis e PostgreSQL reais. Chama a mesma
// rotina que o SIGINT/SIGTERM dispara em produção (main.ts da API e do Worker).
let rt: TestRuntime | undefined;

afterEach(async () => {
  await rt?.close();
  rt = undefined;
});

async function startLongJob(runtime: TestRuntime, durationMs: number) {
  const active = new Promise<void>((resolve) => runtime.worker.bullWorker.once('active', () => resolve()));
  const published = await requestDiagnosticJob(new EventBus(runtime.api.pool), runtime.governor, {
    message: `job de ${durationMs} ms durante o encerramento`,
    durationMs,
  });
  await active;
  return published.event;
}

describe('encerramento gracioso do Worker', () => {
  it('termina o job em andamento, grava o evento e só então fecha filas, Redis e PostgreSQL', async () => {
    rt = await startRuntime();
    const { worker, api } = rt;
    const event = await startLongJob(rt, 1_500);

    const startedAt = Date.now();
    expect(await worker.shutdown('SIGTERM')).toBe('clean');

    // Esperou o job em vez de matá-lo no meio, e o evento dele está no banco.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_000);
    const { rows } = await api.pool.query('SELECT type FROM events WHERE correlation_id = $1 ORDER BY occurred_at', [
      event.correlationId,
    ]);
    expect(rows).toEqual([{ type: 'TEST_JOB_REQUESTED' }, { type: 'TEST_JOB_COMPLETED' }]);

    // quit() resolve com o OK do servidor; o status vira 'end' logo depois, no fechamento do socket.
    await expect.poll(() => worker.consumer.status).toBe('end');
    await expect.poll(() => worker.producer.status).toBe('end');
    expect(worker.pool.ended).toBe(true);
  });

  it('estoura o prazo quando o job não termina a tempo', async () => {
    rt = await startRuntime();
    await startLongJob(rt, 3_000);

    // Mesma composição de etapas, prazo curto.
    const { worker } = rt;
    const shutdown = createWorkerShutdown({
      dispatcher: worker.dispatcher,
      workers: [worker.bullWorker],
      queues: worker.queues.values(),
      producer: worker.producer,
      connection: worker.consumer,
      pool: worker.pool,
      logger,
      timeoutMs: 300,
    });
    expect(await shutdown('SIGTERM')).toBe('timed-out');

    // Em produção o processo sai aqui. No teste, o encerramento segue em
    // segundo plano; esperamos terminar para não vazar conexões.
    await expect.poll(() => worker.pool.ended, { timeout: 10_000, interval: 100 }).toBe(true);
  });
});

describe('encerramento gracioso da API', () => {
  it('para o HTTP e fecha Redis e PostgreSQL', async () => {
    rt = await startRuntime();
    const { api } = rt;
    expect((await api.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);

    expect(await api.shutdown('SIGINT')).toBe('clean');

    await expect.poll(() => api.redis.status).toBe('end');
    expect(api.pool.ended).toBe(true);
    await expect(api.app.inject({ method: 'GET', url: '/health' })).rejects.toThrow();
  });
});
