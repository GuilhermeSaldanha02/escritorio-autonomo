import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '@escritorio/api';
import { type Pool, seedInitialAgents } from '@escritorio/database';
import {
  createQueues,
  createRedisConnection,
  EventBus,
  EventStore,
  OutboxDispatcher,
  QUEUE_NAMES,
  requestDiagnosticJob,
} from '@escritorio/events';
import { Governor, loadConstitution } from '@escritorio/governor';
import { createTestPool, logger, resetDatabase, testRedisUrl, uniqueQueuePrefix } from './support.js';

/**
 * Transactional Outbox contra PostgreSQL e Redis reais. Aqui não há Worker
 * consumindo: o foco é a publicação — o job precisa existir no BullMQ
 * exatamente uma vez, mesmo com Redis fora, reentrega e dispatchers concorrentes.
 */
const governor = new Governor(loadConstitution());
let pool: Pool;
let producer: Redis;
let queues: Map<string, Queue>;
let prefix: string;

interface OutboxRow {
  job_id: string;
  dispatch_attempts: number;
  dispatched: boolean;
  last_error: string | null;
  available_later: boolean;
}

async function outboxRow(jobId: string): Promise<OutboxRow | undefined> {
  const { rows } = await pool.query<OutboxRow>(
    `SELECT job_id, dispatch_attempts, dispatched_at IS NOT NULL AS dispatched, last_error,
            available_at > now() AS available_later
       FROM outbox WHERE job_id = $1`,
    [jobId],
  );
  return rows[0];
}

async function systemJobCount(): Promise<number> {
  const counts = await queues.get(QUEUE_NAMES.SYSTEM)!.getJobCounts();
  return Object.values(counts).reduce((total, n) => total + n, 0);
}

beforeAll(async () => {
  pool = createTestPool();
  producer = createRedisConnection(testRedisUrl(), 'producer', 'outbox-test');
  if (producer.status !== 'ready') await new Promise((resolve) => producer.once('ready', resolve));
});

beforeEach(async () => {
  await resetDatabase(pool);
  await seedInitialAgents(pool);
  prefix = uniqueQueuePrefix();
  queues = createQueues(producer, prefix);
});

afterAll(async () => {
  await Promise.all([...queues.values()].map(async (queue) => {
    await queue.obliterate({ force: true });
    await queue.close();
  }));
  await producer.quit();
  await pool.end();
});

describe('Transactional Outbox', () => {
  it('evento e pedido de job são gravados juntos, sem tocar no Redis', async () => {
    const { event, jobId } = await requestDiagnosticJob(new EventBus(pool), governor, { message: 'atômico' });

    expect(jobId).toBe(event.id);
    expect(await outboxRow(event.id)).toMatchObject({ dispatched: false, dispatch_attempts: 0 });
    expect(await systemJobCount()).toBe(0);
  });

  it('falha no evento desfaz também o pedido de job', async () => {
    const bus = new EventBus(pool);
    await expect(
      bus.publish(
        // correlationId inválido faz o INSERT do evento falhar dentro da transação.
        { type: 'TEST_JOB_REQUESTED', payload: { message: 'x' }, correlationId: 'não-é-uuid' },
        { queue: QUEUE_NAMES.SYSTEM, jobName: 'diagnostic', attempts: 1, data: () => ({}) },
      ),
    ).rejects.toThrow();
    const { rows } = await pool.query('SELECT count(*)::int AS total FROM outbox');
    expect(rows[0]).toEqual({ total: 0 });
  });

  it('com Redis fora o job fica pendente com erro e é publicado quando o Redis volta', async () => {
    const { event } = await requestDiagnosticJob(new EventBus(pool), governor, { message: 'redis caiu' });

    // Redis inalcançável de verdade: cliente ioredis apontado para porta fechada.
    const deadRedis = createRedisConnection('redis://127.0.0.1:1', 'producer', 'outbox-test-dead');
    deadRedis.on('error', () => undefined);
    const deadQueues = createQueues(deadRedis, prefix);
    for (const queue of deadQueues.values()) queue.on('error', () => undefined);
    const broken = new OutboxDispatcher({ pool, queues: deadQueues, logger, publishTimeoutMs: 500 });

    expect(await broken.dispatchPending()).toEqual({ dispatched: 0, failed: 1 });
    expect(await outboxRow(event.id)).toMatchObject({
      dispatched: false,
      dispatch_attempts: 1,
      available_later: true,
      last_error: expect.stringMatching(/^TimeoutError: publicação do job/),
    });
    deadRedis.disconnect();

    // Antes do backoff vencer, nada é tentado de novo.
    const healthy = new OutboxDispatcher({ pool, queues, logger });
    expect(await healthy.dispatchPending()).toEqual({ dispatched: 0, failed: 0 });

    // "Redis voltou" e o backoff venceu.
    await pool.query('UPDATE outbox SET available_at = now() WHERE job_id = $1', [event.id]);
    expect(await healthy.dispatchPending()).toEqual({ dispatched: 1, failed: 0 });
    expect(await outboxRow(event.id)).toMatchObject({ dispatched: true, dispatch_attempts: 2, last_error: null });

    const job = await queues.get(QUEUE_NAMES.SYSTEM)!.getJob(event.id);
    expect(job?.data).toMatchObject({ requestEventId: event.id, message: 'redis caiu' });
    expect(job?.opts.attempts).toBe(1 + governor.limits.MAX_TASK_RETRIES);
  });

  it('reentrega após queda entre publicar e marcar não duplica o job', async () => {
    const { event } = await requestDiagnosticJob(new EventBus(pool), governor, { message: 'reentrega' });
    const dispatcher = new OutboxDispatcher({ pool, queues, logger });
    await dispatcher.dispatchPending();

    // Simula o processo morrendo depois do queue.add e antes do COMMIT.
    await pool.query('UPDATE outbox SET dispatched_at = NULL WHERE job_id = $1', [event.id]);
    expect(await dispatcher.dispatchPending()).toEqual({ dispatched: 1, failed: 0 });

    expect(await systemJobCount()).toBe(1);
  });

  it('dispatchers concorrentes publicam cada linha uma única vez', async () => {
    const bus = new EventBus(pool);
    for (let i = 0; i < 20; i += 1) await requestDiagnosticJob(bus, governor, { message: `lote ${i}` });

    const dispatchers = [1, 2, 3].map(() => new OutboxDispatcher({ pool, queues, logger, batchSize: 7 }));
    let total = 0;
    for (let round = 0; round < 5; round += 1) {
      const reports = await Promise.all(dispatchers.map((d) => d.dispatchPending()));
      total += reports.reduce((sum, r) => sum + r.dispatched, 0);
    }

    expect(total).toBe(20);
    expect(await systemJobCount()).toBe(20);
    const { rows } = await pool.query('SELECT max(dispatch_attempts)::int AS max FROM outbox');
    expect(rows[0]).toEqual({ max: 1 });
  });

  it('fila desconhecida fica pendente com o erro registrado, sem derrubar o lote', async () => {
    const bus = new EventBus(pool);
    const ok = await requestDiagnosticJob(bus, governor, { message: 'ok' });
    const orphan = await bus.publish(
      { type: 'AGENT_STATE_CHANGED', payload: { agentId: 'CACADOR-001' } },
      { queue: 'fila-que-nao-existe', jobName: 'x', attempts: 1, data: () => ({}) },
    );

    const dispatcher = new OutboxDispatcher({ pool, queues, logger });
    expect(await dispatcher.dispatchPending()).toEqual({ dispatched: 1, failed: 1 });
    expect(await outboxRow(ok.event.id)).toMatchObject({ dispatched: true });
    expect(await outboxRow(orphan.event.id)).toMatchObject({
      dispatched: false,
      last_error: 'Error: Fila desconhecida: fila-que-nao-existe',
    });
  });

  it('a API aceita o pedido mesmo com o Redis fora', async () => {
    const deadRedis = createRedisConnection('redis://127.0.0.1:1', 'producer', 'outbox-test-api');
    deadRedis.on('error', () => undefined);
    const app = await buildServer({
      logger,
      db: pool,
      redis: deadRedis,
      bus: new EventBus(pool),
      store: new EventStore(pool),
      governor,
      aiMode: 'mock',
    });

    const response = await app.inject({ method: 'POST', url: '/diagnostics/test-jobs', payload: { message: 'sem redis' } });
    expect(response.statusCode).toBe(202);
    const { jobId } = response.json<{ jobId: string }>();
    expect(await outboxRow(jobId)).toMatchObject({ dispatched: false });

    await app.close();
    deadRedis.disconnect();
  });
});
