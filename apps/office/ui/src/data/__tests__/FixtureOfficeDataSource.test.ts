import { describe, expect, it, vi } from 'vitest';

import { fixtureOfficeDataSource } from '../FixtureOfficeDataSource';

describe('FixtureOfficeDataSource', () => {
  it('entrega cópias imutáveis com fundadores, lifecycle e estados oficiais', async () => {
    const firstSnapshot = await fixtureOfficeDataSource.getSnapshot();
    const secondSnapshot = await fixtureOfficeDataSource.getSnapshot();

    expect(firstSnapshot).toEqual(secondSnapshot);
    expect(firstSnapshot.mode).toBe('DEMO');
    expect(firstSnapshot.agents.map((agent) => agent.id)).toEqual(
      expect.arrayContaining(['CACADOR-001', 'DIRETOR-001', 'DESENVOLVEDOR-001', 'REVISOR-001']),
    );
    expect(firstSnapshot.agents.every((agent) => agent.lifecycleStatus === 'ACTIVE')).toBe(true);
    expect(firstSnapshot.agents.map((agent) => agent.state)).not.toContain('WORKING');

    firstSnapshot.agents[0].displayName = 'alterado apenas na cópia';
    expect(secondSnapshot.agents[0].displayName).not.toBe('alterado apenas na cópia');
  });

  it('mantém caixa REAL e SIMULATION separados e flags de governança independentes', async () => {
    const snapshot = await fixtureOfficeDataSource.getSnapshot();

    expect(snapshot.financial.real.cashCents).not.toBe(snapshot.financial.simulation.cashCents);
    expect(snapshot.governance.autonomyEnabled).toBe(true);
    expect(snapshot.governance.autoSpendEnabled).toBe(false);
    expect(snapshot.governance.emergencyStop).toBe(false);
    expect(snapshot.governance.circuitBreaker).toBe('CLOSED');
  });

  it('não acessa rede e retorna um unsubscribe inofensivo', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const unsubscribe = fixtureOfficeDataSource.subscribe(() => undefined);

    expect(typeof unsubscribe).toBe('function');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(unsubscribe).not.toThrow();
    fetchSpy.mockRestore();
  });
});
