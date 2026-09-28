import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = (() => {
  let current = resolve(process.cwd());
  while (!existsSync(resolve(current, 'assets/office/layout.json'))) {
    const parent = dirname(current);
    if (parent === current) throw new Error('Raiz do repositório não encontrada');
    current = parent;
  }
  return current;
})();
const layoutPath = resolve(repositoryRoot, 'assets/office/layout.json');
const palettePath = resolve(repositoryRoot, 'assets/office/palette.json');

describe('assets aprovados do Office', () => {
  it('define a planta com postos únicos, vazios e os quatro fundadores', () => {
    expect(existsSync(layoutPath)).toBe(true);

    const layout = JSON.parse(readFileSync(layoutPath, 'utf8')) as {
      rooms: Array<{
        workstations: Array<{ workstationId: string; assignedAgentId: string | null; status: string }>;
      }>;
    };
    const workstations = layout.rooms.flatMap((room) => room.workstations);
    const ids = workstations.map((workstation) => workstation.workstationId);
    const assignedAgentIds = workstations.flatMap((workstation) =>
      workstation.assignedAgentId === null ? [] : [workstation.assignedAgentId],
    );

    expect(new Set(ids).size).toBe(ids.length);
    expect(workstations.some((workstation) => workstation.status === 'EMPTY')).toBe(true);
    expect(assignedAgentIds).toEqual(
      expect.arrayContaining(['CACADOR-001', 'DIRETOR-001', 'DESENVOLVEDOR-001', 'REVISOR-001']),
    );
  });

  it('define todos os estados oficiais e o fallback UNKNOWN na paleta', () => {
    expect(existsSync(palettePath)).toBe(true);

    const palette = JSON.parse(readFileSync(palettePath, 'utf8')) as { states: Record<string, unknown> };

    expect(Object.keys(palette.states)).toEqual(
      expect.arrayContaining([
        'IDLE',
        'SEARCHING',
        'ANALYZING',
        'THINKING',
        'CODING',
        'TESTING',
        'REVIEWING',
        'WAITING',
        'BLOCKED',
        'SUCCESS',
        'FAILED',
        'SLEEP',
        'UNKNOWN',
      ]),
    );
  });
});
