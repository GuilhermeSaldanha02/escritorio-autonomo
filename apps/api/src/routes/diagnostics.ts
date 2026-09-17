import type { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type EventBus, type EventStore, requestDiagnosticJob } from '@escritorio/events';
import { GOVERNED_CAPABILITY_NAMES, type Governor } from '@escritorio/governor';

interface DiagnosticsDeps {
  bus: EventBus;
  store: EventStore;
  queue: Queue;
  governor: Governor;
}

const createBody = z
  .object({
    message: z.string().trim().min(1).max(280).default('ping'),
    requestedCapability: z.enum(GOVERNED_CAPABILITY_NAMES).optional(),
  })
  .strict();

const listQuery = z.object({ correlationId: z.uuid() }).strict();

/**
 * Rotas de diagnóstico do M1: disparar um job de teste e consultar os eventos
 * que ele gerou. É a prova de ponta a ponta API → fila → Worker → banco.
 */
export async function diagnosticsRoutes(app: FastifyInstance, deps: DiagnosticsDeps): Promise<void> {
  app.post('/diagnostics/test-jobs', async (request, reply) => {
    const body = createBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', issues: z.treeifyError(body.error) });
    }

    const result = await requestDiagnosticJob(deps.bus, deps.queue, deps.governor, body.data);
    return reply.code(202).send({
      jobId: result.jobId,
      requestEventId: result.event.id,
      correlationId: result.event.correlationId,
      eventsUrl: `/events?correlationId=${result.event.correlationId}`,
    });
  });

  app.get('/events', async (request, reply) => {
    const query = listQuery.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', issues: z.treeifyError(query.error) });
    }
    const events = await deps.store.listByCorrelation(query.data.correlationId);
    return reply.send({ events });
  });
}
