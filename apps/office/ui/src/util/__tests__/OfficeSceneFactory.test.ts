import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fixtureOfficeDataSource } from '../../data/FixtureOfficeDataSource';
import { createOfficeSceneModel } from '../../office/scene-model';

const repositoryRoot = (() => {
  let current = resolve(process.cwd());
  while (!existsSync(resolve(current, 'assets/office/layout.json'))) {
    const parent = dirname(current);
    if (parent === current)
      throw new Error('Raiz do repositório não encontrada');
    current = parent;
  }
  return current;
})();
const layout = JSON.parse(
  readFileSync(resolve(repositoryRoot, 'assets/office/layout.json'), 'utf8'),
) as unknown;

describe('OfficeSceneFactory', () => {
  it('conduz probation pelas portas e contorna as mesas em todas as salas de trabalho', async () => {
    const snapshot = await fixtureOfficeDataSource.getSnapshot();
    const typedLayout = layout as Parameters<
      typeof createOfficeSceneModel
    >[0]['layout'];
    for (const room of typedLayout.rooms)
      for (const desk of room.workstations) {
        const local = structuredClone(snapshot);
        local.agents = [
          {
            ...local.agents[0],
            id: 'ENTRANTE',
            lifecycleStatus: 'PROBATION',
            workstationId: desk.workstationId,
          },
        ];
        const model = createOfficeSceneModel({
          layout: typedLayout,
          snapshot: local,
        });
        const route = model.agents[0].route;
        expect(route[1]).toEqual({
          x: (room.bounds.x + room.bounds.width / 2) * 20,
          y: 230,
        });
        for (let i = 1; i < route.length; i++) {
          const a = route[i - 1],
            b = route[i];
          expect(a.x === b.x || a.y === b.y).toBe(true);
          const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
          for (let step = 0; step <= steps; step++) {
            const fraction = steps === 0 ? 0 : step / steps;
            const x = a.x + (b.x - a.x) * fraction,
              y = a.y + (b.y - a.y) * fraction;
            // Feet may reach the chair, but never intersect a desk footprint.
            expect(
              model.workstations.some(
                (ws) =>
                  x > ws.x - 7 &&
                  x < ws.x + 59 &&
                  y > ws.y - 2 &&
                  y < ws.y + 34,
              ),
            ).toBe(false);
          }
        }
      }
  });
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

    const model = createOfficeSceneModel({
      layout: layout as Parameters<typeof createOfficeSceneModel>[0]['layout'],
      snapshot,
    });

    expect(model.rooms).toHaveLength(6);
    expect(
      model.workstations.filter(
        (workstation) => workstation.status === 'EMPTY',
      ),
    ).not.toHaveLength(0);
    expect(model.agents).toHaveLength(5);
    expect(model.agents.find((agent) => agent.id === 'NOVO-001')).toMatchObject(
      { workstationId: 'desk-pros-02' },
    );
    const probationAgent = model.agents.find(
      (agent) => agent.id === 'NOVO-001',
    );
    expect(probationAgent?.route.length).toBeGreaterThan(1);
    expect(probationAgent?.route.at(-1)?.y).toBeGreaterThan(
      model.workstations.find(
        (workstation) => workstation.id === 'desk-pros-02',
      )?.y ?? 0,
    );
  });
});
