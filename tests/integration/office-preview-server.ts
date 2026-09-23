/** Preview descartável do Office LIVE. Nunca carrega .env nem usa o banco do owner. */
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { createPool, migrateUp, seedInitialAgents } from '@escritorio/database';
import { createLogger } from '@escritorio/shared';
import { officeRoutes } from '../../apps/api/src/routes/office.js';
import { refreshOfficeProjection } from '../../apps/api/src/office/journal.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/office_m7_test') throw new Error('Preview requires office_m7_test');
const pool = createPool(url, createLogger('office-preview', 'silent'), 'office-preview');
const app = Fastify();
try {
  await migrateUp(pool);
  await seedInitialAgents(pool);
  await refreshOfficeProjection(pool, { autonomyEnabled: false, autoSpendEnabled: false });
  await app.register(websocket, { options: { maxPayload: 2 * 1024 } });
  await app.register(officeRoutes, { pool });
  await app.listen({ host: '127.0.0.1', port: 3000 });
  const timer = setInterval(() => {
    void refreshOfficeProjection(pool, { autonomyEnabled: false, autoSpendEnabled: false }).catch(() => undefined);
  }, 1_000);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
    clearInterval(timer);
    void app.close().then(() => pool.end()).then(() => process.exit(0));
  });
} catch (error) {
  await app.close();
  await pool.end();
  throw error;
}
