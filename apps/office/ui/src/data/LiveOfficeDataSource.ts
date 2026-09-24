import {
  CONTRACT_VERSION, decodeCursor, officeEnvelopeSchema, officeSnapshotSchema, officeStreamMessageSchema,
  type OfficeSnapshot,
} from '@escritorio/office-contract';
import type { OfficeDataSource } from './OfficeDataSource';
import type { OfficeEventHandler, Unsubscribe } from './types';

interface LiveOptions {
  fetcher?: typeof fetch;
  socketFactory?: (url: string) => WebSocket;
  random?: () => number;
  now?: () => number;
}

/** Uma instância por provider: cache e cursor avançam juntos. */
export class LiveOfficeDataSource implements OfficeDataSource {
  readonly #fetcher: typeof fetch;
  readonly #socketFactory: (url: string) => WebSocket;
  readonly #random: () => number;
  readonly #now: () => number;
  readonly #handlers = new Set<OfficeEventHandler>();
  #cache: OfficeSnapshot | null = null;
  #cursor: string | null = null;
  #bootstrap: Promise<OfficeSnapshot> | null = null;
  #socket: WebSocket | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #lastMessageAt = 0;
  #attempt = 0;
  #invalidMessages = 0;
  #lastInvalidAt = 0;
  #incompatible = false;

  constructor(options: LiveOptions = {}) {
    this.#fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.#socketFactory = options.socketFactory ?? (url => new WebSocket(url));
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
  }

  async getSnapshot(): Promise<OfficeSnapshot> {
    if (this.#cache) return this.#cache;
    return this.#fetchSnapshot();
  }

  subscribe(handler: OfficeEventHandler): Unsubscribe {
    this.#handlers.add(handler);
    if (this.#cache) queueMicrotask(() => { if (this.#handlers.has(handler)) handler({ type: 'SNAPSHOT_UPDATED' }); });
    void this.#fetchSnapshot().then(() => this.#connect()).catch(() => this.#scheduleReconnect());
    return () => {
      this.#handlers.delete(handler);
      if (this.#handlers.size === 0) {
        this.#clearTimer();
        this.#clearHeartbeat();
        this.#socket?.close();
        this.#socket = null;
      }
    };
  }

  async #fetchSnapshot(force = false): Promise<OfficeSnapshot> {
    if (this.#cache && !force) return this.#cache;
    if (this.#bootstrap) return this.#bootstrap;
    this.#bootstrap = (async () => {
      const response = await this.#fetcher('/office/snapshot', { cache: 'no-store' });
      if (!response.ok) throw new Error('Office LIVE indisponível');
      const raw: unknown = await response.json();
      if (!raw || typeof raw !== 'object' || !('contractVersion' in raw) || raw.contractVersion !== CONTRACT_VERSION) {
        this.#incompatible = true;
        throw new Error('Versão do Office LIVE incompatível');
      }
      const envelope = officeEnvelopeSchema.parse(raw);
      if (envelope.snapshot.mode !== 'LIVE' || envelope.snapshot.timeline.some(item => item.untrustedExternal !== undefined)) {
        throw new Error('Office LIVE incompatível');
      }
      this.#cursor = envelope.streamCursor;
      this.#cache = envelope.snapshot;
      this.#emit();
      return this.#cache;
    })();
    try { return await this.#bootstrap; }
    finally { this.#bootstrap = null; }
  }

  #emit(): void { for (const handler of this.#handlers) handler({ type: 'SNAPSHOT_UPDATED' }); }

  #setConnection(connection: OfficeSnapshot['metadata']['connection']): void {
    if (!this.#cache || this.#cache.metadata.connection === connection) return;
    this.#cache = { ...this.#cache, metadata: { ...this.#cache.metadata, connection } };
    this.#emit();
  }

  #connect(): void {
    if (this.#handlers.size === 0 || !this.#cursor || this.#socket || this.#incompatible) return;
    const origin = new URL(globalThis.location?.href ?? 'http://localhost:5173/');
    origin.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:';
    origin.pathname = '/office/stream';
    origin.search = '';
    origin.hash = '';
    const socket = this.#socketFactory(origin.toString());
    this.#socket = socket;
    this.#lastMessageAt = this.#now();
    this.#heartbeatTimer = setInterval(() => {
      if (this.#socket === socket && this.#now() - this.#lastMessageAt > 45_000) socket.close();
    }, 15_000);
    this.#setConnection(this.#attempt === 0 ? 'CONNECTING' : 'RECONNECTING');
    socket.addEventListener('open', () => {
      if (this.#socket !== socket || !this.#cursor) return;
      socket.send(JSON.stringify({ type: 'SUBSCRIBE', clientVersion: CONTRACT_VERSION, afterCursor: this.#cursor }));
    });
    socket.addEventListener('message', event => {
      if (this.#socket !== socket) return;
      this.#lastMessageAt = this.#now();
      try { this.#message(JSON.parse(String(event.data))); }
      catch { this.#resync(true); }
    });
    socket.addEventListener('close', () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#clearHeartbeat();
      this.#setConnection('STALE');
      this.#scheduleReconnect();
    });
    socket.addEventListener('error', () => { if (this.#socket === socket) socket.close(); });
  }

  #message(raw: unknown): void {
    const message = officeStreamMessageSchema.parse(raw);
    if (message.type === 'OFFICE_UPDATED') {
      if (!this.#cursor || !this.#cache) return this.#resync();
      const current = decodeCursor(this.#cursor);
      const next = decodeCursor(message.cursor);
      if (next.epoch !== current.epoch) return this.#resync();
      if (BigInt(next.revision) <= BigInt(current.revision)) return;
      if (message.baseCursor !== this.#cursor) return this.#resync();
      const snapshot = officeSnapshotSchema.parse({ ...this.#cache, ...message.changes });
      if (snapshot.timeline.some(item => item.untrustedExternal !== undefined)) return this.#resync();
      this.#cache = snapshot;
      this.#cursor = message.cursor;
      this.#invalidMessages = 0;
      this.#emit();
    } else if (message.type === 'SYNC_COMPLETE') {
      if (message.cursor !== this.#cursor) return this.#resync();
      this.#attempt = 0;
      this.#setConnection('LIVE');
    } else if (message.type === 'FULL_RESYNC_REQUIRED') {
      if (message.reason === 'VERSION_MISMATCH') { this.#incompatible = true; this.#setConnection('DISCONNECTED'); this.#socket?.close(); return; }
      this.#resync();
    } else if (message.type === 'HEARTBEAT') {
      const observed = message.metadata.observedAt;
      if (!observed || this.#now() - Date.parse(observed) > 5_000) this.#setConnection('STALE');
    }
  }

  #resync(invalidMessage = false): void {
    if (invalidMessage) {
      if (this.#now() - this.#lastInvalidAt > 60_000) this.#invalidMessages = 0;
      this.#lastInvalidAt = this.#now();
      this.#invalidMessages++;
    }
    this.#clearHeartbeat();
    const socket = this.#socket;
    this.#socket = null;
    socket?.close();
    if (this.#invalidMessages >= 3) {
      this.#incompatible = true;
      this.#clearTimer();
      this.#setConnection('DISCONNECTED');
      return;
    }
    this.#setConnection('STALE');
    void this.#fetchSnapshot(true).then(() => {
      if (invalidMessage) {
        this.#attempt = Math.max(this.#attempt, this.#invalidMessages - 1);
        this.#scheduleReconnect();
      } else this.#connect();
    }).catch(() => this.#scheduleReconnect());
  }

  #scheduleReconnect(): void {
    if (this.#handlers.size === 0 || this.#incompatible || this.#reconnectTimer) return;
    this.#setConnection('STALE');
    const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
    const base = delays[Math.min(this.#attempt++, delays.length - 1)]!;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (this.#cache) this.#connect();
      else void this.#fetchSnapshot().then(() => this.#connect()).catch(() => this.#scheduleReconnect());
    }, Math.round(base * (0.8 + 0.4 * this.#random())));
  }

  #clearTimer(): void {
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }
  #clearHeartbeat(): void {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
  }
}
