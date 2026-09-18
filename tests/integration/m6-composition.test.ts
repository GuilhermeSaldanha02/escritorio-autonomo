import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AutonomyController,
  CircuitBreakerStore,
  EmergencyStopService,
  LifecycleService,
  RecoveryService,
  releaseAndResume,
  Scheduler,
  stopReaderFor,
} from '@escritorio/autonomy';
import { FakeSourceConnector, GitHubConnector } from '@escritorio/cacador';
import { type Pool, seedInitialAgents } from '@escritorio/database';
import { createQueues, createRedisConnection, EventBus, JOB_NAMES, OutboxDispatcher, QUEUE_NAMES } from '@escritorio/events';
import { Governor, loadConstitution, parseConstitution } from '@escritorio/governor';
import { SafeHttpClient } from '@escritorio/http-safe';
import { createDockerClient, SandboxManager } from '@escritorio/tools';
import { createOrchestratorWorker, createScheduleActions } from '@escritorio/worker';
import { createTestPool, logger, resetDatabase, testRedisUrl, uniqueQueuePrefix, waitFor } from './support.js';

/**
 * Critério 23 do M6: a autonomia composta sobre o ciclo REAL (Postgres, Redis, BullMQ, Docker e
 * um GitHub fake em HTTP). Cada peça já é provada isolada em autonomy-*.test.ts; este teste
 * existe para a categoria de erro que os testes isolados não pegam. Nenhum código de produção novo.
 */
const HOUR = 3_600_000;
const baseGovernor = loadConstitution();
const enabled = (() => {
  const raw = structuredClone(baseGovernor) as unknown as { autonomia: { AUTONOMY_ENABLED: boolean } };
  raw.autonomia.AUTONOMY_ENABLED = true;
  return new Governor(parseConstitution(raw));
})();
const disabled = new Governor(baseGovernor);
const attempts = enabled.limits.MAX_TASK_RETRIES + 1;

let pool: Pool;
let producer: Redis;
let consumer: Redis;
let queues: Map<string, Queue>;
let dispatcher: OutboxDispatcher;
let worker: ReturnType<typeof createOrchestratorWorker>;
let server: Server;
let githubItems: unknown[];
let prefix: string;

beforeEach(async () => {
  pool = createTestPool();
  await resetDatabase(pool);
  await seedInitialAgents(pool);

  prefix = uniqueQueuePrefix();
  producer = createRedisConnection(testRedisUrl(), 'producer', 'm6-composition-producer');
  consumer = createRedisConnection(testRedisUrl(), 'consumer', 'm6-composition-consumer');
  if (producer.status !== 'ready') await new Promise((resolve) => producer.once('ready', resolve));
  queues = createQueues(producer, prefix);
  dispatcher = new OutboxDispatcher({ pool, queues, logger, pollIntervalMs: 50 });
  dispatcher.start();

  githubItems = [];
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ items: githubItems }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const connector = new GitHubConnector({
    httpClient: new SafeHttpClient({ allowPrivateNetworks: true }),
    userAgent: 'escritorio-autonomo-m6-composicao',
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    queries: ['label:bounty is:issue is:open'],
  });
  const sandboxManager = new SandboxManager(createDockerClient(), logger);
  worker = createOrchestratorWorker({ connection: consumer, prefix, pool, governor: enabled, sandboxManager, connector, logger });
  await worker.waitUntilReady();
});

afterEach(async () => {
  await worker.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await dispatcher.stop();
  if (producer.status === 'ready') await Promise.all([...queues.values()].map((queue) => queue.obliterate({ force: true })));
  await Promise.all([producer.quit(), consumer.quit()]);
  await pool.end();
});

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params);
  return Number(rows[0]!.n);
}

function schedulerFor(governor: Governor): { scheduler: Scheduler; recovery: RecoveryService; breakers: CircuitBreakerStore } {
  const breakers = new CircuitBreakerStore(pool, () => ({ failureThreshold: 5, cooldownMs: 300_000, minSample: 1 }));
  const controller = new AutonomyController({ governor, stop: stopReaderFor(pool), breakers });
  const recovery = new RecoveryService({ pool, governor, controller, attempts });
  const lifecycle = new LifecycleService({ pool, governor, controller, resumeAttempts: attempts });
  const scheduler = new Scheduler({ pool, governor, controller, actions: createScheduleActions({ pool, governor, recovery, lifecycle }) });
  return { scheduler, recovery, breakers };
}

/** Uma oportunidade verificada entra no ciclo pelo mesmo caminho do M5: OPPORTUNITY_FOUND + decide-opportunity. */
async function startCycle(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO opportunities
       (source, source_url, title, reward_amount, reward_currency, reward_verified, requirements,
        ai_allowed, automation_allowed, payment_method, confidence, required_capabilities)
     VALUES ('teste', $1, 'Oportunidade de composição M6', 500, 'BRL', true, '["critério único"]'::jsonb,
             true, true, 'pix', 0.95, '{}')
     RETURNING id`,
    [`https://exemplo.test/${crypto.randomUUID()}`],
  );
  const opportunityId = rows[0]!.id;
  const correlationId = crypto.randomUUID();
  await new EventBus(pool).publish(
    { type: 'OPPORTUNITY_FOUND', payload: { source: 'teste' }, opportunityId, correlationId },
    {
      queue: QUEUE_NAMES.ORCHESTRATOR,
      jobName: JOB_NAMES.DECIDE_OPPORTUNITY,
      data: () => ({ opportunityId, correlationId }),
      attempts,
      jobId: `decide-opportunity-${opportunityId}`,
    },
  );
  return opportunityId;
}

async function taskOf(opportunityId: string): Promise<{ id: string; status: string; retry_count: number } | undefined> {
  const { rows } = await pool.query<{ id: string; status: string; retry_count: number }>(
    'SELECT id, status, retry_count FROM tasks WHERE opportunity_id = $1',
    [opportunityId],
  );
  return rows[0];
}

const waitForCompleted = (opportunityId: string) =>
  waitFor(async () => ((await taskOf(opportunityId))?.status === 'COMPLETED' ? await taskOf(opportunityId) : undefined), {
    timeoutMs: 90_000,
    label: 'task chegar a COMPLETED',
  });

describe('M6 — autonomia composta sobre o ciclo real (critério 23)', () => {
  it('AUTONOMY_ENABLED=false: o tick só registra a negação; =true: o tick dispara a descoberta real', async () => {
    const off = schedulerFor(disabled);
    expect((await off.scheduler.runTick('DISCOVERY', new Date())).outcome).toBe('SKIPPED');
    expect(await count('outbox')).toBe(0);

    githubItems = [
      {
        node_id: 'I_m6_1',
        html_url: 'https://github.com/owner/repo/issues/601',
        repository_url: 'https://api.github.com/repos/owner/repo',
        title: 'Corrigir bug crítico',
        body: '/bounty $500\n\nOpen to all contributors, no CLA required. AI agents welcome.',
        state: 'open',
        labels: [{ name: 'bounty' }],
        updated_at: '2026-09-18T00:00:00Z',
      },
    ];
    const on = schedulerFor(enabled);
    expect((await on.scheduler.runTick('DISCOVERY', new Date(Date.now() + HOUR))).outcome).toBe('DISPATCHED');

    const opportunityId = await waitFor(
      async () => (await pool.query<{ id: string }>(`SELECT id FROM opportunities WHERE source = 'github' LIMIT 1`)).rows[0]?.id,
      { timeoutMs: 30_000, label: 'oportunidade descoberta a partir do tick' },
    );
    await waitFor(
      async () => {
        const { rows } = await pool.query<{ status: string }>('SELECT status FROM opportunities WHERE id = $1', [opportunityId]);
        return rows[0]?.status !== 'DISCOVERED' ? rows[0]?.status : undefined;
      },
      { timeoutMs: 30_000, label: 'Diretor avaliar a oportunidade vinda do tick' },
    );
    expect(await count(`scheduled_executions WHERE schedule_name = 'DISCOVERY' AND status = 'DISPATCHED'`)).toBe(1);
  }, 90_000);

  it('Emergency Stop no meio do ciclo pausa sem falhar; o RELEASE completa sem duplicar nem gastar retry', async () => {
    const opportunityId = await startCycle();
    await waitFor(async () => (await taskOf(opportunityId))?.id, { timeoutMs: 60_000, label: 'task criada' });

    const stop = new EmergencyStopService(pool);
    expect(await stop.engage('FOUNDER_CLI', 'incidente de composição')).toBe('ENGAGED');

    await waitFor(async () => ((await count('paused_work WHERE resumed_at IS NULL')) > 0 ? true : undefined), {
      timeoutMs: 60_000,
      label: 'trabalho pausado pelo Stop',
    });
    // Pausa NÃO é falha: a task não falhou, nenhum job do BullMQ falhou e nenhuma tentativa foi gasta.
    const paused = await taskOf(opportunityId);
    expect(paused?.status).not.toBe('COMPLETED');
    expect(paused?.status).not.toBe('FAILED');
    expect(paused?.retry_count).toBe(0);
    expect(await queues.get(QUEUE_NAMES.ORCHESTRATOR)!.getFailedCount()).toBe(0);
    expect(await count('experiences')).toBe(0);
    expect(await count(`events WHERE type = 'WORK_PAUSED'`)).toBeGreaterThan(0);

    const outcome = await releaseAndResume(pool, 'FOUNDER_CLI', 'resolvido', attempts);
    expect(outcome.transition).toBe('RELEASED');
    expect(outcome.resumed).toBeGreaterThan(0);

    const done = await waitForCompleted(opportunityId);
    expect(done?.retry_count).toBe(0);
    await waitFor(async () => ((await count('experiences')) > 0 ? true : undefined), { timeoutMs: 30_000, label: 'Experience' });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await count('experiences')).toBe(1);
    expect(await count('tasks WHERE opportunity_id = $1', [opportunityId])).toBe(1);
    expect(await queues.get(QUEUE_NAMES.ORCHESTRATOR)!.getFailedCount()).toBe(0);
    expect(await count(`events WHERE type = 'WORK_RESUMED'`)).toBe(outcome.resumed);
  }, 180_000);

  it('circuito aberto na FONTE barra só a descoberta: o ciclo de tasks do Desenvolvedor segue', async () => {
    const { breakers } = schedulerFor(enabled);
    const t0 = new Date();
    for (let i = 0; i < 5; i++) await breakers.recordOutcome({ type: 'SOURCE', key: 'github' }, 'FAILURE', new Date(t0.getTime() + i), 'falha técnica simulada');
    expect((await breakers.state({ type: 'SOURCE', key: 'github' })).status).toBe('OPEN');

    githubItems = [
      {
        node_id: 'I_m6_2',
        html_url: 'https://github.com/owner/repo/issues/602',
        repository_url: 'https://api.github.com/repos/owner/repo',
        title: 'Outra correção',
        body: '/bounty $500\n\nOpen to all contributors, no CLA required. AI agents welcome.',
        state: 'open',
        labels: [{ name: 'bounty' }],
        updated_at: '2026-09-18T00:00:00Z',
      },
    ];
    await new EventBus(pool).publish(
      { type: 'SCHEDULE_TICK_DISPATCHED', payload: { schedule: 'DISCOVERY', windowKey: 'teste' }, correlationId: crypto.randomUUID() },
      { queue: QUEUE_NAMES.ORCHESTRATOR, jobName: JOB_NAMES.DISCOVER_OPPORTUNITIES, data: () => ({ correlationId: crypto.randomUUID() }), attempts, jobId: 'discover-circuito' },
    );

    // Outro escopo intacto: uma task inteira completa enquanto a fonte está aberta.
    const opportunityId = await startCycle();
    await waitForCompleted(opportunityId);

    // A descoberta foi barrada (nada persistido) e não falhou nem gastou tentativa.
    expect(await count(`opportunities WHERE source = 'github'`)).toBe(0);
    expect(await queues.get(QUEUE_NAMES.ORCHESTRATOR)!.getFailedCount()).toBe(0);
    expect(await count(`circuit_breaker_events WHERE scope_type = 'SOURCE' AND event_type = 'OPENED'`)).toBe(1);
  }, 180_000);

  it('recovery: job perdido depois de um release parcial é re-despachado UMA vez e conclui sem duplicar', async () => {
    const opportunityId = await startCycle();
    await waitFor(async () => (await taskOf(opportunityId))?.id, { timeoutMs: 60_000, label: 'task criada' });

    const stop = new EmergencyStopService(pool);
    await stop.engage('FOUNDER_CLI', 'interrupção controlada');
    await waitFor(async () => ((await count('paused_work WHERE resumed_at IS NULL')) > 0 ? true : undefined), {
      timeoutMs: 60_000,
      label: 'trabalho pausado',
    });
    // O processo "caiu" entre liberar e retomar: o Stop foi liberado, mas nenhum job voltou à fila.
    await stop.release('FOUNDER_CLI', 'liberado sem retomar');
    expect((await taskOf(opportunityId))?.status).not.toBe('COMPLETED');

    const { recovery } = schedulerFor(enabled);
    const later = new Date(Date.now() + 2 * HOUR);
    await recovery.sweep(later);
    await recovery.sweep(later); // repetir a varredura não duplica

    const done = await waitForCompleted(opportunityId);
    expect(done?.retry_count).toBe(0);
    await waitFor(async () => ((await count('experiences')) > 0 ? true : undefined), { timeoutMs: 30_000, label: 'Experience' });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await count('experiences')).toBe(1);
    expect(await count('tasks WHERE opportunity_id = $1', [opportunityId])).toBe(1);
    expect(await queues.get(QUEUE_NAMES.ORCHESTRATOR)!.getFailedCount()).toBe(0);
  }, 180_000);

  /**
   * Critérios 16 e 23(c): a MESMA interrupção controlada do M2 (Worker A preso dentro do passo do
   * Desenvolvedor e fechado à força; Worker B assume o job stalled relendo o Postgres), agora com
   * a autonomia no ambiente: o Stop é engajado depois da queda, o Worker B pausa em vez de falhar,
   * o RELEASE retoma, e o recovery/scheduler depois disso não mudam nada. Continua sendo a
   * interrupção controlada do M2, não um crash de processo.
   */
  it('Worker A cai no meio do ciclo, Stop e RELEASE no meio da retomada: Worker B conclui exatamente uma vez', async () => {
    await worker.close();
    const shortLock = { lockDuration: 1_500, stalledInterval: 500 };
    const connector = new FakeSourceConnector('github', [{ status: 'OK', candidates: [] }]);
    const hanging = { run: () => new Promise<never>(() => {}) } as unknown as SandboxManager;
    const connA = createRedisConnection(testRedisUrl(), 'consumer', 'm6-crash-a');
    const connB = createRedisConnection(testRedisUrl(), 'consumer', 'm6-crash-b');
    const workerA = createOrchestratorWorker({ connection: connA, prefix, pool, governor: enabled, sandboxManager: hanging, connector, logger, ...shortLock });
    await workerA.waitUntilReady();

    try {
      const opportunityId = await startCycle();
      const task = await waitFor(async () => await taskOf(opportunityId), { timeoutMs: 60_000, label: 'task criada' });
      await waitFor(
        async () =>
          (await count(`events WHERE task_id = $1 AND type = 'AGENT_STATE_CHANGED' AND payload->>'newState' = 'CODING'`, [task.id])) > 0 || undefined,
        { timeoutMs: 30_000, label: 'Worker A entrar no passo do Desenvolvedor' },
      );
      await workerA.close(true); // a queda

      // O ambiente muda antes de o Worker B assumir: Stop engajado.
      const stop = new EmergencyStopService(pool);
      await stop.engage('FOUNDER_CLI', 'incidente durante a queda');

      const workerB = createOrchestratorWorker({
        connection: connB,
        prefix,
        pool,
        governor: enabled,
        sandboxManager: new SandboxManager(createDockerClient(), logger),
        connector,
        logger,
        ...shortLock,
      });
      await workerB.waitUntilReady();
      try {
        await new Promise<void>((resolve) => workerB.once('stalled', () => resolve()));
        await waitFor(async () => ((await count('paused_work WHERE resumed_at IS NULL')) > 0 ? true : undefined), {
          timeoutMs: 30_000,
          label: 'Worker B pausar em vez de falhar',
        });
        expect((await taskOf(opportunityId))?.status).not.toBe('COMPLETED');
        expect((await taskOf(opportunityId))?.retry_count).toBe(0);

        const outcome = await releaseAndResume(pool, 'FOUNDER_CLI', 'resolvido', attempts);
        expect(outcome.resumed).toBeGreaterThan(0);
        const done = await waitForCompleted(opportunityId);
        expect(done?.retry_count).toBe(0);

        await waitFor(async () => ((await count('experiences')) > 0 ? true : undefined), { timeoutMs: 30_000, label: 'Experience' });
        const snapshot = async (): Promise<Record<string, number>> => ({
          experiences: await count('experiences'),
          tasks: await count('tasks WHERE opportunity_id = $1', [opportunityId]),
          events: await count('events'),
          outbox: await count('outbox'),
          ...Object.fromEntries(
            await Promise.all(
              ['TASK_STARTED', 'IMPLEMENTATION_READY', 'REVIEW_STARTED', 'REVIEW_PASSED', 'TASK_COMPLETED'].map(async (type) => [type, await count(`events WHERE task_id = $1 AND type = $2`, [task.id, type])] as const),
            ),
          ),
        });
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        const before = await snapshot();
        expect(before).toMatchObject({ experiences: 1, tasks: 1, TASK_STARTED: 1, IMPLEMENTATION_READY: 1, REVIEW_STARTED: 1, REVIEW_PASSED: 1, TASK_COMPLETED: 1 });

        // Recovery e scheduler depois da conclusão: nada a fazer e nada duplicado.
        const { recovery, scheduler } = schedulerFor(enabled);
        const later = new Date(Date.now() + 2 * HOUR);
        await recovery.sweep(later);
        await scheduler.runDue(later);
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        const after = await snapshot();
        expect(after.experiences).toBe(before.experiences);
        expect(after.tasks).toBe(before.tasks);
        for (const type of ['TASK_STARTED', 'IMPLEMENTATION_READY', 'REVIEW_STARTED', 'REVIEW_PASSED', 'TASK_COMPLETED'] as const) expect(after[type]).toBe(1);
      } finally {
        await workerB.close();
        await connB.quit();
      }
    } finally {
      await connA.quit();
    }
  }, 240_000);
});
