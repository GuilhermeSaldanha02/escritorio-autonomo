import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fixtureOfficeDataSource } from '../../data/FixtureOfficeDataSource';
import { createOfficeSceneModel } from '../../office/scene-model';

const repositoryRoot = (() => {
  let current = resolve(process.cwd());
  while (!existsSync(resolve(current, 'assets/office/layout.json'))) {
    const parent = dirname(current);
    if (parent === current) throw new Error('Raiz do repositório não encontrada');
    current = parent;
  }
  return current;
})();
const layout = JSON.parse(readFileSync(resolve(repositoryRoot, 'assets/office/layout.json'), 'utf8')) as unknown;

describe('OfficeSceneFactory', () => {
  it('projeta salas, postos, agentes extras e a rota visual de probation', async () => {
    const snapshot = await fixtureOfficeDataSource.getSnapshot();
    snapshot.agents.push({
      id: 'NOVO-001',
      displayName: 'Novo agente',
      role: 'OUTRO',
      responsibility: 'Expansão visual demonstrativa',
      lifecycleStatus: 'PROBATION',
      state: 'IDLE',
      stateSince: snapshot.generatedAt,
      currentTask: null,
    });

    const model = createOfficeSceneModel({ layout: layout as Parameters<typeof createOfficeSceneModel>[0]['layout'], snapshot });

    expect(model.rooms).toHaveLength(6);
    expect(model.workstations.filter((workstation) => workstation.status === 'EMPTY')).not.toHaveLength(0);
    expect(model.agents).toHaveLength(5);
    expect(model.agents.find((agent) => agent.id === 'NOVO-001')).toMatchObject({ workstationId: 'desk-pros-02' });
    expect(model.agents.find((agent) => agent.id === 'NOVO-001')?.route.length).toBeGreaterThan(1);
  });
});
