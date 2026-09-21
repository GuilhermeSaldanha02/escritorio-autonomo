// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it } from 'vitest';

import Inspector from '../Inspector';
import { OfficeDataProvider } from '../../context/OfficeDataContext';
import { SelectionProvider, useSelection } from '../../context/SelectionContext';
import { fixtureOfficeDataSource } from '../../data/FixtureOfficeDataSource';
import type { OfficeDataSource } from '../../data/OfficeDataSource';

function SelectedAgent({ id }: { id: string }) {
  const { setSelectedAgentId } = useSelection();
  useEffect(() => setSelectedAgentId(id), [id, setSelectedAgentId]);
  return null;
}

describe('Inspector', () => {
  it('mostra lifecycle, tarefa e espera sem converter pausa em falha', async () => {
    const snapshot = await fixtureOfficeDataSource.getSnapshot();
    const waitingAgent = snapshot.agents.find((agent) => agent.id === 'REVISOR-001');
    if (waitingAgent === undefined) throw new Error('Fixture sem REVISOR-001');
    waitingAgent.lifecycleStatus = 'PROBATION';
    const dataSource: OfficeDataSource = { getSnapshot: async () => snapshot, subscribe: () => () => undefined };

    render(
      <OfficeDataProvider dataSource={dataSource}>
        <SelectionProvider>
          <SelectedAgent id="REVISOR-001" />
          <Inspector />
        </SelectionProvider>
      </OfficeDataProvider>,
    );

    expect(await screen.findByText('REVISOR-001')).toBeTruthy();
    expect(screen.getByText('PROBATION')).toBeTruthy();
    expect(screen.getByText('AGUARDANDO')).toBeTruthy();
    expect(screen.queryByText('FALHOU')).toBeNull();
    expect(screen.getByText('desk-qa-01')).toBeTruthy();
  });
});
