import { describe, expect, it } from 'vitest';
import {
  classifyRetry,
  consumesTaskRetry,
  isRetryableTechnicalError,
  RETRY_CLASSES,
  TECHNICAL_BACKOFF,
  type RetryCause,
} from '../src/retry-policy.js';

describe('classifyRetry', () => {
  const CASES: Array<[string, RetryCause, (typeof RETRY_CLASSES)[number]]> = [
    ['Revisor reprovou', { kind: 'REVIEW_FAILED' }, 'BUSINESS_RETRY'],
    ['sem slot para começar', { kind: 'SLOT_UNAVAILABLE' }, 'CAPACITY_WAIT'],
    ['Emergency Stop engajado', { kind: 'GATE', gate: 'EMERGENCY_STOP' }, 'EMERGENCY_PAUSE'],
    ['Stop impossível de verificar', { kind: 'GATE', gate: 'STOP_UNVERIFIABLE' }, 'EMERGENCY_PAUSE'],
    ['circuito aberto', { kind: 'GATE', gate: 'CIRCUIT_OPEN' }, 'CIRCUIT_BLOCK'],
    ['circuito ilegível', { kind: 'GATE', gate: 'CIRCUIT_UNVERIFIABLE' }, 'CIRCUIT_BLOCK'],
    ['erro de infraestrutura', { kind: 'ERROR', error: new Error('ECONNRESET') }, 'TECHNICAL_RETRY'],
  ];

  it.each(CASES)('%s vira a classe certa', (_name, cause, expected) => {
    expect(classifyRetry(cause)).toBe(expected);
  });

  it('SÓ a falha funcional consome MAX_TASK_RETRIES; nenhuma das outras quatro consome', () => {
    for (const [, cause, retryClass] of CASES) {
      expect(consumesTaskRetry(classifyRetry(cause)), retryClass).toBe(retryClass === 'BUSINESS_RETRY');
    }
    expect(RETRY_CLASSES.filter((c) => consumesTaskRetry(c))).toEqual(['BUSINESS_RETRY']);
  });
});

describe('isRetryableTechnicalError', () => {
  it('rede, banco e erros desconhecidos valem repetir', () => {
    expect(isRetryableTechnicalError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isRetryableTechnicalError(Object.assign(new Error('conexão'), { code: '08006' }))).toBe(true);
    expect(isRetryableTechnicalError(new Error('qualquer falha desconhecida'))).toBe(true);
    expect(isRetryableTechnicalError('string solta')).toBe(true);
  });

  it('erro de programação, de validação ou irrecuperável não vale repetir', () => {
    expect(isRetryableTechnicalError(new TypeError('x is undefined'))).toBe(false);
    expect(isRetryableTechnicalError(new RangeError('fora do intervalo'))).toBe(false);
    expect(isRetryableTechnicalError(new ReferenceError('y não definido'))).toBe(false);
    expect(isRetryableTechnicalError(Object.assign(new Error('payload inválido'), { name: 'ZodError' }))).toBe(false);
    expect(isRetryableTechnicalError(Object.assign(new Error('não repita'), { name: 'UnrecoverableError' }))).toBe(false);
  });
});

describe('TECHNICAL_BACKOFF', () => {
  it('é exponencial com jitter, e não fixo', () => {
    expect(TECHNICAL_BACKOFF.type).toBe('exponential');
    expect(TECHNICAL_BACKOFF.delay).toBeGreaterThan(0);
    expect(TECHNICAL_BACKOFF.jitter).toBeGreaterThan(0);
    expect(TECHNICAL_BACKOFF.jitter).toBeLessThanOrEqual(1);
  });
});
