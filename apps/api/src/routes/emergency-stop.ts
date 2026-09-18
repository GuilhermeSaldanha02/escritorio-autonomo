import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { EmergencyStopService, releaseAndResume } from '@escritorio/autonomy';
import type { Pool } from '@escritorio/database';
import type { Governor } from '@escritorio/governor';

export interface EmergencyStopRoutesDeps {
  pool: Pool;
  governor: Governor;
  /** Segredo do fundador, lido só do ambiente da API. */
  adminSecret: string;
}

const reasonBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

function secretMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Porta HTTP do fundador para o Emergency Stop (M6, critério 5). É só uma entrada para o
 * `EmergencyStopService`: nenhuma regra mora aqui. Só é registrada quando o segredo existe
 * no ambiente; sem ele a rota é 404, não "não autorizado".
 */
export async function emergencyStopRoutes(app: FastifyInstance, deps: EmergencyStopRoutesDeps): Promise<void> {
  const service = new EmergencyStopService(deps.pool);
  const attempts = deps.governor.limits.MAX_TASK_RETRIES + 1;

  app.addHook('onRequest', async (request, reply) => {
    if (!secretMatches(request.headers['x-admin-secret'], deps.adminSecret)) {
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
    }
  });

  app.get('/admin/emergency-stop', async () => ({ state: await service.state() }));

  app.post('/admin/emergency-stop', async (request, reply) => {
    const body = reasonBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'VALIDATION_ERROR', issues: z.treeifyError(body.error) });
    return { transition: await service.engage('FOUNDER_API', body.data.reason) };
  });

  app.post('/admin/emergency-stop/release', async (request, reply) => {
    const body = reasonBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'VALIDATION_ERROR', issues: z.treeifyError(body.error) });
    return releaseAndResume(deps.pool, 'FOUNDER_API', body.data.reason, attempts);
  });
}
