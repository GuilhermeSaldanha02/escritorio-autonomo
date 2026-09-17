import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { Queryable } from '@escritorio/database';
import { type AiMode, describeError, TimeoutError, withTimeout } from '@escritorio/shared';

const CHECK_TIMEOUT_MS = 2_000;

export interface DependencyCheck {
  status: 'connected' | 'disconnected';
  latencyMs: number;
  /** Código estável (ver `dependencyErrorCode`). A mensagem do erro fica só no log. */
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

/**
 * Código seguro e estável para a resposta HTTP: `TIMEOUT`, o código do sistema
 * ou do driver quando existe (`ECONNREFUSED`, `28P01`…), senão `UNAVAILABLE`.
 * Nunca a mensagem, que pode carregar host, usuário ou detalhe interno.
 */
export function dependencyErrorCode(error: unknown): string {
  if (error instanceof TimeoutError) return 'TIMEOUT';
  const { code } = describeError(error);
  return code !== undefined && /^[A-Z0-9_]+$/.test(code) ? code : 'UNAVAILABLE';
}

async function check(label: string, probe: () => Promise<unknown>): Promise<CheckOutcome> {
  const startedAt = performance.now();
  const elapsed = () => Math.round(performance.now() - startedAt);
  try {
    await withTimeout(probe(), CHECK_TIMEOUT_MS, label);
    return { report: { status: 'connected', latencyMs: elapsed() } };
  } catch (error) {
    return {
      report: { status: 'disconnected', latencyMs: elapsed(), error: dependencyErrorCode(error) },
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
