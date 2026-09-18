import { describe, expect, it } from 'vitest';
import { computeSplit, InvalidMoneyAmountError } from '../src/split-policy.js';

describe('computeSplit', () => {
  it('divide um valor exatamente divisível em 50/30/20', () => {
    const result = computeSplit(10_000); // R$100,00
    expect(result).toEqual({ reserveCents: 5_000, operationsCents: 3_000, expansionCents: 2_000 });
  });

  it('resíduo do arredondamento vai sempre para RESERVE — regra normativa, não escolha livre', () => {
    // R$101,01 = 10101 centavos: 50%=5050.5, 30%=3030.3, 20%=2020.2 -> floor 5050+3030+2020=10100, resíduo=1
    const result = computeSplit(10_101);
    expect(result.reserveCents).toBe(5_051); // 5050 + resíduo de 1
    expect(result.operationsCents).toBe(3_030);
    expect(result.expansionCents).toBe(2_020);
  });

  it.each([0, 1, 2, 3, 7, 11, 99, 100, 101, 9_999, 10_000, 10_101, 1_234_567, 999_999_999])(
    'conserva exatamente o valor total para revenueCents=%i — critério de mutation testing obrigatório',
    (revenueCents) => {
      const result = computeSplit(revenueCents);
      expect(result.reserveCents + result.operationsCents + result.expansionCents).toBe(revenueCents);
    },
  );

  it('nunca produz um bucket negativo', () => {
    for (let cents = 0; cents <= 500; cents++) {
      const result = computeSplit(cents);
      expect(result.reserveCents).toBeGreaterThanOrEqual(0);
      expect(result.operationsCents).toBeGreaterThanOrEqual(0);
      expect(result.expansionCents).toBeGreaterThanOrEqual(0);
    }
  });

  it('é determinístico — mesma entrada sempre produz a mesma saída', () => {
    expect(computeSplit(12_345)).toEqual(computeSplit(12_345));
  });

  it.each([-1, 1.5, NaN, Infinity])('rejeita valor inválido em centavos: %s', (invalid) => {
    expect(() => computeSplit(invalid)).toThrow(InvalidMoneyAmountError);
  });
});
