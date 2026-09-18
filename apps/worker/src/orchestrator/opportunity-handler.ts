import type { Job } from 'bullmq';
import { authorizeExecution, decide } from '@escritorio/agents';
import type { AiGateway } from '@escritorio/ai';
import { type Pool, withTransaction } from '@escritorio/database';
import {
  type DecideOpportunityJobData,
  JOB_NAMES,
  QUEUE_NAMES,
  transitionOpportunity,
  transitionOpportunityIn,
  transitionTaskIn,
} from '@escritorio/events';
import type { Governor } from '@escritorio/governor';
import type { Logger } from '@escritorio/shared';
import { opportunityRequiredCapabilities, opportunityRowToContract, type OpportunityRow } from './mappers.js';

export interface OpportunityHandlerDeps {
  pool: Pool;
  governor: Governor;
  aiGateway: AiGateway;
  logger: Logger;
}

async function loadOpportunity(pool: Pool, id: string): Promise<OpportunityRow | undefined> {
  const { rows } = await pool.query<OpportunityRow>(
    `SELECT id, source, source_url, title, reward_amount, reward_currency, reward_verified,
            requirements, deadline, ai_allowed, automation_allowed, payment_method, evidence,
            confidence, status, required_capabilities
       FROM opportunities WHERE id = $1`,
    [id],
  );
  return rows[0];
}

/** Reaproveita a task existente da oportunidade se já foi criada (reentrega tardia); nunca cria duas. */
async function findOrCreateTask(
  pool: Pool,
  opportunityId: string,
  objective: string,
  acceptanceCriteria: readonly string[],
): Promise<string> {
  const existing = await pool.query<{ id: string }>(`SELECT id FROM tasks WHERE opportunity_id = $1 LIMIT 1`, [opportunityId]);
  if (existing.rows[0]) return existing.rows[0].id;

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO tasks (opportunity_id, objective, acceptance_criteria, assigned_agent_id)
     VALUES ($1, $2, $3::jsonb, 'DESENVOLVEDOR-001') RETURNING id`,
    [opportunityId, objective, JSON.stringify(acceptanceCriteria)],
  );
  return inserted.rows[0]!.id;
}

/**
 * Processa `decide-opportunity`: leva a oportunidade de DISCOVERED até
 * APPROVED+task criada, ou até REJECTED (recusa do Diretor ou do Governor).
 *
 * Idempotente por leitura de estado: cada bloco só age se a oportunidade
 * ainda está no status que ele espera, então uma reentrega tardia do BullMQ
 * (at-least-once) não repete um passo já commitado — ela só avança a partir
 * de onde o banco realmente está.
 */
export function createOpportunityHandler({ pool, governor, aiGateway, logger }: OpportunityHandlerDeps) {
  return async function handleDecideOpportunity(job: Job<DecideOpportunityJobData>): Promise<void> {
    const { opportunityId, correlationId } = job.data;
    let opportunity = await loadOpportunity(pool, opportunityId);
    if (!opportunity) {
      logger.warn({ opportunityId }, 'opportunity não encontrada — job ignorado');
      return;
    }

    if (opportunity.status === 'DISCOVERED') {
      await transitionOpportunity(pool, {
        id: opportunityId,
        from: 'DISCOVERED',
        to: 'VERIFYING',
        actor: { kind: 'system', component: 'ORCHESTRATOR' },
        idempotencyKey: `opportunity:${opportunityId}:verifying`,
        event: { type: 'OPPORTUNITY_VERIFYING', payload: {}, opportunityId, correlationId },
      });
      opportunity = await loadOpportunity(pool, opportunityId);
      if (!opportunity) return;
    }

    if (opportunity.status === 'VERIFYING') {
      // Verificação determinística (§19): sem dados mínimos, a oportunidade é inválida — não é decisão do Diretor, é checagem de forma.
      const verifiable = opportunity.automation_allowed !== null && opportunity.ai_allowed !== null;
      await transitionOpportunity(pool, {
        id: opportunityId,
        from: 'VERIFYING',
        to: verifiable ? 'VERIFIED' : 'INVALID',
        actor: { kind: 'system', component: 'ORCHESTRATOR' },
        idempotencyKey: `opportunity:${opportunityId}:verified`,
        event: {
          type: verifiable ? 'OPPORTUNITY_VERIFIED' : 'OPPORTUNITY_REJECTED',
          payload: { reason: verifiable ? 'verificação determinística ok' : 'automation_allowed/ai_allowed ausentes' },
          opportunityId,
          correlationId,
        },
      });
      if (!verifiable) return;
      opportunity = await loadOpportunity(pool, opportunityId);
      if (!opportunity) return;
    }

    if (opportunity.status === 'VERIFIED') {
      await transitionOpportunity(pool, {
        id: opportunityId,
        from: 'VERIFIED',
        to: 'EVALUATING',
        actor: { kind: 'system', component: 'ORCHESTRATOR' },
        idempotencyKey: `opportunity:${opportunityId}:evaluating`,
        event: { type: 'OPPORTUNITY_EVALUATING', payload: {}, opportunityId, correlationId },
      });
      opportunity = await loadOpportunity(pool, opportunityId);
      if (!opportunity) return;
    }

    if (opportunity.status === 'EVALUATING') {
      const requiredCapabilities = opportunityRequiredCapabilities(opportunity);
      const decision = decide(opportunityRowToContract(opportunity), { requiredCapabilities });
      const authorization = authorizeExecution(decision, governor);

      if (decision.decision === 'REJECT') {
        await transitionOpportunity(pool, {
          id: opportunityId,
          from: 'EVALUATING',
          to: 'REJECTED',
          actor: { kind: 'system', component: 'ORCHESTRATOR' },
          idempotencyKey: `opportunity:${opportunityId}:rejected`,
          event: { type: 'OPPORTUNITY_REJECTED', payload: { reasoning: decision.reasoning_summary }, opportunityId, correlationId },
        });
        return;
      }

      if (decision.decision !== 'EXECUTE') {
        // BACKLOG/INVESTIGATE: o ciclo do M2 não modela reavaliação futura — fica em EVALUATING, sem task. Fora do escopo do M2 (§19: provar o fluxo feliz e os bloqueios, não o backlog).
        logger.info({ opportunityId, decision: decision.decision, score: decision.score }, 'Diretor não decidiu executar agora');
        return;
      }

      if (!authorization.allowed) {
        await transitionOpportunity(pool, {
          id: opportunityId,
          from: 'EVALUATING',
          to: 'REJECTED',
          actor: { kind: 'system', component: 'ORCHESTRATOR' },
          idempotencyKey: `opportunity:${opportunityId}:blocked`,
          event: {
            type: 'ACTION_BLOCKED',
            payload: {
              rule: authorization.rule,
              reason: authorization.reason,
              action: { opportunityId, requiredCapabilities: decision.required_capabilities },
              source: { queue: QUEUE_NAMES.ORCHESTRATOR, jobId: String(job.id ?? 'desconhecido') },
            },
            opportunityId,
            correlationId,
          },
        });
        return; // nenhuma task é criada — critério 7 do M2.
      }

      // M3, critério 13: ao menos um ciclo do Orquestrador usa o AI Gateway
      // de verdade (AI_MODE=mock). Nota de auditoria só — não influencia a
      // decisão, que já foi tomada por `decide()`/`authorizeExecution()`
      // (critério 8: nenhum LLM participa da decisão final de autorização).
      await aiGateway.complete({
        agentId: 'DIRETOR-001',
        correlationId,
        prompt: `Resuma em uma frase por que a oportunidade "${opportunity.title}" foi aprovada (score ${decision.score}).`,
      });

      await transitionOpportunity(pool, {
        id: opportunityId,
        from: 'EVALUATING',
        to: 'APPROVED',
        actor: { kind: 'system', component: 'ORCHESTRATOR' },
        idempotencyKey: `opportunity:${opportunityId}:approved`,
        event: { type: 'OPPORTUNITY_APPROVED', payload: { score: decision.score, risk: decision.risk }, opportunityId, correlationId },
      });
      opportunity = await loadOpportunity(pool, opportunityId);
      if (!opportunity) return;
    }

    if (opportunity.status !== 'APPROVED') return; // reentrega tardia sobre um estado já resolvido de outra forma (REJECTED/INVALID/...).

    // Reentrega tardia pode achar a task já criada (findOrCreateTask é idempotente) sem a transação de baixo ter comitado ainda.
    const taskId = await findOrCreateTask(pool, opportunityId, opportunity.title, opportunity.requirements);

    await withTransaction(pool, async (tx) => {
      await transitionOpportunityIn(tx, {
        id: opportunityId,
        from: 'APPROVED',
        to: 'WORKING',
        actor: { kind: 'system', component: 'ORCHESTRATOR' },
        idempotencyKey: `opportunity:${opportunityId}:working`,
        event: { type: 'TASK_CREATED', payload: { taskId }, opportunityId, taskId, correlationId },
      });
      await transitionTaskIn(tx, {
        id: taskId,
        from: 'CREATED',
        to: 'ASSIGNED',
        idempotencyKey: `task:${taskId}:assigned`,
        event: { type: 'TASK_ASSIGNED', payload: { agentId: 'DESENVOLVEDOR-001' }, taskId, opportunityId, correlationId },
        dispatch: {
          queue: QUEUE_NAMES.ORCHESTRATOR,
          jobName: JOB_NAMES.DEVELOP_TASK,
          data: () => ({ taskId, correlationId }),
          attempts: governor.limits.MAX_TASK_RETRIES + 1,
          jobId: `develop-task-${taskId}-0`,
        },
      });
    });
  };
}
