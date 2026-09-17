import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Queryable } from '@escritorio/database';
import { EventBus, JOB_NAMES, QUEUE_NAMES } from '@escritorio/events';
import { GOVERNED_CAPABILITY_NAMES, type Governor } from '@escritorio/governor';

interface SimulationsDeps {
  db: Queryable;
  bus: EventBus;
  governor: Governor;
}

/**
 * Todos os campos têm padrão que já produz EXECUTE no Diretor mock (§19: o
 * ponto é provar o fluxo alvo do M2 sem exigir do chamador conhecer a
 * fórmula de score) — quem quiser testar REJECT/BACKLOG/ACTION_BLOCKED
 * ajusta os campos relevantes.
 */
const createOpportunityBody = z
  .object({
    title: z.string().trim().min(1).max(280).default('Oportunidade simulada'),
    rewardAmount: z.number().min(0).default(500),
    rewardCurrency: z.string().length(3).default('BRL'),
    rewardVerified: z.boolean().default(true),
    aiAllowed: z.boolean().default(true),
    automationAllowed: z.boolean().default(true),
    confidence: z.number().min(0).max(1).default(0.95),
    requiredCapabilities: z.array(z.enum(GOVERNED_CAPABILITY_NAMES)).default([]),
  })
  .strict();

const timelineParams = z.object({ id: z.uuid() }).strict();

interface OpportunityRow {
  id: string;
  source: string;
  source_url: string;
  title: string;
  reward_amount: string | null;
  reward_currency: string | null;
  reward_verified: boolean;
  status: string;
  required_capabilities: string[];
  created_at: Date;
  updated_at: Date;
}

interface TaskRow {
  id: string;
  opportunity_id: string | null;
  objective: string;
  status: string;
  retry_count: number;
  created_at: Date;
  updated_at: Date;
}

interface EventRow {
  id: string;
  type: string;
  payload: unknown;
  agent_id: string | null;
  task_id: string | null;
  opportunity_id: string | null;
  correlation_id: string | null;
  occurred_at: Date;
}

/**
 * §19 do M2: simula o Caçador descobrindo uma oportunidade (`OPPORTUNITY_FOUND`
 * → outbox → `decide-opportunity`) e expõe a linha do tempo completa do ciclo
 * — o que o Office 2D (fora do escopo do M2) vai consumir mais tarde.
 */
export async function simulationsRoutes(app: FastifyInstance, deps: SimulationsDeps): Promise<void> {
  app.post('/simulations/opportunities', async (request, reply) => {
    const body = createOpportunityBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', issues: z.treeifyError(body.error) });
    }
    const d = body.data;

    const { rows } = await deps.db.query<{ id: string }>(
      `INSERT INTO opportunities
         (source, source_url, title, reward_amount, reward_currency, reward_verified,
          ai_allowed, automation_allowed, payment_method, confidence, required_capabilities)
       VALUES ('simulacao', $1, $2, $3, $4, $5, $6, $7, 'pix', $8, $9)
       RETURNING id`,
      [
        `https://simulacao.local/${crypto.randomUUID()}`,
        d.title,
        d.rewardAmount,
        d.rewardCurrency,
        d.rewardVerified,
        d.aiAllowed,
        d.automationAllowed,
        d.confidence,
        d.requiredCapabilities,
      ],
    );
    const opportunityId = rows[0]!.id;
    const correlationId = crypto.randomUUID();

    const result = await deps.bus.publish(
      { type: 'OPPORTUNITY_FOUND', payload: { source: 'simulacao', title: d.title }, opportunityId, correlationId },
      {
        queue: QUEUE_NAMES.ORCHESTRATOR,
        jobName: JOB_NAMES.DECIDE_OPPORTUNITY,
        data: () => ({ opportunityId, correlationId }),
        attempts: deps.governor.limits.MAX_TASK_RETRIES + 1,
        jobId: `decide-opportunity-${opportunityId}`,
      },
    );

    return reply.code(202).send({
      opportunityId,
      correlationId,
      eventId: result.event.id,
      timelineUrl: `/opportunities/${opportunityId}/timeline`,
    });
  });

  app.get('/opportunities/:id/timeline', async (request, reply) => {
    const params = timelineParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', issues: z.treeifyError(params.error) });
    }
    const { id } = params.data;

    const opportunity = await deps.db.query<OpportunityRow>(
      `SELECT id, source, source_url, title, reward_amount, reward_currency, reward_verified,
              status, required_capabilities, created_at, updated_at
         FROM opportunities WHERE id = $1`,
      [id],
    );
    const opportunityRow = opportunity.rows[0];
    if (!opportunityRow) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: `Oportunidade ${id} não existe.` });
    }

    const tasks = await deps.db.query<TaskRow>(
      `SELECT id, opportunity_id, objective, status, retry_count, created_at, updated_at
         FROM tasks WHERE opportunity_id = $1`,
      [id],
    );
    const taskIds = tasks.rows.map((task) => task.id);

    const events = await deps.db.query<EventRow>(
      `SELECT id, type, payload, agent_id, task_id, opportunity_id, correlation_id, occurred_at
         FROM events
        WHERE opportunity_id = $1 OR task_id = ANY($2::uuid[])
        ORDER BY occurred_at, id`,
      [id, taskIds],
    );

    return reply.send({
      opportunity: opportunityRow,
      task: tasks.rows[0] ?? null,
      events: events.rows,
    });
  });
}
