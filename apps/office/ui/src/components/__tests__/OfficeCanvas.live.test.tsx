// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OfficeDataProvider } from '../../context/OfficeDataContext';
import { SelectionProvider } from '../../context/SelectionContext';
import { useSelection } from '../../context/SelectionContext';
import { fixtureOfficeDataSource } from '../../data/FixtureOfficeDataSource';
import type { OfficeDataSource } from '../../data/OfficeDataSource';
import type { OfficeEventHandler, OfficeSnapshot } from '../../data/types';

const calls = vi.hoisted(() => ({ created: 0, destroyed: 0, emit: vi.fn(), camera: { zoom: 1.5, scrollX: 42, scrollY: 21 } }));
vi.mock('phaser', () => ({ default: {
  AUTO: 1,
  Game: class {
    scene = { getScene: () => ({ events: { emit: calls.emit }, cameras: { main: calls.camera } }) };
    scale = { refresh: () => undefined };
    constructor() { calls.created++; }
    destroy() { calls.destroyed++; }
  },
} }));
vi.mock('../../util/OfficeSceneFactory', () => ({ createOfficeScene: () => ({}) }));
import OfficeCanvas from '../OfficeCanvas';

function SelectionProbe() {
  const { selectedAgentId, setSelectedAgentId } = useSelection();
  return <button onClick={() => setSelectedAgentId('CACADOR-001')}>{selectedAgentId ?? 'sem seleção'}</button>;
}

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
    const view = render(<OfficeDataProvider dataSource={dataSource}><SelectionProvider><OfficeCanvas /><SelectionProbe /></SelectionProvider></OfficeDataProvider>);
    expect(await screen.findByText(/4 agentes/)).toBeTruthy();
    await waitFor(() => expect(calls.created).toBe(1));
    await act(async () => { screen.getByRole('button', { name: 'sem seleção' }).click(); });
    expect(screen.getByRole('button', { name: 'CACADOR-001' })).toBeTruthy();
    const cameraBefore = { ...calls.camera };
    for (let i = 0; i < 100; i++) {
      await act(async () => {
        current = { ...current, generatedAt: new Date(Date.parse(current.generatedAt) + 1000).toISOString() };
        for (const handler of handlers) handler({ type: 'SNAPSHOT_UPDATED' });
      });
    }
    expect(calls.created).toBe(1);
    expect(calls.emit.mock.calls.filter(([event]) => event === 'update-office-model')).toHaveLength(100);
    expect(calls.emit.mock.calls).toContainEqual(['select-agent', 'CACADOR-001']);
    expect(screen.getByRole('button', { name: 'CACADOR-001' })).toBeTruthy();
    expect(calls.camera).toEqual(cameraBefore);
    view.unmount();
    expect(calls.destroyed).toBe(1);
  });
});
