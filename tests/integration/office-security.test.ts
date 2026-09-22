import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, migrateUp, seedInitialAgents, type Pool } from '@escritorio/database';
import { createLogger } from '@escritorio/shared';
import { officeRoutes } from '../../apps/api/src/routes/office.js';
import { refreshOfficeProjection } from '../../apps/api/src/office/journal.js';

let db: Pool;
let app: ReturnType<typeof Fastify>;
beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || new URL(url).pathname !== '/office_m7_test') throw new Error('Only disposable office_m7_test permitted');
  db = createPool(url, createLogger('office-security-test', 'silent'), 'office-security-test');
  await migrateUp(db);
  await seedInitialAgents(db);
  app = Fastify();
  await app.register(websocket, { options: { maxPayload: 2 * 1024 } });
  await app.register(officeRoutes, { pool: db });
  await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => { await app?.close(); await db?.end(); });

describe('segurança Office', () => {
  it('não retransmite texto externo nem expõe escrita', async () => {
    await db.query(`INSERT INTO events (type, payload) VALUES ('TASK_STARTED', '{"prompt":"SECRET_CANARY","html":"<img onerror=alert(1)>"}'::jsonb)`);
    await refreshOfficeProjection(db, { autonomyEnabled: false, autoSpendEnabled: false });
    const response = await app.inject({ method: 'GET', url: '/office/snapshot', headers: { host: '127.0.0.1:5173' } });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toMatch(/SECRET_CANARY|onerror|prompt|html/);
    expect((await app.inject({ method: 'POST', url: '/office/snapshot', headers: { host: '127.0.0.1:5173' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/office/stream', headers: { host: '127.0.0.1:5173' } })).statusCode).toBe(404);
  });
  it('Host/Origin estritos, inclusive nomes parecidos com loopback', async () => {
    for (const host of ['evil.localhost:5173', '127.0.0.1.evil.test', 'localhost:123456']) {
      expect((await app.inject({ method: 'GET', url: '/office/snapshot', headers: { host } })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'GET', url: '/office/snapshot', headers: { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173.evil.test' } })).statusCode).toBe(403);
  });
  it('WebSocket rejeita comando que não seja SUBSCRIBE', async () => {
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/office/stream`);
    const closeCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS command rejection timeout')), 5_000);
      socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'STOP', agentId: 'CACADOR-001' })));
      socket.addEventListener('close', event => { clearTimeout(timer); resolve(event.code); });
      socket.addEventListener('error', reject);
    });
    expect(closeCode).toBe(1008);
  });
});
