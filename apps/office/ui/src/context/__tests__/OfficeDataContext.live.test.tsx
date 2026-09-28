// @vitest-environment jsdom
import { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { encodeCursor } from '@escritorio/office-contract';
import { OFFICE_DEMO_FIXTURE } from '../../../../src/fixtures';
import { LiveOfficeDataSource } from '../../data/LiveOfficeDataSource';
import { OfficeDataProvider, useOfficeData } from '../OfficeDataContext';

const epoch = '00000000-0000-4000-8000-000000000001';

class FakeSocket extends EventTarget {
  sent: string[] = [];
  closes = 0;
  send(value: string) { this.sent.push(value); }
  close() { this.closes++; this.dispatchEvent(new Event('close')); }
}

function Probe() {
  const { snapshot } = useOfficeData();
  return <output>{snapshot?.mode ?? 'LOADING'}</output>;
}

describe('OfficeDataProvider LIVE sob StrictMode', () => {
  it('compartilha um socket, limpa no unmount e novo frontend faz bootstrap do cursor atual', async () => {
    const sockets: FakeSocket[] = [];
    const socketFactory = vi.fn(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    });
    const fetcher = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        contractVersion: '2.0.0', revision: String(fetcher.mock.calls.length),
        streamCursor: encodeCursor({ epoch, revision: String(fetcher.mock.calls.length) }),
        snapshot: {
          ...OFFICE_DEMO_FIXTURE.snapshot, mode: 'LIVE',
          timeline: OFFICE_DEMO_FIXTURE.snapshot.timeline.map(item => {
            const copy = { ...item };
            delete copy.untrustedExternal;
            return copy;
          }),
          metadata: { ...OFFICE_DEMO_FIXTURE.snapshot.metadata, connection: 'LIVE' },
        },
      }),
    }));
    const first = new LiveOfficeDataSource({ fetcher, socketFactory });
    const firstView = render(<StrictMode><OfficeDataProvider dataSource={first}><Probe /></OfficeDataProvider></StrictMode>);
    expect(await screen.findByText('LIVE')).toBeTruthy();
    await waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.dispatchEvent(new Event('open'));
    expect(JSON.parse(sockets[0]!.sent[0]!)).toMatchObject({ afterCursor: encodeCursor({ epoch, revision: '1' }) });
    firstView.unmount();
    expect(sockets[0]!.closes).toBe(1);

    const restarted = new LiveOfficeDataSource({ fetcher, socketFactory });
    const nextView = render(<StrictMode><OfficeDataProvider dataSource={restarted}><Probe /></OfficeDataProvider></StrictMode>);
    expect(await screen.findByText('LIVE')).toBeTruthy();
    await waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1]!.dispatchEvent(new Event('open'));
    expect(JSON.parse(sockets[1]!.sent[0]!)).toMatchObject({ afterCursor: encodeCursor({ epoch, revision: '2' }) });
    expect(fetcher).toHaveBeenCalledTimes(2);
    nextView.unmount();
    expect(sockets[1]!.closes).toBe(1);
  });
});
