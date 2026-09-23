// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OfficeDataProvider } from '../../context/OfficeDataContext';
import { SelectionProvider } from '../../context/SelectionContext';
import { fixtureOfficeDataSource } from '../../data/FixtureOfficeDataSource';
import type { OfficeDataSource } from '../../data/OfficeDataSource';
import type { OfficeEventHandler, OfficeSnapshot } from '../../data/types';

const calls = vi.hoisted(() => ({ created: 0, destroyed: 0, emit: vi.fn() }));
vi.mock('phaser', () => ({ default: {
  AUTO: 1,
  Game: class {
    scene = { getScene: () => ({ events: { emit: calls.emit } }) };
    scale = { refresh: () => undefined };
    constructor() { calls.created++; }
    destroy() { calls.destroyed++; }
  },
} }));
vi.mock('../../util/OfficeSceneFactory', () => ({ createOfficeScene: () => ({}) }));
import OfficeCanvas from '../OfficeCanvas';

afterEach(() => { calls.created = 0; calls.destroyed = 0; calls.emit.mockReset(); });

describe('OfficeCanvas LIVE', () => {
  it('100 snapshots preservam o mesmo Game e seleção', async () => {
    globalThis.ResizeObserver = class { observe() {} disconnect() {} } as unknown as typeof ResizeObserver;
    let current: OfficeSnapshot = await fixtureOfficeDataSource.getSnapshot();
    current.mode = 'LIVE';
    const handlers = new Set<OfficeEventHandler>();
    const dataSource: OfficeDataSource = {
      getSnapshot: async () => current,
      subscribe: handler => { handlers.add(handler); return () => { handlers.delete(handler); }; },
    };
    const view = render(<OfficeDataProvider dataSource={dataSource}><SelectionProvider><OfficeCanvas /></SelectionProvider></OfficeDataProvider>);
    expect(await screen.findByText(/4 agentes/)).toBeTruthy();
    await waitFor(() => expect(calls.created).toBe(1));
    for (let i = 0; i < 100; i++) {
      await act(async () => {
        current = { ...current, generatedAt: new Date(Date.parse(current.generatedAt) + 1000).toISOString() };
        for (const handler of handlers) handler({ type: 'SNAPSHOT_UPDATED' });
      });
    }
    expect(calls.created).toBe(1);
    view.unmount();
    expect(calls.destroyed).toBe(1);
  });
});
