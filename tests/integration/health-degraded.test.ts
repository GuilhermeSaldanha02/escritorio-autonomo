import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@escritorio/api';
import { createPool, type Pool } from '@escritorio/database';
import { createRedisConnection, EventBus, EventStore } from '@escritorio/events';
import type { Redis } from 'ioredis';
import { Governor, loadConstitution } from '@escritorio/governor';
import { logger } from './support.js';

/**
 * Clientes pg e ioredis reais apontados para uma porta onde nada escuta: é o
 * comportamento real dos drivers que produzia `"error":"Error"` no /health.
 */
const CLOSED_PORT = 1;

let pool: Pool;
let redis: Redis;
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  pool = createPool(`postgres://ninguem:nada@127.0.0.1:${CLOSED_PORT}/nada`, logger, 'health-degraded-test');
  redis = createRedisConnection(`redis://127.0.0.1:${CLOSED_PORT}`, 'producer', 'health-degraded-test');
  redis.on('error', () => undefined); // a queda é o cenário do teste; o /health é quem reporta
  const store = new EventStore(pool);
  app = await buildServer({
    logger,
    db: pool,
    redis,
    bus: new EventBus(pool),
    store,
    governor: new Governor(loadConstitution()),
    aiMode: 'mock',
  });
});

afterAll(async () => {
  await app?.close();
  redis?.disconnect();
  await pool?.end();
});

describe('GET /health com dependências inalcançáveis', () => {
  it('responde 503 com código estável para PostgreSQL e Redis, sem vazar mensagem', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(503);

    expect(response.json()).toMatchObject({
      status: 'degraded',
      // pg entrega o código do sistema operacional.
      database: { status: 'disconnected', error: 'ECONNREFUSED' },
      // ioredis offline lança Error sem código — antes isso virava "Error".
      redis: { status: 'disconnected', error: 'UNAVAILABLE' },
    });
    expect(response.body).not.toMatch(/Stream|writeable|127\.0\.0\.1|ninguem/);
  });
});
