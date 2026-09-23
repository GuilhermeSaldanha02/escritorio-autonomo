import { describe, expect, it, vi } from 'vitest';
import { encodeCursor } from '@escritorio/office-contract';
import { OFFICE_DEMO_FIXTURE } from '../../../../src/fixtures';
import { LiveOfficeDataSource } from '../LiveOfficeDataSource';
import { createOfficeDataSource } from '../createOfficeDataSource';
import { fixtureOfficeDataSource } from '../FixtureOfficeDataSource';

const epoch = '00000000-0000-4000-8000-000000000001';
const envelope = () => ({
  contractVersion: '2.0.0', revision: '1', streamCursor: encodeCursor({ epoch, revision: '1' }),
  snapshot: { ...OFFICE_DEMO_FIXTURE.snapshot, mode: 'LIVE' as const,
    timeline: OFFICE_DEMO_FIXTURE.snapshot.timeline.map(event => {
      const copy = { ...event };
      delete copy.untrustedExternal;
      return copy;
    }),
    metadata: { ...OFFICE_DEMO_FIXTURE.snapshot.metadata, connection: 'LIVE' as const } },
});

describe('LiveOfficeDataSource', () => {
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
    class FakeSocket extends EventTarget {
      sent: string[] = [];
      send(value: string) { this.sent.push(value); }
      close() { this.dispatchEvent(new Event('close')); }
      message(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
    }
    const socket = new FakeSocket();
    const socketFactory = vi.fn().mockReturnValue(socket);
    const source = new LiveOfficeDataSource({ fetcher: vi.fn().mockResolvedValue({ ok: true, json: async () => envelope() }), socketFactory });
    const observed = vi.fn();
    const first = source.subscribe(observed);
    const second = source.subscribe(observed);
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
});
