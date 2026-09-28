import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeCursor } from '@escritorio/office-contract';
import { OFFICE_DEMO_FIXTURE } from '../../../../src/fixtures';
import { LiveOfficeDataSource } from '../LiveOfficeDataSource';
import { createOfficeDataSource } from '../createOfficeDataSource';
import { fixtureOfficeDataSource } from '../FixtureOfficeDataSource';

const epoch = '00000000-0000-4000-8000-000000000001';
const envelope = (revision = '1') => ({
  contractVersion: '2.0.0', revision, streamCursor: encodeCursor({ epoch, revision }),
  snapshot: { ...OFFICE_DEMO_FIXTURE.snapshot, mode: 'LIVE' as const,
    timeline: OFFICE_DEMO_FIXTURE.snapshot.timeline.map(event => {
      const copy = { ...event };
      delete copy.untrustedExternal;
      return copy;
    }),
    metadata: { ...OFFICE_DEMO_FIXTURE.snapshot.metadata, connection: 'LIVE' as const } },
});

class FakeSocket extends EventTarget {
  sent: string[] = [];
  send(value: string) { this.sent.push(value); }
  close() { this.dispatchEvent(new Event('close')); }
  message(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('LiveOfficeDataSource', () => {
  it('usa o fetch global com o receptor Window no navegador', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', function browserFetch(this: typeof globalThis) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      calls++;
      return Promise.resolve(new Response(JSON.stringify(envelope()), { status: 200 }));
    });
    const source = new LiveOfficeDataSource();
    await expect(source.getSnapshot()).resolves.toMatchObject({ mode: 'LIVE' });
    expect(calls).toBe(1);
  });
  it('seleciona modo explícito sem transformar offline em fixture', () => {
    expect(createOfficeDataSource(undefined)).toBe(fixtureOfficeDataSource);
    expect(createOfficeDataSource('fixture')).toBe(fixtureOfficeDataSource);
    expect(createOfficeDataSource('live')).toBeInstanceOf(LiveOfficeDataSource);
    expect(() => createOfficeDataSource('auto')).toThrow();
  });
  it('single-flight no snapshot, sem fallback para DEMO ao falhar', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => envelope() });
    const source = new LiveOfficeDataSource({ fetcher, socketFactory: vi.fn() });
    const [a, b] = await Promise.all([source.getSnapshot(), source.getSnapshot()]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(a.mode).toBe('LIVE');
    const offline = new LiveOfficeDataSource({ fetcher: vi.fn().mockRejectedValue(new Error('offline')), socketFactory: vi.fn() });
    await expect(offline.getSnapshot()).rejects.toThrow('offline');
  });
  it('aplica replacement uma vez e mantém um único socket compartilhado', async () => {
    const socket = new FakeSocket();
    const socketFactory = vi.fn().mockReturnValue(socket);
    const source = new LiveOfficeDataSource({ fetcher: vi.fn().mockResolvedValue({ ok: true, json: async () => envelope() }), socketFactory });
    const observed = vi.fn();
    const first = source.subscribe(observed);
    const second = source.subscribe(vi.fn());
    await source.getSnapshot();
    await Promise.resolve();
    expect(socketFactory).toHaveBeenCalledTimes(1);
    socket.dispatchEvent(new Event('open'));
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: 'SUBSCRIBE', afterCursor: encodeCursor({ epoch, revision: '1' }) });
    const changes = { agents: envelope().snapshot.agents.map(agent => agent.id === 'CACADOR-001' ? { ...agent, state: 'IDLE' } : agent) };
    const update = { type: 'OFFICE_UPDATED', baseCursor: encodeCursor({ epoch, revision: '1' }), cursor: encodeCursor({ epoch, revision: '2' }), revision: '2', changes };
    socket.message(update);
    const count = observed.mock.calls.length;
    socket.message(update);
    expect(observed.mock.calls.length).toBe(count);
    expect((await source.getSnapshot()).agents[0]?.state).toBe('IDLE');
    first(); second();
    expect(socketFactory).toHaveBeenCalledTimes(1);
  });
  it('reconecta com o último cursor efetivamente aplicado, sem refetch DEMO', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const factory = vi.fn(() => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; });
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => envelope() });
    const source = new LiveOfficeDataSource({ fetcher, socketFactory: factory, random: () => 0.5, now: () => Date.now() });
    await source.getSnapshot();
    const unsubscribe = source.subscribe(vi.fn());
    await Promise.resolve();
    const first = sockets[0]!;
    first.dispatchEvent(new Event('open'));
    first.message({ type: 'OFFICE_UPDATED', baseCursor: encodeCursor({ epoch, revision: '1' }), cursor: encodeCursor({ epoch, revision: '2' }), revision: '2', changes: { timeline: [] } });
    first.close();
    expect((await source.getSnapshot()).metadata.connection).toBe('STALE');
    await vi.advanceTimersByTimeAsync(1_000);
    const second = sockets[1]!;
    second.dispatchEvent(new Event('open'));
    expect(JSON.parse(second.sent[0]!)).toMatchObject({ afterCursor: encodeCursor({ epoch, revision: '2' }) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
  it('FULL_RESYNC_REQUIRED busca novo snapshot e major incompatível não cria socket', async () => {
    const sockets: FakeSocket[] = [];
    const factory = vi.fn(() => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; });
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => envelope('1') })
      .mockResolvedValueOnce({ ok: true, json: async () => envelope('5') });
    const source = new LiveOfficeDataSource({ fetcher, socketFactory: factory });
    await source.getSnapshot();
    const unsubscribe = source.subscribe(vi.fn());
    await Promise.resolve();
    sockets[0]!.message({ type: 'FULL_RESYNC_REQUIRED', reason: 'CURSOR_EXPIRED' });
    await vi.waitFor(() => expect(sockets).toHaveLength(2), { timeout: 3_000 });
    sockets[1]!.dispatchEvent(new Event('open'));
    expect(JSON.parse(sockets[1]!.sent[0]!)).toMatchObject({ afterCursor: encodeCursor({ epoch, revision: '5' }) });
    unsubscribe();
    const incompatibleFactory = vi.fn();
    const incompatible = new LiveOfficeDataSource({ fetcher: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...envelope(), contractVersion: '3.0.0' }) }), socketFactory: incompatibleFactory });
    await expect(incompatible.getSnapshot()).rejects.toThrow('incompatível');
    expect(incompatibleFactory).not.toHaveBeenCalled();
  });
  it('I11: update parcial após resync e SYNC_COMPLETE mantém conexão LIVE', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const factory = vi.fn(() => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; });
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => envelope('1') })
      .mockResolvedValueOnce({ ok: true, json: async () => envelope('5') });
    const source = new LiveOfficeDataSource({ fetcher, socketFactory: factory, random: () => 0.5, now: () => Date.now() });
    await source.getSnapshot();
    const unsubscribe = source.subscribe(vi.fn());
    await Promise.resolve();
    sockets[0]!.message({ type: 'FULL_RESYNC_REQUIRED', reason: 'CURSOR_EXPIRED' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.message({ type: 'SYNC_COMPLETE', cursor: encodeCursor({ epoch, revision: '5' }) });
    expect((await source.getSnapshot()).metadata.connection).toBe('LIVE');
    sockets[1]!.message({ type: 'OFFICE_UPDATED', baseCursor: encodeCursor({ epoch, revision: '5' }),
      cursor: encodeCursor({ epoch, revision: '6' }), revision: '6', changes: { timeline: [] } });
    expect((await source.getSnapshot()).metadata.connection).toBe('LIVE');
    expect((await source.getSnapshot()).mode).toBe('LIVE');
    const metadata = { ...envelope('5').snapshot.metadata, observedAt: '2026-09-28T00:00:00.000Z' };
    sockets[1]!.message({ type: 'OFFICE_UPDATED', baseCursor: encodeCursor({ epoch, revision: '6' }),
      cursor: encodeCursor({ epoch, revision: '7' }), revision: '7', changes: { timeline: [], metadata } });
    expect((await source.getSnapshot()).metadata).toEqual(metadata);
    unsubscribe();
  });
  it('gap ou mensagem desconhecida não é aplicada e força snapshot novo', async () => {
    const sockets: FakeSocket[] = [];
    const factory = vi.fn(() => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; });
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => envelope('1') })
      .mockResolvedValueOnce({ ok: true, json: async () => envelope('5') })
      .mockResolvedValueOnce({ ok: true, json: async () => envelope('7') });
    const source = new LiveOfficeDataSource({ fetcher, socketFactory: factory });
    const unsubscribe = source.subscribe(vi.fn());
    await source.getSnapshot();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.message({ type: 'OFFICE_UPDATED', baseCursor: encodeCursor({ epoch, revision: '3' }), cursor: encodeCursor({ epoch, revision: '4' }), revision: '4', changes: { timeline: [] } });
    await vi.waitFor(() => expect(sockets).toHaveLength(2), { timeout: 4_000 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    sockets[1]!.dispatchEvent(new Event('open'));
    expect(JSON.parse(sockets[1]!.sent[0]!)).toMatchObject({ afterCursor: encodeCursor({ epoch, revision: '5' }) });
    sockets[1]!.message({ type: 'UNKNOWN_WRITE', payload: 'ignored' });
    await vi.waitFor(() => expect(sockets).toHaveLength(3), { timeout: 4_000 });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect((await source.getSnapshot()).mode).toBe('LIVE');
    unsubscribe();
  });
  it('I11: mensagens inválidas repetidas usam backoff e param após limite, mesmo com SYNC_COMPLETE', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const factory = vi.fn(() => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; });
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => envelope() });
    const source = new LiveOfficeDataSource({ fetcher, socketFactory: factory, random: () => 0.5, now: () => Date.now() });
    await source.getSnapshot();
    const unsubscribe = source.subscribe(vi.fn());
    await Promise.resolve();
    expect(sockets).toHaveLength(1);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const socket = sockets[attempt - 1]!;
      socket.dispatchEvent(new Event('open'));
      socket.message({ type: 'SYNC_COMPLETE', cursor: encodeCursor({ epoch, revision: '1' }) });
      socket.message({ type: 'UNKNOWN_WRITE', payload: 'invalid' });
      await Promise.resolve();
      await Promise.resolve();
      expect(sockets).toHaveLength(attempt);
      if (attempt < 3) {
        await vi.advanceTimersByTimeAsync(attempt * 1_000 - 1);
        expect(sockets).toHaveLength(attempt);
        await vi.advanceTimersByTimeAsync(1);
        expect(sockets).toHaveLength(attempt + 1);
      }
    }
    expect((await source.getSnapshot()).metadata.connection).toBe('DISCONNECTED');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(3);
    expect(fetcher).toHaveBeenCalledTimes(3);
    unsubscribe();
  });
  it('I11: baseCursor divergente repetido limita GET e sockets, inclusive com novo subscriber', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const factory = vi.fn(() => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; });
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => envelope() });
    const source = new LiveOfficeDataSource({ fetcher, socketFactory: factory, random: () => 0.5, now: () => Date.now() });
    await source.getSnapshot();
    const unsubscribe = source.subscribe(vi.fn());
    await Promise.resolve();
    const gap = { type: 'OFFICE_UPDATED', baseCursor: encodeCursor({ epoch, revision: '3' }),
      cursor: encodeCursor({ epoch, revision: '4' }), revision: '4', changes: { timeline: [] } };
    for (let attempt = 1; attempt <= 3; attempt++) {
      sockets[attempt - 1]!.message({ type: 'SYNC_COMPLETE', cursor: encodeCursor({ epoch, revision: '1' }) });
      sockets[attempt - 1]!.message(gap);
      const extra = source.subscribe(vi.fn());
      await Promise.resolve();
      expect(sockets).toHaveLength(attempt);
      expect(fetcher).toHaveBeenCalledTimes(attempt);
      extra();
      if (attempt < 3) {
        await vi.advanceTimersByTimeAsync(attempt * 1_000 - 1);
        expect(sockets).toHaveLength(attempt);
        await vi.advanceTimersByTimeAsync(1);
        expect(sockets).toHaveLength(attempt + 1);
      }
    }
    expect((await source.getSnapshot()).metadata.connection).toBe('DISCONNECTED');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(3);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect((await source.getSnapshot()).mode).toBe('LIVE');
    unsubscribe();
  });
  it('I11: falha de parse, gap e FULL_RESYNC_REQUIRED compartilham limite', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const factory = vi.fn(() => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; });
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => envelope('1') })
      .mockResolvedValue({ ok: true, json: async () => envelope('5') });
    const source = new LiveOfficeDataSource({ fetcher, socketFactory: factory, random: () => 0.5, now: () => Date.now() });
    await source.getSnapshot();
    const unsubscribe = source.subscribe(vi.fn());
    await Promise.resolve();
    sockets[0]!.message({ type: 'UNKNOWN_WRITE' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.message({ type: 'OFFICE_UPDATED', baseCursor: encodeCursor({ epoch, revision: '8' }),
      cursor: encodeCursor({ epoch, revision: '9' }), revision: '9', changes: { timeline: [] } });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sockets).toHaveLength(3);
    sockets[2]!.message({ type: 'FULL_RESYNC_REQUIRED', reason: 'REVISION_GAP' });
    expect((await source.getSnapshot()).metadata.connection).toBe('DISCONNECTED');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(3);
    expect(fetcher).toHaveBeenCalledTimes(3);
    unsubscribe();
  });
  it('I11: update válido após resync permite nova recuperação transitória', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const factory = vi.fn(() => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; });
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => envelope('1') })
      .mockResolvedValue({ ok: true, json: async () => envelope('5') });
    const source = new LiveOfficeDataSource({ fetcher, socketFactory: factory, random: () => 0.5, now: () => Date.now() });
    await source.getSnapshot();
    const unsubscribe = source.subscribe(vi.fn());
    await Promise.resolve();
    sockets[0]!.message({ type: 'OFFICE_UPDATED', baseCursor: encodeCursor({ epoch, revision: '3' }),
      cursor: encodeCursor({ epoch, revision: '4' }), revision: '4', changes: { timeline: [] } });
    await vi.advanceTimersByTimeAsync(1_000);
    sockets[1]!.message({ type: 'SYNC_COMPLETE', cursor: encodeCursor({ epoch, revision: '5' }) });
    sockets[1]!.message({ type: 'OFFICE_UPDATED', baseCursor: encodeCursor({ epoch, revision: '5' }),
      cursor: encodeCursor({ epoch, revision: '6' }), revision: '6', changes: { timeline: [] } });
    expect((await source.getSnapshot()).timeline).toEqual([]);
    sockets[1]!.message({ type: 'UNKNOWN_WRITE' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(3);
    expect((await source.getSnapshot()).metadata.connection).not.toBe('DISCONNECTED');
    unsubscribe();
  });
  it('I11: subscriber durante GET de recovery não antecipa reconnect após close', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const factory = vi.fn(() => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; });
    let finishRefresh!: (response: Response) => void;
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => envelope('1') })
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finishRefresh = resolve; }));
    const source = new LiveOfficeDataSource({ fetcher, socketFactory: factory, random: () => 0.5, now: () => Date.now() });
    await source.getSnapshot();
    const unsubscribe = source.subscribe(vi.fn());
    await Promise.resolve();
    sockets[0]!.message({ type: 'FULL_RESYNC_REQUIRED', reason: 'CURSOR_EXPIRED' });
    await vi.advanceTimersByTimeAsync(1_000);
    const extra = source.subscribe(vi.fn());
    finishRefresh({ ok: true, json: async () => envelope('5') } as Response);
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(900);
    sockets[1]!.close();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(sockets).toHaveLength(2);
    extra(); unsubscribe();
  });
  it('heartbeat perdido marca STALE, backoff reconecta e unsubscribe limpa timers', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const factory = vi.fn(() => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; });
    const source = new LiveOfficeDataSource({
      fetcher: vi.fn().mockResolvedValue({ ok: true, json: async () => envelope() }),
      socketFactory: factory, random: () => 0.5, now: () => Date.now(),
    });
    await source.getSnapshot();
    const unsubscribe = source.subscribe(vi.fn());
    await Promise.resolve();
    sockets[0]!.dispatchEvent(new Event('open'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await source.getSnapshot()).metadata.connection).toBe('STALE');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.close();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);
    sockets[2]!.close();
    unsubscribe();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets).toHaveLength(3);
  });
});
