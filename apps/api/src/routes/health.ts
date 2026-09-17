import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { Queryable } from '@escritorio/database';
import { type AiMode, describeError, withTimeout } from '@escritorio/shared';

const CHECK_TIMEOUT_MS = 2_000;

export interface DependencyCheck {
  status: 'connected' | 'disconnected';
  latencyMs: number;
  /** Só o código/nome do erro: detalhes internos ficam no log, não na resposta. */
  error?: string;
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  api: 'up';
  database: DependencyCheck;
  redis: DependencyCheck;
  aiMode: AiMode;
  uptimeSeconds: number;
  checkedAt: string;
}

interface HealthDeps {
  db: Queryable;
  redis: Redis;
  aiMode: AiMode;
}

interface CheckOutcome {
  report: DependencyCheck;
  cause?: unknown;
}

async function check(label: string, probe: () => Promise<unknown>): Promise<CheckOutcome> {
  const startedAt = performance.now();
  const elapsed = () => Math.round(performance.now() - startedAt);
  try {
    await withTimeout(probe(), CHECK_TIMEOUT_MS, label);
    return { report: { status: 'connected', latencyMs: elapsed() } };
  } catch (error) {
    const described = describeError(error);
    return {
      report: { status: 'disconnected', latencyMs: elapsed(), error: described.code ?? described.name },
      cause: error,
    };
  }
}

/** GET /health: 200 só quando API, PostgreSQL e Redis respondem; 503 caso contrário. */
export async function healthRoutes(app: FastifyInstance, { db, redis, aiMode }: HealthDeps): Promise<void> {
  app.get('/health', async (request, reply) => {
    const [database, redisCheck] = await Promise.all([
      check('PostgreSQL', () => db.query('SELECT 1')),
      check('Redis', () => redis.ping()),
    ]);

    for (const [name, outcome] of [['database', database], ['redis', redisCheck]] as const) {
      if (outcome.report.status === 'disconnected') {
        request.log.warn({ dependency: name, err: describeError(outcome.cause) }, 'dependência indisponível');
      }
    }

    const healthy = database.report.status === 'connected' && redisCheck.report.status === 'connected';
    const report: HealthReport = {
      status: healthy ? 'ok' : 'degraded',
      api: 'up',
      database: database.report,
      redis: redisCheck.report,
      aiMode,
      uptimeSeconds: Math.round(process.uptime()),
      checkedAt: new Date().toISOString(),
    };
    return reply.code(healthy ? 200 : 503).send(report);
  });
}
