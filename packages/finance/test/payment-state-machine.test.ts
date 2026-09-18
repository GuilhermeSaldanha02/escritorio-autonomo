import { describe, expect, it } from 'vitest';
import { IllegalPaymentTransitionError, transitionPaymentStatus } from '../src/payment-state-machine.js';

describe('transitionPaymentStatus', () => {
  it('percorre a trilha completa SUBMITTED → ACCEPTED → PAYMENT_PENDING → PAID', () => {
    let status = transitionPaymentStatus('SUBMITTED', 'ACCEPT');
    expect(status).toBe('ACCEPTED');
    status = transitionPaymentStatus(status, 'CONFIRM_PENDING');
    expect(status).toBe('PAYMENT_PENDING');
    status = transitionPaymentStatus(status, 'CONFIRM_PAID');
    expect(status).toBe('PAID');
  });

  it('rejeita pular etapas: SUBMITTED direto para PAYMENT_PENDING', () => {
    expect(() => transitionPaymentStatus('SUBMITTED', 'CONFIRM_PENDING')).toThrow(IllegalPaymentTransitionError);
  });

  it('rejeita pular etapas: SUBMITTED direto para PAID', () => {
    expect(() => transitionPaymentStatus('SUBMITTED', 'CONFIRM_PAID')).toThrow(IllegalPaymentTransitionError);
  });

  it('PAID é terminal — nenhum evento avança a partir dele', () => {
    for (const event of ['ACCEPT', 'REJECT', 'CONFIRM_PENDING', 'CONFIRM_PAID'] as const) {
      expect(() => transitionPaymentStatus('PAID', event)).toThrow(IllegalPaymentTransitionError);
    }
  });

  it('rejeita eventos fora de ordem em cada estado intermediário', () => {
    expect(() => transitionPaymentStatus('ACCEPTED', 'ACCEPT')).toThrow(IllegalPaymentTransitionError);
    expect(() => transitionPaymentStatus('PAYMENT_PENDING', 'ACCEPT')).toThrow(IllegalPaymentTransitionError);
  });
});
