import { describe, expect, it } from 'vitest';
import {
  admission,
  type BreakerPolicy,
  type CircuitEvent,
  foldBreaker,
  INITIAL_BREAKER_STATE,
  shouldOpen,
} from '../src/circuit-breaker.js';

const POLICY: BreakerPolicy = { failureThreshold: 3, cooldownMs: 60_000, minSample: 1 };
const T0 = new Date('2026-09-18T12:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const ev = (type: CircuitEvent['type'], seconds = 0): CircuitEvent => ({ type, at: at(seconds) });

describe('foldBreaker', () => {
  it('sem eventos, o circuito está fechado', () => {
    expect(foldBreaker([])).toEqual(INITIAL_BREAKER_STATE);
  });

  it('conta falhas consecutivas e zera no sucesso', () => {
    expect(foldBreaker([ev('FAILURE'), ev('FAILURE')]).consecutiveFailures).toBe(2);
    expect(foldBreaker([ev('FAILURE'), ev('FAILURE'), ev('SUCCESS')]).consecutiveFailures).toBe(0);
  });

  it('OPENED abre, HALF_OPEN e CLOSED seguem o ciclo, e o instante fica em `since`', () => {
    expect(foldBreaker([ev('OPENED', 5)])).toMatchObject({ status: 'OPEN', since: at(5) });
    expect(foldBreaker([ev('OPENED', 5), ev('HALF_OPEN', 70)])).toMatchObject({ status: 'HALF_OPEN', since: at(70) });
    const closed = foldBreaker([ev('FAILURE'), ev('OPENED', 5), ev('HALF_OPEN', 70), ev('CLOSED', 71)]);
    expect(closed).toMatchObject({ status: 'CLOSED', consecutiveFailures: 0 });
    expect(closed.since).toBeUndefined();
  });

  it('fechar mantém o total de desfechos (o mínimo de amostra não reinicia)', () => {
    expect(foldBreaker([ev('FAILURE'), ev('SUCCESS'), ev('OPENED'), ev('CLOSED')]).totalOutcomes).toBe(2);
  });
});

describe('shouldOpen', () => {
  it('abre só no limiar de falhas consecutivas', () => {
    expect(shouldOpen(foldBreaker([ev('FAILURE'), ev('FAILURE')]), POLICY)).toBe(false);
    expect(shouldOpen(foldBreaker([ev('FAILURE'), ev('FAILURE'), ev('FAILURE')]), POLICY)).toBe(true);
  });

  it('um sucesso no meio zera a contagem', () => {
    expect(shouldOpen(foldBreaker([ev('FAILURE'), ev('FAILURE'), ev('SUCCESS'), ev('FAILURE')]), POLICY)).toBe(false);
  });

  it('respeita o mínimo de amostra', () => {
    const state = foldBreaker([ev('FAILURE'), ev('FAILURE'), ev('FAILURE')]);
    expect(shouldOpen(state, { ...POLICY, minSample: 5 })).toBe(false);
    expect(shouldOpen(state, { ...POLICY, minSample: 3 })).toBe(true);
  });

  it('um circuito que já não está fechado não reabre por contagem', () => {
    const open = foldBreaker([ev('FAILURE'), ev('FAILURE'), ev('FAILURE'), ev('OPENED')]);
    expect(shouldOpen(open, POLICY)).toBe(false);
  });
});

describe('admission', () => {
  it('fechado admite', () => {
    expect(admission(INITIAL_BREAKER_STATE, POLICY, at(0))).toBe('ADMIT');
  });

  it('aberto nega antes do cooldown e oferece UMA sonda depois dele', () => {
    const open = foldBreaker([ev('OPENED', 0)]);
    expect(admission(open, POLICY, at(59))).toBe('DENY');
    expect(admission(open, POLICY, at(60))).toBe('PROBE');
  });

  it('com a sonda em curso (HALF_OPEN recente), nega as demais', () => {
    const half = foldBreaker([ev('OPENED', 0), ev('HALF_OPEN', 60)]);
    expect(admission(half, POLICY, at(61))).toBe('DENY');
  });

  it('uma sonda que nunca reportou não trava o circuito para sempre', () => {
    const half = foldBreaker([ev('OPENED', 0), ev('HALF_OPEN', 60)]);
    expect(admission(half, POLICY, at(120))).toBe('PROBE');
  });
});
