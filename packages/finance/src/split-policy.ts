export interface SplitCents {
  reserveCents: number;
  operationsCents: number;
  expansionCents: number;
}

export class InvalidMoneyAmountError extends Error {
  constructor(readonly amountCents: number) {
    super(`Valor em centavos precisa ser um inteiro não negativo: ${amountCents}`);
    this.name = 'InvalidMoneyAmountError';
  }
}

function assertValidCents(amountCents: number): void {
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    throw new InvalidMoneyAmountError(amountCents);
  }
}

/**
 * Split 50/30/20 determinístico (M5-PLANO.md, ajuste 1 da revisão externa —
 * regra normativa, não exemplo, para a implementação não decidir isso sozinha).
 * Nunca ponto flutuante: tudo em centavos inteiros. O resíduo do
 * arredondamento (`floor` por bucket) vai sempre para `RESERVE` — não importa
 * qual bucket recebe o resíduo, importa que seja determinístico e documentado.
 *
 * Invariante garantida sempre, para qualquer `revenueCents`:
 * `reserveCents + operationsCents + expansionCents === revenueCents`.
 */
export function computeSplit(revenueCents: number): SplitCents {
  assertValidCents(revenueCents);

  const reserveBase = Math.floor((revenueCents * 50) / 100);
  const operationsCents = Math.floor((revenueCents * 30) / 100);
  const expansionCents = Math.floor((revenueCents * 20) / 100);
  const remainder = revenueCents - reserveBase - operationsCents - expansionCents;
  const reserveCents = reserveBase + remainder;

  return { reserveCents, operationsCents, expansionCents };
}
