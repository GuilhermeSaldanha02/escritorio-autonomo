import type { Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer, dependencyErrorCode } from '@escritorio/api';
import type { Pool, Queryable } from '@escritorio/database';
import { EventBus, EventStore } from '@escritorio/events';
import { Governor, loadConstitution } from '@escritorio/governor';
import { createLogger, TimeoutError } from '@escritorio/shared';

// Unitário: dependências simuladas só para provar o contrato do /health
// (200 vs 503). A conectividade real é provada no teste de integração.
type Probe = () => Promise<unknown>;

async function serverWith(dbProbe: Probe, redisProbe: Probe) {
  const db = { query: dbProbe } as unknown as Queryable;
  const store = new EventStore(db);
  return buildServer({
    logger: createLogger('api-test', 'silent'),
    db,
    redis: { ping: redisProbe } as unknown as Redis,
    bus: new EventBus(db as unknown as Pool),
    store,
    governor: new Governor(loadConstitution()),
    aiMode: 'mock',
  });
}

const ok: Probe = async () => 'PONG';
const refused: Probe = async () => {
  throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
};
const hangs: Probe = () => new Promise(() => undefined);

let app: Awaited<ReturnType<typeof serverWith>> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /health', () => {
  it('responde 200 quando PostgreSQL e Redis respondem', async () => {
    app = await serverWith(ok, ok);
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      api: 'up',
      database: { status: 'connected' },
      redis: { status: 'connected' },
      aiMode: 'mock',
    });
  });

  it('responde 503 e expõe só o código do erro quando o banco cai', async () => {
    app = await serverWith(refused, ok);
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body).toMatchObject({ status: 'degraded', database: { status: 'disconnected', error: 'ECONNREFUSED' } });
    expect(JSON.stringify(body)).not.toContain('connect ECONNREFUSED');
  });

  it('erro sem código (ex.: ioredis offline) vira UNAVAILABLE, nunca "Error" nem a mensagem', async () => {
    const bare: Probe = async () => {
      throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
    };
    app = await serverWith(ok, bare);
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ redis: { status: 'disconnected', error: 'UNAVAILABLE' } });
    expect(response.body).not.toContain('Stream');
  });

  it('não pendura quando o Redis não responde: estoura o prazo e responde 503', async () => {
    app = await serverWith(ok, hangs);
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ redis: { status: 'disconnected', error: 'TIMEOUT' } });
  });
});

describe('dependencyErrorCode', () => {
  it.each([
    ['timeout', new TimeoutError('Redis', 2_000), 'TIMEOUT'],
    ['código de sistema', Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), 'ECONNREFUSED'],
    ['código SQLSTATE do PostgreSQL', Object.assign(new Error('senha errada'), { code: '28P01' }), '28P01'],
    ['erro sem código', new Error('qualquer coisa'), 'UNAVAILABLE'],
    ['código fora do formato', Object.assign(new Error('x'), { code: 'bad code; <script>' }), 'UNAVAILABLE'],
    ['valor que não é Error', 'string lançada', 'UNAVAILABLE'],
  ])('%s → %s', (_label, error, expected) => {
    expect(dependencyErrorCode(error)).toBe(expected);
  });
});
