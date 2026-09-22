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
  db = createPool(url, createLogger('office-stream-test', 'silent'), 'office-stream-test');
  await migrateUp(db);
  await seedInitialAgents(db);
  await refreshOfficeProjection(db, { autonomyEnabled: false, autoSpendEnabled: false });
  app = Fastify();
  await app.register(websocket);
  await app.register(officeRoutes, { pool: db });
  await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => { await app?.close(); await db?.end(); });

describe('Office REST/WS', () => {
  it('snapshot consistente e proteção Host/Origin', async () => {
    const ok = await app.inject({ method: 'GET', url: '/office/snapshot', headers: { host: '127.0.0.1:5173' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.json()).toMatchObject({ contractVersion: '2.0.0', revision: expect.any(String), snapshot: { mode: 'LIVE' } });
    expect((await app.inject({ method: 'GET', url: '/office/snapshot', headers: { host: 'evil.example' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/office/snapshot', headers: { host: '127.0.0.1:5173', origin: 'https://evil.example' } })).statusCode).toBe(403);
  });
  it('entrega update ocorrido entre snapshot e SUBSCRIBE via replay', async () => {
    const snapshot = (await app.inject({ method: 'GET', url: '/office/snapshot', headers: { host: '127.0.0.1:5173' } })).json() as { streamCursor: string };
    await db.query(`UPDATE agents SET state = 'REVIEWING' WHERE id = 'REVISOR-001'`);
    const next = await refreshOfficeProjection(db, { autonomyEnabled: false, autoSpendEnabled: false });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/office/stream`);
    try {
      const messages: unknown[] = await new Promise((resolve, reject) => {
        const all: unknown[] = [];
        const timeout = setTimeout(() => reject(new Error('Office WS timeout')), 5_000);
        socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'SUBSCRIBE', clientVersion: '2.0.0', afterCursor: snapshot.streamCursor })));
        socket.addEventListener('message', event => {
          const message = JSON.parse(String(event.data)) as { type: string };
          all.push(message);
          if (message.type === 'SYNC_COMPLETE') { clearTimeout(timeout); resolve(all); }
        });
        socket.addEventListener('error', reject);
      });
      expect(messages).toMatchObject([
        { type: 'SYNC_START', throughCursor: next.streamCursor },
        { type: 'OFFICE_UPDATED', baseCursor: snapshot.streamCursor, cursor: next.streamCursor },
        { type: 'SYNC_COMPLETE', cursor: next.streamCursor },
      ]);
    } finally { socket.close(); }
  });
});
