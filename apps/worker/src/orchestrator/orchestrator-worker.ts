import { type Job, UnrecoverableError, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { AiGateway, ModelRouter } from '@escritorio/ai';
import {
  AutonomyController,
  breakerPolicyFrom,
  CircuitBreakerStore,
  createJobGate,
  QuiescenceGuard,
  stopReaderFor,
  WorkPausedError,
} from '@escritorio/autonomy';
import type { SourceConnector } from '@escritorio/cacador';
import { classifyRetry, EventBus, isRetryableTechnicalError, JOB_NAMES, QUEUE_NAMES } from '@escritorio/events';
import type { Governor } from '@escritorio/governor';
import type { Pool } from '@escritorio/database';
import type { SandboxManager } from '@escritorio/tools';
import { ToolGateway } from '@escritorio/tool-gateway';
import { describeError, type Logger } from '@escritorio/shared';
import { createDevelopmentHandler } from './development-handler.js';
import { createDiscoveryHandler } from './discovery-handler.js';
import { createExperienceHandler } from './experience-handler.js';
import { createOpportunityHandler } from './opportunity-handler.js';
import { createReviewHandler } from './review-handler.js';

export interface OrchestratorWorkerDeps {
  connection: Redis;
  prefix: string;
  pool: Pool;
  governor: Governor;
  sandboxManager: SandboxManager;
  /** Source Connector real do Caçador (M4) — quem constrói escolhe a fonte (ex.: GitHubConnector). */
  connector: SourceConnector;
  logger: Logger;
  /** Repassado ao development-handler — testável sem esperar o atraso real de produção. */
  waitSlotDelayMs?: number;
  /**
   * Padrão do BullMQ (30s/30s) em produção. Testáveis para o teste de crash
   * recovery (revisão externa do fechamento do M2): sem isso, esperar um job
   * abandonado ser detectado como stalled levaria 30s ou mais por teste.
   */
  lockDuration?: number;
  stalledInterval?: number;
}

/**
 * Consumidor da fila `orchestrator` — um job por transição do ciclo (§8.1):
 * `decide-opportunity` (Diretor), `develop-task` (Desenvolvedor em sandbox),
 * `review-task` (Revisor em sandbox independente), `discover-opportunities`
 * (Caçador — M4, roda o SourceConnector real e publica `OPPORTUNITY_FOUND`
 * só para o que a Promotion Policy liberou). Cada handler é idempotente
 * por leitura de estado (packages/events/src/transitions.ts é quem garante
 * atomicidade), então uma reentrega do BullMQ nunca duplica trabalho nem pula
 * uma transição.
 *
 * Concorrência = MAX_PARALLEL_TASKS da Constituição — garantia real só para
 * um único processo Worker (V1); com múltiplos workers, o Governor também
 * checa `TASK_START` antes de cada task começar (development-handler.ts),
 * mas um limite verdadeiramente global entre processos fica para depois do M2.
 */
export function createOrchestratorWorker({
  connection,
  prefix,
  pool,
  governor,
  sandboxManager,
  connector,
  logger,
  waitSlotDelayMs,
  lockDuration,
  stalledInterval,
}: OrchestratorWorkerDeps): Worker {
  // Critério 7/12 do M3: o Sandbox Manager cru não vai mais direto para os
  // handlers — toda execução de código passa pelo Tool Gateway (orçamento +
  // capacidade) primeiro. `GovernedSandbox` (packages/tool-gateway) satisfaz
  // a mesma forma que `SandboxManager` tinha, então development-handler.ts
  // e review-handler.ts (e packages/agents por baixo) não mudam de forma.
  // M6: o ÚNICO controlador de autonomia (Emergency Stop, circuito, Governor).
  // Os três pontos de estrangulamento o usam: o portão de jobs abaixo, o Tool
  // Gateway e o AI Gateway. Nenhum handler repete essa lógica.
  const breakers = new CircuitBreakerStore(pool, breakerPolicyFrom(governor));
  const controller = new AutonomyController({ governor, stop: stopReaderFor(pool), breakers });
  const jobGate = createJobGate({ pool, controller, sourceKey: connector.source });

  const quiescence = new QuiescenceGuard({ db: pool, stop: stopReaderFor(pool), timeoutMs: governor.autonomy.EMERGENCY_QUIESCENCE_TIMEOUT_SECONDS * 1000 });
  const toolGateway = new ToolGateway({ pool, governor, sandboxManager, logger, autonomy: controller, quiescence });
  // M3, critério 13: o Diretor consulta o AI Gateway de verdade (AI_MODE
  // sempre mock nesta fase — ver docs/M3-PLANO.md) só para uma nota de
  // auditoria; a decisão em si continua vindo de decide()/authorizeExecution().
  const aiGateway = new AiGateway({ pool, governor, router: new ModelRouter({ mode: 'mock' }), logger, autonomy: controller, quiescence });
  const handleDecideOpportunity = createOpportunityHandler({ pool, governor, aiGateway, logger });
  const handleDevelopTask = createDevelopmentHandler({ pool, governor, toolGateway, logger, waitSlotDelayMs });
  const handleReviewTask = createReviewHandler({ pool, governor, toolGateway, logger });
  const handleDiscoverOpportunities = createDiscoveryHandler({ pool, bus: new EventBus(pool), governor, connector, logger, breakers });
  const handleRecordExperience = createExperienceHandler({ pool, logger, breakers });

  async function runJob(job: Job): Promise<unknown> {
    switch (job.name) {
      case JOB_NAMES.DECIDE_OPPORTUNITY:
        return handleDecideOpportunity(job);
      case JOB_NAMES.DEVELOP_TASK:
        return handleDevelopTask(job);
      case JOB_NAMES.REVIEW_TASK:
        return handleReviewTask(job);
      case JOB_NAMES.DISCOVER_OPPORTUNITIES:
        return handleDiscoverOpportunities(job);
      case JOB_NAMES.RECORD_EXPERIENCE:
        return handleRecordExperience(job);
      default:
        throw new UnrecoverableError(`Job desconhecido na fila ${QUEUE_NAMES.ORCHESTRATOR}: ${job.name}`);
    }
  }

  const worker = new Worker(
    QUEUE_NAMES.ORCHESTRATOR,
    async (job) => {
      // Pausa não é falha: um job barrado retorna normalmente (lançar consumiria
      // uma tentativa do BullMQ) e o trabalho fica registrado em `paused_work`.
      const decision = await jobGate.admit(job);
      if (!decision.admitted) {
        logger.info({ jobId: job.id, jobName: job.name, gate: decision.gate, reason: decision.reason }, 'job pausado');
        return;
      }
      try {
        return await runJob(job);
      } catch (error) {
        // Pausa no MEIO do job (Stop engajado durante uma chamada de ferramenta ou de IA):
        // registra a pausa explicitamente e retorna, sem tentativa consumida. Não reavalia o
        // portão, que já pode ter liberado, para o trabalho nunca se perder.
        if (error instanceof WorkPausedError) {
          logger.info({ jobId: job.id, jobName: job.name, gate: error.gate }, 'job pausado no meio da execução');
          await jobGate.pause(job, error.gate, error.reason);
          return;
        }
        // Erro de programação, de validação ou irrecuperável: repetir só gasta tentativa
        // (critério 14). Os demais seguem o backoff técnico do outbox, sem tocar em retry_count.
        if (!isRetryableTechnicalError(error)) {
          throw new UnrecoverableError(error instanceof Error ? error.message : String(error));
        }
        throw error;
      }
    },
    {
      connection,
      prefix,
      concurrency: governor.limits.MAX_PARALLEL_TASKS,
      // Object.assign com defaults do BullMQ: uma chave presente com valor
      // undefined sobrescreveria o default (30s) por undefined e quebraria a
      // validação interna — só inclui quando explicitamente definido.
      ...(lockDuration !== undefined ? { lockDuration } : {}),
      ...(stalledInterval !== undefined ? { stalledInterval } : {}),
    },
  );

  worker.on('failed', (job, error) => {
    logger.error(
      {
        jobId: job?.id,
        jobName: job?.name,
        attemptsMade: job?.attemptsMade,
        retryClass: classifyRetry({ kind: 'ERROR', error }),
        err: describeError(error),
      },
      'job do orquestrador falhou',
    );
  });
  worker.on('error', (error) => {
    logger.error({ err: describeError(error) }, 'erro no Worker do orquestrador');
  });

  return worker;
}
