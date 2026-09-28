// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import Dashboard from '../Dashboard';
import { OfficeDataProvider } from '../../context/OfficeDataContext';
import { fixtureOfficeDataSource } from '../../data/FixtureOfficeDataSource';
import type { OfficeDataSource } from '../../data/OfficeDataSource';

describe('Dashboard', () => {
  it('mantém finanças REAL e SIMULATION separadas e apresenta governança sem inferir regras', async () => {
    const snapshot = await fixtureOfficeDataSource.getSnapshot();
    snapshot.governance.emergencyStop = true;
    snapshot.governance.circuitBreaker = 'OPEN';
    const dataSource: OfficeDataSource = { getSnapshot: async () => snapshot, subscribe: () => () => undefined };

    render(
      <OfficeDataProvider dataSource={dataSource}>
        <Dashboard />
      </OfficeDataProvider>,
    );

    expect(await screen.findByText('Modo demonstração')).toBeTruthy();
    expect(screen.getByText('Caixa REAL')).toBeTruthy();
    expect(screen.getByText('Caixa SIMULATION')).toBeTruthy();
    expect(screen.getByText(/1\.842,50/)).toBeTruthy();
    expect(screen.getByText(/2\.460,00/)).toBeTruthy();
    expect(screen.getByText('Autonomia configurada ativa')).toBeTruthy();
    expect(screen.getByText('Auto-spend configurado desativado')).toBeTruthy();
    expect(screen.getByText('Emergency Stop ativo')).toBeTruthy();
    expect(screen.getByText('Circuit Breaker aberto')).toBeTruthy();
  });
});
