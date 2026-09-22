import { describe, expect, it } from 'vitest';

import { getWorkspaceClassName } from '../workspace-layout';

describe('workspace layout', () => {
  it('mantém o Office como protagonista sem seleção', () => {
    expect(getWorkspaceClassName(null)).toBe('office-workspace is-empty');
  });

  it('reserva o Inspector quando há agente selecionado', () => {
    expect(getWorkspaceClassName('CACADOR-001')).toBe('office-workspace has-selection');
  });
});
