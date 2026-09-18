import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { releaseReservation, reserveBudget, settleReservation } from '@escritorio/budget';
import type { Pool } from '@escritorio/database';
import { Governor, loadConstitution } from '@escritorio/governor';
import { createTestPool, resetDatabase } from './support.js';

/**
 * Critério 5 do M3: a reserva de orçamento precisa ser atômica. O teste que
 * prova isso de verdade é o de concorrência real — dois `reserveBudget`
 * disparados ao mesmo tempo (`Promise.all`), não em sequência.
 */
const governor = new Governor(loadConstitution());
let pool: Pool;

beforeAll(async () => {
  pool = createTestPool();
});

beforeEach(async () => {
  await resetDatabase(pool);
});

afterAll(async () => {
  await pool.end();
});

async function reservationRow(id: string) {
  const { rows } = await pool.query<{ status: string; estimated_amount_brl: string; actual_amount_brl: string | null }>(
    `SELECT status, estimated_amount_brl, actual_amount_brl FROM budget_reservations WHERE id = $1`,
    [id],
  );
  return rows[0];
}

async function reservationCount(purpose: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM budget_reservations WHERE purpose = $1`, [
    purpose,
  ]);
  return Number(rows[0]?.count ?? 0);
}

describe('reserveBudget', () => {
  it('reserva quando dentro do teto e nega quando ultrapassaria (EXPERIMENTAL_BOOTSTRAP_MAX_BRL = 5)', async () => {
    const first = await reserveBudget(pool, governor, {
      purpose: 'EXPERIMENTAL_BOOTSTRAP',
      amountBrl: 3,
      idempotencyKey: 'teste:reserva-1',
      approvedByFounder: true,
    });
    expect(first.outcome).toBe('RESERVED');

    const second = await reserveBudget(pool, governor, {
      purpose: 'EXPERIMENTAL_BOOTSTRAP',
      amountBrl: 3,
      idempotencyKey: 'teste:reserva-2',
      approvedByFounder: true,
    });
    expect(second.outcome).toBe('DENIED');
    expect(second.decision.allowed).toBe(false);
  });

  it('reentrega com a mesma idempotencyKey retorna ALREADY_RESERVED, nunca duplica', async () => {
    const first = await reserveBudget(pool, governor, {
      purpose: 'EXPERIMENTAL_BOOTSTRAP',
      amountBrl: 2,
      idempotencyKey: 'teste:reentrega',
      approvedByFounder: true,
    });
    const second = await reserveBudget(pool, governor, {
      purpose: 'EXPERIMENTAL_BOOTSTRAP',
      amountBrl: 2,
      idempotencyKey: 'teste:reentrega',
      approvedByFounder: true,
    });
    expect(second.outcome).toBe('ALREADY_RESERVED');
    expect(second.reservationId).toBe(first.reservationId);
    expect(await reservationCount('EXPERIMENTAL_BOOTSTRAP')).toBe(1);
  });

  it(
    'concorrência real: 8 reservas simultâneas de R$1 contra teto de R$5 — no máximo 5 são aceitas',
    async () => {
      // Duas tentativas não bastam para forçar a sobreposição de forma
      // confiável (round-trip local é rápido demais — mutação sem o lock
      // passou 3/3 vezes com só duas tentativas). Com 8 concorrentes a
      // corrida aparece de forma repetível: sem pg_advisory_xact_lock,
      // este teste mediu 6/8 RESERVED (estourando o teto de R$5).
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          reserveBudget(pool, governor, {
            purpose: 'EXPERIMENTAL_BOOTSTRAP',
            amountBrl: 1,
            idempotencyKey: `teste:concorrente-${i}`,
            approvedByFounder: true,
          }),
        ),
      );
      const reservedCount = results.filter((r) => r.outcome === 'RESERVED').length;
      const deniedCount = results.filter((r) => r.outcome === 'DENIED').length;
      expect(reservedCount).toBe(5);
      expect(deniedCount).toBe(3);
    },
    20_000,
  );

  it('libera (RELEASED) uma reserva não usada; o valor some do "já gasto"', async () => {
    const reserved = await reserveBudget(pool, governor, {
      purpose: 'EXPERIMENTAL_BOOTSTRAP',
      amountBrl: 5,
      idempotencyKey: 'teste:libera',
      approvedByFounder: true,
    });
    expect(reserved.outcome).toBe('RESERVED');

    await releaseReservation(pool, reserved.reservationId!);
    expect((await reservationRow(reserved.reservationId!))?.status).toBe('RELEASED');

    // Com a reserva liberada, o teto de R$5 está livre de novo.
    const after = await reserveBudget(pool, governor, {
      purpose: 'EXPERIMENTAL_BOOTSTRAP',
      amountBrl: 5,
      idempotencyKey: 'teste:libera-2',
      approvedByFounder: true,
    });
    expect(after.outcome).toBe('RESERVED');
  });

  it('confirma (SETTLED) com o custo real, que passa a contar no "já gasto"', async () => {
    const reserved = await reserveBudget(pool, governor, {
      purpose: 'EXPERIMENTAL_BOOTSTRAP',
      amountBrl: 3,
      idempotencyKey: 'teste:settle',
      approvedByFounder: true,
    });
    await settleReservation(pool, reserved.reservationId!, 1);
    const row = await reservationRow(reserved.reservationId!);
    expect(row?.status).toBe('SETTLED');
    expect(Number(row?.actual_amount_brl)).toBe(1);

    // Só R$1 (o custo real) ocupa o teto agora — sobra R$4 para uma nova reserva.
    const next = await reserveBudget(pool, governor, {
      purpose: 'EXPERIMENTAL_BOOTSTRAP',
      amountBrl: 4,
      idempotencyKey: 'teste:settle-2',
      approvedByFounder: true,
    });
    expect(next.outcome).toBe('RESERVED');
  });
});
