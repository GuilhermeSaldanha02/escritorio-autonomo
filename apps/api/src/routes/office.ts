import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from '@escritorio/database';
import { CONTRACT_VERSION, decodeCursor, officeStreamMessageSchema } from '@escritorio/office-contract';
import { readOfficeEnvelope, readOfficeReplay } from '../office/journal.js';

interface OfficeRoutesDeps { pool: Pool }
const MAX_SNAPSHOT = 256 * 1024;
const MAX_COMMAND = 2 * 1024;
const MAX_BUFFER = 1024 * 1024;

/** Apenas loopback e a origem exata da API ou do Vite local (5173). */
function allowedRequest(request: FastifyRequest): boolean {
  const host = request.headers.host;
  if (!host || !/^(localhost|127\.0\.0\.1)(:[0-9]{1,5})?$/.test(host)) return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && url.username === '' && url.password === '' && url.pathname === '/' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
      (url.host === host || url.port === '5173');
  } catch { return false; }
}

export async function officeRoutes(app: FastifyInstance, { pool }: OfficeRoutesDeps): Promise<void> {
  let connections = 0;
  const guard = async (request: FastifyRequest, reply: { code(status: number): { send(body: unknown): unknown } }) => {
    if (!allowedRequest(request)) return reply.code(403).send({ error: 'OFFICE_ACCESS_DENIED' });
  };

  app.get('/office/snapshot', { preHandler: guard }, async (_request, reply) => {
    try {
      const envelope = await readOfficeEnvelope(pool);
      if (!envelope) return reply.code(503).header('Cache-Control', 'no-store').send({ error: 'OFFICE_UNAVAILABLE' });
      const body = JSON.stringify(envelope);
      if (Buffer.byteLength(body) > MAX_SNAPSHOT) return reply.code(503).send({ error: 'OFFICE_UNAVAILABLE' });
      return reply.header('Cache-Control', 'no-store').header('X-Office-Contract-Version', CONTRACT_VERSION).type('application/json').send(body);
    } catch {
      return reply.code(503).header('Cache-Control', 'no-store').send({ error: 'OFFICE_UNAVAILABLE' });
    }
  });

  app.get('/office/stream', { websocket: true, preValidation: guard }, (socket) => {
    if (connections >= 8) { socket.close(1013, 'Office capacity'); return; }
    connections++;
    let subscribed = false;
    let subscribing = false;
    let closed = false;
    let busy = false;
    let cursor: string | null = null;
    let lastPong = Date.now();
    const send = (message: unknown): boolean => {
      if (closed || socket.readyState !== 1) return false;
      const body = JSON.stringify(message);
      if (Buffer.byteLength(body) > MAX_SNAPSHOT || socket.bufferedAmount + Buffer.byteLength(body) > MAX_BUFFER) {
        socket.send(JSON.stringify({ type: 'FULL_RESYNC_REQUIRED', reason: 'UNAVAILABLE' }));
        socket.close(1009, 'Office buffer');
        return false;
      }
      socket.send(body);
      return true;
    };
    const resync = (reason: 'INVALID_CURSOR' | 'EPOCH_MISMATCH' | 'CURSOR_EXPIRED' | 'CURSOR_AHEAD' | 'REVISION_GAP' | 'UNAVAILABLE' | 'VERSION_MISMATCH') => {
      send({ type: 'FULL_RESYNC_REQUIRED', reason });
      socket.close(1008, 'Office resync');
    };
    const sync = async (after: string): Promise<void> => {
      const initial = await readOfficeReplay(pool, after);
      if (initial.status === 'RESYNC') { resync(initial.reason); return; }
      const target = initial.throughCursor;
      if (!send({ type: 'SYNC_START', throughCursor: target })) return;
      let page = initial;
      let current = after;
      while (!closed) {
        for (const update of page.updates) {
          if (BigInt(update.revision) > BigInt(decodeCursor(target).revision)) break;
          if (!send(update)) return;
          current = update.cursor;
        }
        if (current === target) break;
        if (page.updates.length === 0) { resync('REVISION_GAP'); return; }
        const next = await readOfficeReplay(pool, current);
        if (next.status === 'RESYNC') { resync(next.reason); return; }
        page = next;
      }
      cursor = target;
      if (send({ type: 'SYNC_COMPLETE', cursor: target })) subscribed = true;
    };
    const tail = async (): Promise<void> => {
      if (busy || !subscribed || !cursor || closed) return;
      busy = true;
      try {
        const page = await readOfficeReplay(pool, cursor);
        if (page.status === 'RESYNC') { resync(page.reason); return; }
        for (const update of page.updates) {
          if (!send(update)) return;
          cursor = update.cursor;
        }
      } catch { resync('UNAVAILABLE'); }
      finally { busy = false; }
    };
    const subscribeDeadline = setTimeout(() => { if (!subscribed) socket.close(1008, 'Office subscribe timeout'); }, 5_000);
    const poll = setInterval(() => { void tail(); }, 1_000);
    const heartbeat = setInterval(() => {
      if (Date.now() - lastPong > 45_000) { socket.terminate(); return; }
      socket.ping();
      void readOfficeEnvelope(pool).then(envelope => send({ type: 'HEARTBEAT', metadata: { observedAt: envelope?.snapshot.metadata.observedAt ?? null } }))
        .catch(() => send({ type: 'HEARTBEAT', metadata: { observedAt: null } }));
    }, 15_000);
    socket.on('pong', () => { lastPong = Date.now(); });
    socket.on('close', () => {
      closed = true;
      connections--;
      clearTimeout(subscribeDeadline);
      clearInterval(poll);
      clearInterval(heartbeat);
    });
    socket.on('message', raw => {
      if (subscribed || subscribing || Buffer.byteLength(raw.toString()) > MAX_COMMAND) { socket.close(1008, 'Invalid office command'); return; }
      let command: unknown;
      try { command = JSON.parse(raw.toString()); }
      catch { resync('INVALID_CURSOR'); return; }
      if (!command || typeof command !== 'object' || !('type' in command) || command.type !== 'SUBSCRIBE') {
        socket.close(1008, 'Invalid office command'); return;
      }
      if (!('clientVersion' in command) || command.clientVersion !== CONTRACT_VERSION) { resync('VERSION_MISMATCH'); return; }
      const parsed = officeStreamMessageSchema.safeParse(command);
      if (!parsed.success || parsed.data.type !== 'SUBSCRIBE') { resync('INVALID_CURSOR'); return; }
      subscribing = true;
      void sync(parsed.data.afterCursor).catch(() => resync('UNAVAILABLE'));
    });
  });
}
