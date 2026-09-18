import { describe, expect, it } from 'vitest';
import {
  decideLifecycle,
  isEligibleWindow,
  type LifecycleInput,
  type LifecycleParams,
  pauseIntervals,
  type PerformanceAction,
  type WindowAssessment,
} from '../src/lifecycle-policy.js';

const HOUR = 3_600_000;
const NOW = new Date('2026-09-18T12:00:00.000Z');
const PARAMS: LifecycleParams = {
  minSample: 5,
  promoteConsecutiveWindows: 2,
  sleepConsecutiveBadWindows: 3,
  transitionCooldownMs: 24 * HOUR,
  sleepMinDurationMs: 24 * HOUR,
};

/** Janela `daysAgo` dias atrás (0 = a mais recente), com 24h de duração. */
function window(daysAgo: number, action: PerformanceAction, sampleSize = 10): WindowAssessment {
  const to = new Date(NOW.getTime() - daysAgo * 24 * HOUR);
  return { id: `w${daysAgo}`, windowFrom: new Date(to.getTime() - 24 * HOUR), windowTo: to, sampleSize, recommendedAction: action };
}

function input(overrides: Partial<LifecycleInput>): LifecycleInput {
  return { current: 'ACTIVE', windows: [], pauses: [], hasEligibleDemand: false, now: NOW, params: PARAMS, ...overrides };
}

describe('PROBATION -> ACTIVE', () => {
  it('promove com N janelas PROMOTE consecutivas, elegíveis, e devolve a evidência', () => {
    const decision = decideLifecycle(input({ current: 'PROBATION', windows: [window(0, 'PROMOTE'), window(1, 'PROMOTE')] }));
    expect(decision).toEqual({ action: 'TRANSITION', to: 'ACTIVE', reason: '2 janelas PROMOTE consecutivas', evidenceWindowIds: ['w0', 'w1'] });
  });

  it('uma janela KEEP no meio quebra a sequência', () => {
    expect(decideLifecycle(input({ current: 'PROBATION', windows: [window(0, 'PROMOTE'), window(1, 'KEEP')] })).action).toBe('NONE');
  });

  it('com menos janelas que o exigido, não promove', () => {
    expect(decideLifecycle(input({ current: 'PROBATION', windows: [window(0, 'PROMOTE')] })).action).toBe('NONE');
  });

  it('janela PROMOTE com amostra insuficiente não vale', () => {
    expect(decideLifecycle(input({ current: 'PROBATION', windows: [window(0, 'PROMOTE'), window(1, 'PROMOTE', 4)] })).action).toBe('NONE');
  });
});

describe('ACTIVE -> SLEEP (critério 18: pausa e falta de amostra nunca são desempenho ruim)', () => {
  const bad = [window(0, 'INVESTIGATE'), window(1, 'INVESTIGATE'), window(2, 'INVESTIGATE')];

  it('dorme só com janelas ruins CONSECUTIVAS e elegíveis', () => {
    expect(decideLifecycle(input({ windows: bad }))).toMatchObject({ action: 'TRANSITION', to: 'SLEEP', evidenceWindowIds: ['w0', 'w1', 'w2'] });
  });

  it('uma avaliação ruim isolada não dorme ninguém', () => {
    expect(decideLifecycle(input({ windows: [window(0, 'INVESTIGATE'), window(1, 'KEEP'), window(2, 'INVESTIGATE')] })).action).toBe('NONE');
    expect(decideLifecycle(input({ windows: [window(0, 'INVESTIGATE')] })).action).toBe('NONE');
  });

  it('AMOSTRA INSUFICIENTE NUNCA CONTA COMO RUIM: INVESTIGATE com amostra pequena não dorme o agente', () => {
    const noActivity = [window(0, 'INVESTIGATE', 0), window(1, 'INVESTIGATE', 0), window(2, 'INVESTIGATE', 0)];
    expect(decideLifecycle(input({ windows: noActivity })).action).toBe('NONE');
    const almost = [window(0, 'INVESTIGATE', 4), window(1, 'INVESTIGATE', 4), window(2, 'INVESTIGATE', 4)];
    expect(decideLifecycle(input({ windows: almost })).action).toBe('NONE');
  });

  it('JANELA SOBREPOSTA A UMA PAUSA não vale: sem o ciclo "circuito aberto -> agente parado -> SLEEP"', () => {
    const w1 = bad[1]!;
    const pause = { from: new Date(w1.windowFrom.getTime() + HOUR), to: new Date(w1.windowFrom.getTime() + 2 * HOUR) };
    expect(decideLifecycle(input({ windows: bad, pauses: [pause] })).action).toBe('NONE');
  });

  it('uma pausa que só encosta na borda da janela não a invalida', () => {
    const w = bad[0]!;
    const touching = [
      { from: new Date(w.windowTo.getTime()), to: new Date(w.windowTo.getTime() + HOUR) }, // começa quando a janela acaba
      { from: new Date(w.windowFrom.getTime() - HOUR), to: new Date(w.windowFrom.getTime()) }, // acaba quando a janela começa
    ];
    expect(isEligibleWindow(w, touching, PARAMS.minSample)).toBe(true);
  });

  it('a pausa de um período que nem toca as janelas recentes não atrapalha', () => {
    const oldPause = { from: new Date(NOW.getTime() - 30 * 24 * HOUR), to: new Date(NOW.getTime() - 29 * 24 * HOUR) };
    expect(decideLifecycle(input({ windows: bad, pauses: [oldPause] })).action).toBe('TRANSITION');
  });
});

describe('cooldown (histerese)', () => {
  it('nenhuma transição dentro do cooldown da anterior, mesmo com evidência forte', () => {
    const recent = new Date(NOW.getTime() - 2 * HOUR);
    const bad = [window(0, 'INVESTIGATE'), window(1, 'INVESTIGATE'), window(2, 'INVESTIGATE')];
    expect(decideLifecycle(input({ windows: bad, lastTransitionAt: recent }))).toEqual({ action: 'NONE', reason: 'COOLDOWN' });
    const old = new Date(NOW.getTime() - 25 * HOUR);
    expect(decideLifecycle(input({ windows: bad, lastTransitionAt: old })).action).toBe('TRANSITION');
  });

  it('o cooldown vale exatamente no limite: 24h completas liberam', () => {
    const exactly = new Date(NOW.getTime() - 24 * HOUR);
    const bad = [window(0, 'INVESTIGATE'), window(1, 'INVESTIGATE'), window(2, 'INVESTIGATE')];
    expect(decideLifecycle(input({ windows: bad, lastTransitionAt: exactly })).action).toBe('TRANSITION');
  });
});

describe('SLEEP -> ACTIVE (critério 19: não depende de novo desempenho)', () => {
  const asleepFor = (hours: number) => new Date(NOW.getTime() - hours * HOUR);

  it('acorda com cooldown vencido e demanda elegível, SEM nenhuma janela de desempenho', () => {
    expect(decideLifecycle(input({ current: 'SLEEP', windows: [], sleepingSince: asleepFor(30), hasEligibleDemand: true }))).toMatchObject({
      action: 'TRANSITION',
      to: 'ACTIVE',
      evidenceWindowIds: [],
    });
  });

  it('antes do tempo mínimo em SLEEP, não acorda, mesmo com demanda', () => {
    expect(decideLifecycle(input({ current: 'SLEEP', sleepingSince: asleepFor(5), hasEligibleDemand: true }))).toEqual({ action: 'NONE', reason: 'SLEEP_MIN_DURATION' });
  });

  it('sem demanda elegível, continua dormindo, mesmo depois do tempo mínimo', () => {
    expect(decideLifecycle(input({ current: 'SLEEP', sleepingSince: asleepFor(100), hasEligibleDemand: false }))).toEqual({ action: 'NONE', reason: 'SEM_DEMANDA_ELEGIVEL' });
  });

  it('janelas ruins antigas não impedem o despertar (a decisão ignora o desempenho)', () => {
    const stale = [window(10, 'INVESTIGATE'), window(11, 'INVESTIGATE'), window(12, 'INVESTIGATE')];
    expect(decideLifecycle(input({ current: 'SLEEP', windows: stale, sleepingSince: asleepFor(40), hasEligibleDemand: true })).action).toBe('TRANSITION');
  });
});

describe('pauseIntervals', () => {
  const at = (h: number) => new Date(NOW.getTime() + h * HOUR);
  const OPEN = ['ENGAGED'];
  const CLOSE = ['RELEASED'];

  it('pareia abertura e fechamento na ordem', () => {
    expect(pauseIntervals([{ type: 'ENGAGED', at: at(0) }, { type: 'RELEASED', at: at(2) }, { type: 'ENGAGED', at: at(5) }, { type: 'RELEASED', at: at(6) }], OPEN, CLOSE, at(10))).toEqual([
      { from: at(0), to: at(2) },
      { from: at(5), to: at(6) },
    ]);
  });

  it('um período ainda aberto vai até agora', () => {
    expect(pauseIntervals([{ type: 'ENGAGED', at: at(3) }], OPEN, CLOSE, at(10))).toEqual([{ from: at(3), to: at(10) }]);
  });

  it('aberturas repetidas mantêm o início original, e fechamento sem abertura é ignorado', () => {
    expect(pauseIntervals([{ type: 'RELEASED', at: at(0) }, { type: 'ENGAGED', at: at(1) }, { type: 'ENGAGED', at: at(2) }, { type: 'RELEASED', at: at(4) }], OPEN, CLOSE, at(10))).toEqual([
      { from: at(1), to: at(4) },
    ]);
  });
});
