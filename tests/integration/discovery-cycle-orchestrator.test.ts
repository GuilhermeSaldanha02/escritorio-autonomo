import { createServer, type Server } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitHubConnector } from '@escritorio/cacador';
import { type Pool, seedInitialAgents } from '@escritorio/database';
import { createQueues, createRedisConnection, JOB_NAMES, OutboxDispatcher, QUEUE_NAMES } from '@escritorio/events';
import { Governor, loadConstitution } from '@escritorio/governor';
import { SafeHttpClient } from '@escritorio/http-safe';
import { createDockerClient, SandboxManager } from '@escritorio/tools';
import { createOrchestratorWorker } from '@escritorio/worker';
import { createTestPool, logger, resetDatabase, testRedisUrl, uniqueQueuePrefix, waitFor } from './support.js';

/**
 * Fecha o critério 19 de ponta a ponta pela primeira vez com infraestrutura
 * real: servidor GitHub fake → GitHubConnector real → discover-opportunities
 * (fila do Orquestrador) → OPPORTUNITY_FOUND publicado de verdade →
 * decide-opportunity (o MESMO handler do M2/M3, sem nenhuma alteração) →
 * Diretor avalia. Prova que o Caçador não é um pipeline paralelo — ele
 * alimenta exatamente o mesmo caminho de decisão já testado no M2/M3.
 */
const governor = new Governor(loadConstitution());
let pool: Pool;
let producer: Redis;
let consumer: Redis;
let queues: Map<string, Queue>;
let dispatcher: OutboxDispatcher;
let prefix: string;
let worker: ReturnType<typeof createOrchestratorWorker>;
let server: Server;
let baseUrl: string;
let handler: (res: ServerResponse) => void;

beforeEach(async () => {
  pool = createTestPool();
  await resetDatabase(pool);
  await seedInitialAgents(pool);

  prefix = uniqueQueuePrefix();
  producer = createRedisConnection(testRedisUrl(), 'producer', 'discovery-orch-test-producer');
  consumer = createRedisConnection(testRedisUrl(), 'consumer', 'discovery-orch-test-consumer');
  if (producer.status !== 'ready') await new Promise((resolve) => producer.once('ready', resolve));

  queues = createQueues(producer, prefix);
  dispatcher = new OutboxDispatcher({ pool, queues, logger, pollIntervalMs: 50 });
  dispatcher.start();

  handler = (res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ items: [] }));
  };
  server = createServer((_req, res) => handler(res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const connector = new GitHubConnector({
    httpClient: new SafeHttpClient({ allowPrivateNetworks: true }),
    userAgent: 'escritorio-autonomo-cacador-orch-teste',
    baseUrl,
    queries: ['label:bounty is:issue is:open'],
  });
  const sandboxManager = new SandboxManager(createDockerClient(), logger);
  worker = createOrchestratorWorker({ connection: consumer, prefix, pool, governor, sandboxManager, connector, logger });
  await worker.waitUntilReady();
});

afterEach(async () => {
  await worker.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await dispatcher.stop();
  if (producer.status === 'ready') {
    await Promise.all([...queues.values()].map((queue) => queue.obliterate({ force: true })));
  }
  await Promise.all([producer.quit(), consumer.quit()]);
  await pool.end();
});

async function opportunityStatus(id: string): Promise<string | undefined> {
  const { rows } = await pool.query<{ status: string }>(`SELECT status FROM opportunities WHERE id = $1`, [id]);
  return rows[0]?.status;
}

describe('Caçador → Orquestrador — OPPORTUNITY_FOUND chega de verdade ao Diretor (critério 19)', () => {
  it('um candidato promovido pela Promotion Policy dispara decide-opportunity e o Diretor avalia', async () => {
    handler = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          items: [
            {
              node_id: 'I_orch_1',
              html_url: 'https://github.com/owner/repo/issues/101',
              repository_url: 'https://api.github.com/repos/owner/repo',
              title: 'Corrigir bug crítico',
              body: '/bounty $500\n\nOpen to all contributors, no CLA required. AI agents welcome.',
              state: 'open',
              labels: [{ name: 'bounty' }],
              updated_at: '2026-09-18T00:00:00Z',
            },
          ],
        }),
      );
    };

    const correlationId = crypto.randomUUID();
    const orchestratorQueue = queues.get(QUEUE_NAMES.ORCHESTRATOR)!;
    await orchestratorQueue.add(JOB_NAMES.DISCOVER_OPPORTUNITIES, { correlationId }, { jobId: 'discover-teste-1' });

    const opportunityId = await waitFor(
      async () => {
        const { rows } = await pool.query<{ id: string }>(`SELECT id FROM opportunities WHERE source = 'github' LIMIT 1`);
        return rows[0]?.id;
      },
      { timeoutMs: 15_000, label: 'oportunidade descoberta pelo Caçador persistida' },
    );

    // "Chegou ao Diretor" = saiu de DISCOVERED pela mão do decide-opportunity
    // real (o mesmo handler do M2/M3) — não um estado inventado só para o M4.
    await waitFor(
      async () => {
        const status = await opportunityStatus(opportunityId);
        return status !== 'DISCOVERED' ? status : undefined;
      },
      { timeoutMs: 15_000, label: 'Diretor avaliar a oportunidade descoberta (sair de DISCOVERED)' },
    );

    const { rows: events } = await pool.query<{ type: string }>(
      `SELECT type FROM events WHERE opportunity_id = $1 ORDER BY occurred_at`,
      [opportunityId],
    );
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain('OPPORTUNITY_FOUND');
    expect(eventTypes).toContain('OPPORTUNITY_VERIFYING');
  }, 30_000);

  it('reprocessar o mesmo candidato promovido não publica OPPORTUNITY_FOUND duas vezes', async () => {
    handler = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          items: [
            {
              node_id: 'I_orch_2',
              html_url: 'https://github.com/owner/repo/issues/102',
              repository_url: 'https://api.github.com/repos/owner/repo',
              title: 'Outra correção',
              body: '/bounty $500\n\nOpen to all contributors, no CLA required. AI agents welcome.',
              state: 'open',
              labels: [{ name: 'bounty' }],
              updated_at: '2026-09-18T00:00:00Z',
            },
          ],
        }),
      );
    };

    const correlationId = crypto.randomUUID();
    const orchestratorQueue = queues.get(QUEUE_NAMES.ORCHESTRATOR)!;
    await orchestratorQueue.add(JOB_NAMES.DISCOVER_OPPORTUNITIES, { correlationId }, { jobId: 'discover-teste-2a' });

    const opportunityId = await waitFor(
      async () => {
        const { rows } = await pool.query<{ id: string }>(`SELECT id FROM opportunities WHERE source = 'github' LIMIT 1`);
        return rows[0]?.id;
      },
      { timeoutMs: 15_000, label: 'oportunidade descoberta pelo Caçador persistida' },
    );
    await waitFor(
      async () => {
        const status = await opportunityStatus(opportunityId);
        return status !== 'DISCOVERED' ? status : undefined;
      },
      { timeoutMs: 15_000, label: 'primeiro ciclo processar a oportunidade' },
    );

    // Segundo ciclo de descoberta processa o MESMO candidato (SEEN_AGAIN no
    // Deduplicator) — publicar OPPORTUNITY_FOUND de novo seria reentrega
    // indevida, não uma nova descoberta.
    await orchestratorQueue.add(JOB_NAMES.DISCOVER_OPPORTUNITIES, { correlationId: crypto.randomUUID() }, { jobId: 'discover-teste-2b' });
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM events WHERE opportunity_id = $1 AND type = 'OPPORTUNITY_FOUND'`,
      [opportunityId],
    );
    expect(Number(rows[0]?.count)).toBe(1);
  }, 30_000);
});
