import { visualStateResolver } from '../VisualStateResolver';
import { describe, expect, it } from 'vitest';

describe('visualStateResolver', () => {
  it.each([
    ['IDLE', 'OCIOSO', 'IDLE'],
    ['SEARCHING', 'PESQUISANDO', 'SEARCHING'],
    ['ANALYZING', 'ANALISANDO', 'ANALYZING'],
    ['THINKING', 'PENSANDO', 'ANALYZING'],
    ['CODING', 'PROGRAMANDO', 'WORKING'],
    ['TESTING', 'TESTANDO', 'WORKING'],
    ['REVIEWING', 'REVISANDO', 'WORKING'],
    ['WAITING', 'AGUARDANDO', 'WAITING'],
    ['BLOCKED', 'BLOQUEADO', 'BLOCKED'],
    ['SUCCESS', 'CONCLUÍDO', 'COMPLETED'],
    ['FAILED', 'FALHOU', 'FAILED'],
    ['SLEEP', 'DORMINDO', 'SLEEPING'],
    ['UNKNOWN', 'DESCONHECIDO', 'UNKNOWN'],
  ])('descreve %s de forma determinística', (state, label, category) => {
    expect(visualStateResolver(state)).toMatchObject({ state, label, category });
  });

  it('nunca infere um estado desconhecido', () => {
    expect(visualStateResolver('WORKING')).toMatchObject({
      state: 'UNKNOWN',
      label: 'DESCONHECIDO',
      category: 'UNKNOWN',
    });
  });
});
