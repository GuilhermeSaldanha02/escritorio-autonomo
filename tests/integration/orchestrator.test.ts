import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Pool, seedInitialAgents } from '@escritorio/database';
import {
  createQueues,
  createRedisConnection,
  EventBus,
  JOB_NAMES,
  OutboxDispatcher,
  QUEUE_NAMES,
} from '@escritorio/events';
import { Governor, loadConstitution } from '@escritorio/governor';
import { hashFileSnapshot } from '@escritorio/shared';
import { createDockerClient, SandboxManager } from '@escritorio/tools';
import { createOrchestratorWorker } from '@escritorio/worker';
import { createTestPool, logger, resetDatabase, testRedisUrl, uniqueQueuePrefix, waitFor } from './support.js';

/**
 * Fluxo alvo do M2 (docs/M2-PLANO.md) de ponta a ponta contra Postgres, Redis
 * e Docker reais: Oportunidade → Diretor → Task → Desenvolvedor em sandbox →
 * Revisor em sandbox independente → COMPLETED. Cobre os critérios de aceite
 * 3 a 10 do M2 (a transição atômica em si já é provada em transitions.test.ts).
 */
const governor = new Governor(loadConstitution());
let pool: Pool;
let producer: Redis;
let consumer: Redis;
let queues: Map<string, Queue>;
let dispatcher: OutboxDispatcher;
let prefix: string;
let bus: EventBus;
let worker: ReturnType<typeof createOrchestratorWorker>;

beforeEach(async () => {
  pool = createTestPool();
  await resetDatabase(pool);
  await seedInitialAgents(pool);

  prefix = uniqueQueuePrefix();
  producer = createRedisConnection(testRedisUrl(), 'producer', 'orchestrator-test-producer');
  consumer = createRedisConnection(testRedisUrl(), 'consumer', 'orchestrator-test-consumer');
  if (producer.status !== 'ready') await new Promise((resolve) => producer.once('ready', resolve));

  queues = createQueues(producer, prefix);
  dispatcher = new OutboxDispatcher({ pool, queues, logger, pollIntervalMs: 50 });
  dispatcher.start();

  const sandboxManager = new SandboxManager(createDockerClient(), logger);
  worker = createOrchestratorWorker({ connection: consumer, prefix, pool, governor, sandboxManager, logger });
  await worker.waitUntilReady();

  bus = new EventBus(pool);
});

afterEach(async () => {
  await dispatcher.stop();
  await worker.close();
  if (producer.status === 'ready') {
    await Promise.all([...queues.values()].map((queue) => queue.obliterate({ force: true })));
  }
  await Promise.all([producer.quit(), consumer.quit()]);
  await pool.end();
});

interface OpportunitySeed {
  automationAllowed?: boolean | null;
  aiAllowed?: boolean | null;
  rewardVerified?: boolean;
  rewardAmount?: number;
  confidence?: number;
  requiredCapabilities?: readonly string[];
}

async function discoverOpportunity(seed: OpportunitySeed = {}): Promise<{ opportunityId: string; correlationId: string }> {
  const {
    automationAllowed = true,
    aiAllowed = true,
    rewardVerified = true,
    rewardAmount = 500,
    confidence = 0.95,
    requiredCapabilities = [],
  } = seed;

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO opportunities
       (source, source_url, title, reward_amount, reward_currency, reward_verified, requirements,
        ai_allowed, automation_allowed, payment_method, confidence, required_capabilities)
     VALUES ('teste', $1, 'Oportunidade de teste', $2, 'BRL', $3, '["critério único"]'::jsonb,
             $4, $5, 'pix', $6, $7)
     RETURNING id`,
    [
      `https://exemplo.test/${crypto.randomUUID()}`,
      rewardAmount,
      rewardVerified,
      aiAllowed,
      automationAllowed,
      confidence,
      requiredCapabilities,
    ],
  );
  const opportunityId = rows[0]!.id;
  const correlationId = crypto.randomUUID();

  await bus.publish(
    { type: 'OPPORTUNITY_FOUND', payload: { source: 'teste' }, opportunityId, correlationId },
    {
      queue: QUEUE_NAMES.ORCHESTRATOR,
      jobName: JOB_NAMES.DECIDE_OPPORTUNITY,
      data: () => ({ opportunityId, correlationId }),
      attempts: governor.limits.MAX_TASK_RETRIES + 1,
      jobId: `decide-opportunity-${opportunityId}`,
    },
  );

  return { opportunityId, correlationId };
}

async function opportunityStatus(id: string): Promise<string | undefined> {
  const { rows } = await pool.query<{ status: string }>('SELECT status FROM opportunities WHERE id = $1', [id]);
  return rows[0]?.status;
}

async function taskForOpportunity(opportunityId: string): Promise<{ id: string; status: string; retry_count: number } | undefined> {
  const { rows } = await pool.query<{ id: string; status: string; retry_count: number }>(
    'SELECT id, status, retry_count FROM tasks WHERE opportunity_id = $1',
    [opportunityId],
  );
  return rows[0];
}

async function eventCount(taskId: string, type: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM events WHERE task_id = $1 AND type = $2`,
    [taskId, type],
  );
  return Number(rows[0]?.count ?? 0);
}

describe('Orquestrador — ciclo completo', () => {
  it(
    'cenário feliz: oportunidade aprovada percorre até COMPLETED, com Desenvolvedor e Revisor em sandboxes distintas',
    async () => {
      const { opportunityId } = await discoverOpportunity();

      const task = await waitFor(async () => await taskForOpportunity(opportunityId), {
        timeoutMs: 30_000,
        label: 'task criada para a oportunidade',
      });

      await waitFor(
        async () => {
          const current = await taskForOpportunity(opportunityId);
          return current?.status === 'COMPLETED' ? current : undefined;
        },
        { timeoutMs: 60_000, label: 'task chegar a COMPLETED' },
      );

      expect(await opportunityStatus(opportunityId)).toBe('SUBMITTED');

      // Eventos-chave da esteira, todos persistidos em ordem (critério 4).
      for (const type of ['TASK_CREATED', 'TASK_ASSIGNED', 'TASK_STARTED', 'IMPLEMENTATION_READY', 'REVIEW_STARTED', 'REVIEW_PASSED']) {
        expect(await eventCount(task.id, type)).toBeGreaterThanOrEqual(1);
      }

      // Critério 5: sandboxes distintas entre Desenvolvedor e Revisor.
      const { rows: implRows } = await pool.query<{ payload: { developer_sandbox_id: string } }>(
        `SELECT payload FROM events WHERE task_id = $1 AND type = 'IMPLEMENTATION_READY' ORDER BY occurred_at DESC LIMIT 1`,
        [task.id],
      );
      const { rows: reviewRows } = await pool.query<{ payload: { review_sandbox_id: string } }>(
        `SELECT payload FROM events WHERE task_id = $1 AND type = 'REVIEW_PASSED' ORDER BY occurred_at DESC LIMIT 1`,
        [task.id],
      );
      const developerSandboxId = implRows[0]?.payload.developer_sandbox_id;
      const reviewSandboxId = reviewRows[0]?.payload.review_sandbox_id;
      expect(developerSandboxId).toBeTruthy();
      expect(reviewSandboxId).toBeTruthy();
      expect(reviewSandboxId).not.toBe(developerSandboxId);

      // Critério 10: os agentes mudaram de estado durante o ciclo.
      const { rows: agentRows } = await pool.query<{ id: string; state: string }>(
        `SELECT id, state FROM agents WHERE id IN ('DESENVOLVEDOR-001', 'REVISOR-001')`,
      );
      for (const row of agentRows) expect(row.state).toBe('SUCCESS');
      const stateChanges = await eventCount(task.id, 'AGENT_STATE_CHANGED');
      expect(stateChanges).toBeGreaterThanOrEqual(2); // ao menos Desenvolvedor e Revisor mudaram de estado.
    },
    90_000,
  );

  it(
    'oportunidade que exige capacidade proibida gera ACTION_BLOCKED e nenhuma task é criada (critério 7)',
    async () => {
      const { opportunityId } = await discoverOpportunity({ requiredCapabilities: ['TRADING'] });

      await waitFor(
        async () => {
          const status = await opportunityStatus(opportunityId);
          return status === 'REJECTED' ? status : undefined;
        },
        { timeoutMs: 20_000, label: 'oportunidade ser rejeitada pelo Governor' },
      );

      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM events WHERE opportunity_id = $1 AND type = 'ACTION_BLOCKED'`,
        [opportunityId],
      );
      expect(Number(rows[0]?.count)).toBeGreaterThanOrEqual(1);

      const task = await taskForOpportunity(opportunityId);
      expect(task).toBeUndefined(); // nenhuma task foi criada.
    },
    30_000,
  );
});

describe('Orquestrador — retry e bloqueio (critério 6)', () => {
  /**
   * Fixture inserida direto no banco (como em transitions.test.ts), sem passar
   * pelo DECIDE_OPPORTUNITY real: se a oportunidade fosse descoberta pelo
   * fluxo normal, o DEVELOP_TASK automático rodaria uma sandbox de verdade em
   * paralelo com esta manipulação manual da task — uma corrida que
   * corromperia o teste. Aqui não há nenhum Desenvolvedor real envolvido.
   *
   * `mode: 'hash-mismatch'` prova o portão de integridade (reviewInSandbox
   * recusa sem tocar o Docker — mesma prova de packages/agents/test, aqui no
   * nível do handler). `mode: 'real-failure'` prova que a sandbox do Revisor
   * roda de verdade e que a decisão usa o que ELA observou, não o que o
   * evento IMPLEMENTATION_READY (forjado com build:true) afirma — hash
   * correto, mas solution.test.js reprova de propósito.
   */
  async function seedTaskAwaitingReview(
    retryCount: number,
    mode: 'hash-mismatch' | 'real-failure' = 'hash-mismatch',
  ): Promise<{ taskId: string; opportunityId: string }> {
    const { rows: oppRows } = await pool.query<{ id: string }>(
      `INSERT INTO opportunities (source, source_url, title, status, automation_allowed, ai_allowed)
       VALUES ('teste', $1, 'Oportunidade forjada', 'WORKING', true, true) RETURNING id`,
      [`https://exemplo.test/forjada-${crypto.randomUUID()}`],
    );
    const opportunityId = oppRows[0]!.id;
    const { rows: taskRows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (opportunity_id, objective, status, retry_count) VALUES ($1, 'objetivo forjado', 'IMPLEMENTATION_READY', $2) RETURNING id`,
      [opportunityId, retryCount],
    );
    const taskId = taskRows[0]!.id;
    const correlationId = crypto.randomUUID();

    const resultingFiles: Record<string, string> =
      mode === 'hash-mismatch'
        ? { 'solution.js': 'module.exports = () => 1;' }
        : {
            'solution.js': 'module.exports = () => 1;',
            'solution.test.js': "console.log('TESTES:1:0:1'); process.exit(1);",
          };
    // hash-mismatch: errado de propósito, nem chega a rodar a sandbox.
    // real-failure: correto — o portão de integridade deixa passar, e quem decide é a sandbox.
    const resultingSnapshotHash = mode === 'hash-mismatch' ? '0'.repeat(64) : hashFileSnapshot(resultingFiles);

    await bus.publish({
      type: 'IMPLEMENTATION_READY',
      payload: {
        changed_files: Object.keys(resultingFiles),
        diff: 'auditoria',
        tests: { total: 1, passed: 1, failed: 0 }, // autodeclarado pelo Desenvolvedor — deve ser ignorado no modo real-failure
        build: true, // idem: a decisão real vem da sandbox do Revisor, não daqui
        elapsed_time: 0,
        cost: 0,
        dependencies_added: [],
        notes: 'forjado para teste',
        resulting_files: resultingFiles,
        resulting_snapshot_hash: resultingSnapshotHash,
        developer_sandbox_id: 'sandbox-forjada',
      },
      taskId,
      opportunityId,
      correlationId,
      idempotencyKey: `task:${taskId}:implementation-ready:${retryCount}:forjado`,
    });

    await queues
      .get(QUEUE_NAMES.ORCHESTRATOR)!
      .add(JOB_NAMES.REVIEW_TASK, { taskId, correlationId }, { jobId: `review-task-${taskId}-${retryCount}-forjado` });

    return { taskId, opportunityId };
  }

  it('reprovação com retries disponíveis volta a IN_PROGRESS e reagenda o Desenvolvedor', async () => {
    const { taskId } = await seedTaskAwaitingReview(0);

    await waitFor(
      async () => {
        const { rows } = await pool.query<{ status: string; retry_count: number }>('SELECT status, retry_count FROM tasks WHERE id = $1', [taskId]);
        return rows[0]?.status === 'IN_PROGRESS' ? rows[0] : undefined;
      },
      { timeoutMs: 20_000, label: 'task voltar a IN_PROGRESS após reprovação' },
    );

    const { rows } = await pool.query<{ retry_count: number }>('SELECT retry_count FROM tasks WHERE id = $1', [taskId]);
    expect(rows[0]?.retry_count).toBe(1);
    expect(await eventCount(taskId, 'REVIEW_FAILED')).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it(
    'a sandbox do Revisor roda de verdade e decide pelo que observa, não pelo que o Desenvolvedor autodeclarou',
    async () => {
      // Hash correto (o portão de integridade deixa passar), mas o programa
      // reprova de propósito — e o evento forjado afirma build:true e testes
      // 1/1/0. Se a decisão usasse o autodeclarado, isto passaria; como usa o
      // que a sandbox do Revisor observa, precisa reprovar.
      const { taskId } = await seedTaskAwaitingReview(0, 'real-failure');

      await waitFor(
        async () => {
          const { rows } = await pool.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [taskId]);
          return rows[0]?.status === 'IN_PROGRESS' ? rows[0].status : undefined;
        },
        { timeoutMs: 30_000, label: 'task voltar a IN_PROGRESS após reprovação real da sandbox' },
      );

      const { rows } = await pool.query<{ payload: { review_sandbox_id: string | null; tests: { failed: number } } }>(
        `SELECT payload FROM events WHERE task_id = $1 AND type = 'REVIEW_FAILED' ORDER BY occurred_at DESC LIMIT 1`,
        [taskId],
      );
      // review_sandbox_id só existe quando reviewInSandbox chegou a rodar o container
      // (no portão de hash divergente ele vem undefined/null) — prova que a sandbox rodou de verdade.
      expect(rows[0]?.payload.review_sandbox_id).toBeTruthy();
      expect(rows[0]?.payload.tests.failed).toBeGreaterThanOrEqual(1);
    },
    30_000,
  );

  it('reprovação após esgotar MAX_TASK_RETRIES bloqueia a task e falha a oportunidade', async () => {
    const { taskId, opportunityId } = await seedTaskAwaitingReview(governor.limits.MAX_TASK_RETRIES);

    await waitFor(
      async () => {
        const { rows } = await pool.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [taskId]);
        return rows[0]?.status === 'BLOCKED' ? rows[0].status : undefined;
      },
      { timeoutMs: 20_000, label: 'task ser bloqueada após esgotar retries' },
    );

    expect(await eventCount(taskId, 'TASK_BLOCKED')).toBeGreaterThanOrEqual(1);
    expect(await opportunityStatus(opportunityId)).toBe('FAILED');
  }, 30_000);
});

describe('Orquestrador — MAX_PARALLEL_TASKS (critério 9)', () => {
  it(
    'sem slot: task espera (TASK_WAITING_SLOT) sem consumir retries, e retoma sozinha quando um slot libera',
    async () => {
      // Ocupa todos os slots (não precisam ser reais/completos — só ocupar a contagem).
      const occupantTaskIds: string[] = [];
      for (let i = 0; i < governor.limits.MAX_PARALLEL_TASKS; i += 1) {
        const { rows } = await pool.query<{ id: string }>(
          `INSERT INTO opportunities (source, source_url, title, status, automation_allowed, ai_allowed)
           VALUES ('teste', $1, 'Ocupante', 'WORKING', true, true) RETURNING id`,
          [`https://exemplo.test/ocupante-${i}-${crypto.randomUUID()}`],
        );
        const task = await pool.query<{ id: string }>(
          `INSERT INTO tasks (opportunity_id, objective, status) VALUES ($1, 'ocupante', 'IN_PROGRESS') RETURNING id`,
          [rows[0]!.id],
        );
        occupantTaskIds.push(task.rows[0]!.id);
      }

      const { opportunityId } = await discoverOpportunity();
      const task = await waitFor(async () => await taskForOpportunity(opportunityId), {
        timeoutMs: 30_000,
        label: 'task extra criada além do limite de paralelismo',
      });

      // Espera operacional, não falha: TASK_WAITING_SLOT é publicado, a task
      // continua ASSIGNED e MAX_TASK_RETRIES não é tocado (retry_count é
      // orçamento de execução/revisão, não de agendamento).
      await waitFor(
        async () => (await eventCount(task.id, 'TASK_WAITING_SLOT')) > 0 || undefined,
        { timeoutMs: 15_000, label: 'TASK_WAITING_SLOT ser publicado enquanto não há slot' },
      );
      const stillWaiting = await taskForOpportunity(opportunityId);
      expect(stillWaiting?.status).toBe('ASSIGNED');
      expect(stillWaiting?.retry_count).toBe(0);

      // Libera um slot: a task extra deve retomar sozinha, sem qualquer
      // intervenção — prova que a espera não é um beco sem saída permanente
      // (o comportamento antigo, que este teste substitui).
      await pool.query(`UPDATE tasks SET status = 'COMPLETED' WHERE id = $1`, [occupantTaskIds[0]]);

      const completed = await waitFor(
        async () => {
          const current = await taskForOpportunity(opportunityId);
          return current?.status === 'COMPLETED' ? current : undefined;
        },
        { timeoutMs: 30_000, label: 'task extra retomar e chegar a COMPLETED após liberar um slot' },
      );
      expect(completed.retry_count).toBe(0);
      expect(await opportunityStatus(opportunityId)).toBe('SUBMITTED');
    },
    60_000,
  );
});

describe('Orquestrador — crash recovery (decisão da revisão externa do fechamento do M2)', () => {
  /**
   * CRASH RECOVERY foi validado funcionalmente por abandono forçado de um job
   * ativo usando worker.close(true), seguido de detecção/reentrega pelo
   * mecanismo de stalled jobs do BullMQ e retomada por uma nova instância de
   * Worker. O M2 não executou SIGKILL de um processo Node separado do sistema
   * operacional devido à restrição de recursos da máquina de desenvolvimento
   * (8GB de RAM) — decisão explícita da revisão externa (opção B), registrada
   * em docs/M2-PLANO.md e docs/M2-PRIMEIRO-CICLO.md. Teste de crash em
   * processo isolado do SO (SIGKILL/container kill) fica como evolução
   * futura, em ambiente com recursos adequados (ex.: CI).
   *
   * Para que o "abandono" seja real (e não a promise da Worker A terminando
   * o job em segundo plano por coincidência — fechar um Worker não cancela
   * um processador já em execução em JavaScript), o Worker A desta task usa
   * um SandboxManager que nunca resolve: o job fica genuinamente preso dentro
   * do passo do Desenvolvedor, sem nenhuma chance de completar sozinho. O
   * Worker B usa o SandboxManager real e é quem de fato termina o ciclo —
   * prova de que quem recuperou foi o mecanismo de stalled job do BullMQ
   * relendo o estado do PostgreSQL, não uma coincidência de timing.
   */
  it(
    'Worker A trava (job nunca resolve) e é fechado à força; Worker B detecta o stalled job, relê o PostgreSQL e completa o ciclo sem duplicar nada',
    async () => {
      // Worker A nunca deveria competir pelo job de teste com o worker padrão
      // do beforeEach — fecha-o para este teste não ter dois consumidores na
      // mesma fila.
      await worker.close();

      const shortLock = { lockDuration: 1_500, stalledInterval: 500 };
      const hangingSandbox = { run: () => new Promise<never>(() => {}) } as unknown as SandboxManager;
      const realSandboxManager = new SandboxManager(createDockerClient(), logger);

      const connA = createRedisConnection(testRedisUrl(), 'consumer', 'crash-test-worker-a');
      const connB = createRedisConnection(testRedisUrl(), 'consumer', 'crash-test-worker-b');
      const workerA = createOrchestratorWorker({
        connection: connA,
        prefix,
        pool,
        governor,
        sandboxManager: hangingSandbox,
        logger,
        ...shortLock,
      });
      await workerA.waitUntilReady();

      try {
        const { opportunityId } = await discoverOpportunity();
        const task = await waitFor(async () => await taskForOpportunity(opportunityId), {
          timeoutMs: 30_000,
          label: 'task criada para a oportunidade',
        });

        // Ponto do crash: dentro do passo do Desenvolvedor (a janela mais
        // longa do ciclo, como orientado pela revisão externa) — o evento
        // CODING confirma que o job já está ativo no Worker A, preso no
        // SandboxManager que nunca resolve.
        await waitFor(
          async () => {
            const { rows } = await pool.query<{ count: string }>(
              `SELECT count(*)::text AS count FROM events
                WHERE task_id = $1 AND type = 'AGENT_STATE_CHANGED' AND payload->>'newState' = 'CODING'`,
              [task.id],
            );
            return Number(rows[0]?.count ?? 0) > 0 || undefined;
          },
          { timeoutMs: 15_000, label: 'Worker A entrar no passo do Desenvolvedor (CODING)' },
        );

        // "Crash": fecha à força, sem esperar o job (que nunca terminaria
        // sozinho — está preso no SandboxManager que nunca resolve). O lock
        // do job para de ser renovado a partir daqui.
        await workerA.close(true);

        // Worker B: instância nova, SandboxManager real, mesma fila. Só
        // assume o job depois que o BullMQ detectar o lock expirado
        // (stalledInterval curto) e marcar como stalled — não porque algum
        // job novo foi criado pelo Orquestrador.
        const workerB = createOrchestratorWorker({
          connection: connB,
          prefix,
          pool,
          governor,
          sandboxManager: realSandboxManager,
          logger,
          ...shortLock,
        });
        await workerB.waitUntilReady();

        try {
          const stalledSeen = new Promise<void>((resolve) => workerB.once('stalled', () => resolve()));
          await stalledSeen;

          const completed = await waitFor(
            async () => {
              const current = await taskForOpportunity(opportunityId);
              return current?.status === 'COMPLETED' ? current : undefined;
            },
            { timeoutMs: 60_000, label: 'Worker B retomar do PostgreSQL e completar o ciclo' },
          );

          // Estado final conhecido, sem bypass do Governor (chegou a
          // COMPLETED pelo caminho normal) e sem consumo indevido de retry.
          expect(completed.retry_count).toBe(0);
          expect(await opportunityStatus(opportunityId)).toBe('SUBMITTED');

          // Nenhuma duplicação crítica: cada evento-chave da transição em
          // voo no momento do crash aparece exatamente uma vez — a
          // idempotencyKey (packages/events/src/transitions.ts) garantiu que
          // só uma tentativa (a do Worker B) commitou, mesmo com dois
          // Workers tendo processado o mesmo job.
          for (const type of ['TASK_STARTED', 'IMPLEMENTATION_READY', 'REVIEW_STARTED', 'REVIEW_PASSED', 'TASK_COMPLETED']) {
            expect(await eventCount(task.id, type)).toBe(1);
          }
        } finally {
          await workerB.close();
          await connB.quit();
        }
      } finally {
        await connA.quit();
      }
    },
    90_000,
  );
});
