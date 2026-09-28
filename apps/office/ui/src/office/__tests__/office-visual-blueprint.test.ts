import { describe, expect, it } from 'vitest';

import { getAgentVisualProfile, getRoomVisualBlueprint } from '../visual-blueprint';

describe('blueprint visual original do escritório', () => {
  it('dá identidade física às seis salas e evita áreas sem mobiliário', () => {
    const roomIds = [
      'room-prospecting',
      'room-boardroom',
      'room-breakroom',
      'room-engineering',
      'room-qa-review',
      'room-servers',
    ];

    for (const roomId of roomIds) {
      const blueprint = getRoomVisualBlueprint(roomId);
      expect(blueprint.floorPattern.length).toBeGreaterThan(0);
      expect(blueprint.decor.length).toBeGreaterThan(0);
      expect(blueprint.wallAccent).toBeTruthy();
    }

    expect(getRoomVisualBlueprint('room-breakroom').decor).toEqual(
      expect.arrayContaining(['coffee', 'couch', 'plant']),
    );
    expect(getRoomVisualBlueprint('room-servers').decor).toEqual(
      expect.arrayContaining(['rack', 'cable']),
    );
  });

  it('distingue visualmente os quatro agentes sem mudar o estado de domínio', () => {
    const profiles = ['CACADOR-001', 'DIRETOR-001', 'DESENVOLVEDOR-001', 'REVISOR-001']
      .map(getAgentVisualProfile);

    expect(new Set(profiles.map((profile) => profile.accent)).size).toBe(4);
    expect(profiles.every((profile) => profile.outfit && profile.accessory)).toBe(true);
  });
});
