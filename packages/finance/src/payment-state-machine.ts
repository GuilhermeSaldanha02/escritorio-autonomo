export const PAYMENT_STATUSES = ['SUBMITTED', 'ACCEPTED', 'PAYMENT_PENDING', 'PAID'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_EVENTS = ['ACCEPT', 'REJECT', 'CONFIRM_PENDING', 'CONFIRM_PAID'] as const;
export type PaymentEvent = (typeof PAYMENT_EVENTS)[number];

export class IllegalPaymentTransitionError extends Error {
  constructor(readonly from: PaymentStatus, readonly event: PaymentEvent) {
    super(`Transição ilegal: evento "${event}" não é válido a partir do status "${from}"`);
    this.name = 'IllegalPaymentTransitionError';
  }
}

/**
 * State machine do M5-PLANO.md ("`PaymentEvidence` → `PaymentConfirmationService`
 * → State Machine `SUBMITTED → ACCEPTED → PAYMENT_PENDING → PAID`"). `REJECT`
 * é terminal — modelado aqui como `SUBMITTED` (não avança), já que a rejeição
 * some do funil de pagamento; quem chama decide o que fazer com uma
 * oportunidade rejeitada fora desta máquina.
 */
const TRANSITIONS: Record<PaymentStatus, Partial<Record<PaymentEvent, PaymentStatus>>> = {
  SUBMITTED: { ACCEPT: 'ACCEPTED' },
  ACCEPTED: { CONFIRM_PENDING: 'PAYMENT_PENDING' },
  PAYMENT_PENDING: { CONFIRM_PAID: 'PAID' },
  PAID: {},
};

export function transitionPaymentStatus(from: PaymentStatus, event: PaymentEvent): PaymentStatus {
  const next = TRANSITIONS[from][event];
  if (!next) {
    throw new IllegalPaymentTransitionError(from, event);
  }
  return next;
}
