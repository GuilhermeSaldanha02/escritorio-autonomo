import { beforeEach, describe, expect, it } from 'vitest';
import { type Pool, seedInitialAgents } from '@escritorio/database';
import {
  TransitionConflictError,
  transitionOpportunity,
  TransitionNotFoundError,
  transitionTask,
} from '@escritorio/events';
import { createTestPool, resetDatabase } from './support.js';

/**
 * Transição atômica no banco (revisão externa antes do passo 5): fecha o gap
 * deixado no passo 2, onde `assertOpportunityTransition`/`assertTaskTransition`
 * só validavam em memória. Aqui `UPDATE ... WHERE status = $from` dentro da
 * mesma transação do evento é a garantia real — duas tentativas concorrentes
 * da mesma transição só podem produzir uma linha de evento cada.
 */
let pool: Pool;

beforeEach(async () => {
  pool = createTestPool();
  await resetDatabase(pool);
  await seedInitialAgents(pool);
});

async function insertOpportunity(status = 'DISCOVERED'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO opportunities (source, source_url, title, status)
     VALUES ('teste', $1, 'Oportunidade de teste', $2) RETURNING id`,
    [`https://exemplo.test/${crypto.randomUUID()}`, status],
  );
  return rows[0]!.id;
}

async function insertTask(status = 'CREATED'): Promise<string> {
  const opportunityId = await insertOpportunity('APPROVED');
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO tasks (opportunity_id, objective, status) VALUES ($1, 'Objetivo de teste', $2) RETURNING id`,
    [opportunityId, status],
  );
  return rows[0]!.id;
}

describe('transitionTask / transitionOpportunity', () => {
  it('aplica a transição, grava o evento e retorna APPLIED', async () => {
    const taskId = await insertTask('CREATED');
    const result = await transitionTask(pool, {
      id: taskId,
      from: 'CREATED',
      to: 'ASSIGNED',
      idempotencyKey: `task:${taskId}:assigned`,
      event: { type: 'TASK_ASSIGNED', payload: {}, taskId },
    });
    expect(result.outcome).toBe('APPLIED');
    expect(result.created).toBe(true);

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [taskId]);
    expect(rows[0]?.status).toBe('ASSIGNED');
  });

  it('recusa transição não prevista no ciclo antes de tocar o banco', async () => {
    const taskId = await insertTask('CREATED');
    await expect(
      transitionTask(pool, {
        id: taskId,
        from: 'CREATED',
        to: 'COMPLETED',
        idempotencyKey: `task:${taskId}:pula-etapa`,
        event: { type: 'TASK_ASSIGNED', payload: {}, taskId },
      }),
    ).rejects.toThrow('Transição inválida');

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [taskId]);
    expect(rows[0]?.status).toBe('CREATED'); // nada mudou — nem estado, nem evento
  });

  it('reentrega da mesma transição (mesma idempotencyKey) retorna ALREADY_APPLIED, não erro nem duplicidade', async () => {
    const taskId = await insertTask('CREATED');
    const key = `task:${taskId}:assigned`;
    const first = await transitionTask(pool, {
      id: taskId,
      from: 'CREATED',
      to: 'ASSIGNED',
      idempotencyKey: key,
      event: { type: 'TASK_ASSIGNED', payload: {}, taskId },
    });
    expect(first.outcome).toBe('APPLIED');

    // Segunda entrega do "mesmo job": from ainda diz CREATED (visão do worker que redisparou),
    // mas o banco já está em ASSIGNED — não deve virar TransitionConflictError.
    const second = await transitionTask(pool, {
      id: taskId,
      from: 'CREATED',
      to: 'ASSIGNED',
      idempotencyKey: key,
      event: { type: 'TASK_ASSIGNED', payload: {}, taskId },
    });
    expect(second.outcome).toBe('ALREADY_APPLIED');
    expect(second.event.id).toBe(first.event.id);

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM events WHERE idempotency_key = $1`,
      [key],
    );
    expect(rows[0]?.count).toBe('1'); // nunca duplicou o evento
  });

  it('conflito real de estado (status atual não é from nem to) lança TransitionConflictError', async () => {
    const taskId = await insertTask('CREATED');
    // Alguém já moveu para BLOCKED por outro caminho — nossa visão de "from: CREATED" está desatualizada de verdade.
    await pool.query(`UPDATE tasks SET status = 'BLOCKED' WHERE id = $1`, [taskId]);

    await expect(
      transitionTask(pool, {
        id: taskId,
        from: 'CREATED',
        to: 'ASSIGNED',
        idempotencyKey: `task:${taskId}:assigned`,
        event: { type: 'TASK_ASSIGNED', payload: {}, taskId },
      }),
    ).rejects.toThrow(TransitionConflictError);
  });

  it('entidade inexistente lança TransitionNotFoundError', async () => {
    await expect(
      transitionTask(pool, {
        id: crypto.randomUUID(),
        from: 'CREATED',
        to: 'ASSIGNED',
        idempotencyKey: 'task:inexistente:assigned',
        event: { type: 'TASK_ASSIGNED', payload: {} },
      }),
    ).rejects.toThrow(TransitionNotFoundError);
  });

  it('duas transições concorrentes do mesmo from: exatamente uma aplica, a outra vê conflito real', async () => {
    const taskId = await insertTask('IN_PROGRESS');
    const attempt = (to: 'IMPLEMENTATION_READY' | 'FAILED') =>
      transitionTask(pool, {
        id: taskId,
        from: 'IN_PROGRESS',
        to,
        idempotencyKey: `task:${taskId}:concorrente:${to}`,
        event: { type: 'TASK_STARTED', payload: {}, taskId },
      });

    const results = await Promise.allSettled([attempt('IMPLEMENTATION_READY'), attempt('FAILED')]);
    const applied = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(applied).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(TransitionConflictError);

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [taskId]);
    expect(['IMPLEMENTATION_READY', 'FAILED']).toContain(rows[0]?.status);
  });

  it('opportunity: agente não pode declarar fato externo (ACCEPTED)', async () => {
    const opportunityId = await insertOpportunity('SUBMITTED');
    await expect(
      transitionOpportunity(pool, {
        id: opportunityId,
        from: 'SUBMITTED',
        to: 'ACCEPTED',
        actor: { kind: 'agent', role: 'DIRETOR' },
        idempotencyKey: `opportunity:${opportunityId}:accepted`,
        event: { type: 'OPPORTUNITY_VERIFIED', payload: {}, opportunityId },
      }),
    ).rejects.toThrow('não pode declarar fato externo');

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM opportunities WHERE id = $1', [
      opportunityId,
    ]);
    expect(rows[0]?.status).toBe('SUBMITTED');
  });

  it('opportunity: sistema ORCHESTRATOR pode declarar ACCEPTED, mas só PAYMENT_CONFIRMATION pode declarar PAID', async () => {
    const opportunityId = await insertOpportunity('SUBMITTED');
    const accepted = await transitionOpportunity(pool, {
      id: opportunityId,
      from: 'SUBMITTED',
      to: 'ACCEPTED',
      actor: { kind: 'system', component: 'ORCHESTRATOR' },
      idempotencyKey: `opportunity:${opportunityId}:accepted`,
      event: { type: 'OPPORTUNITY_VERIFIED', payload: {}, opportunityId },
    });
    expect(accepted.outcome).toBe('APPLIED');

    await pool.query(`UPDATE opportunities SET status = 'PAYMENT_PENDING' WHERE id = $1`, [opportunityId]);

    await expect(
      transitionOpportunity(pool, {
        id: opportunityId,
        from: 'PAYMENT_PENDING',
        to: 'PAID',
        actor: { kind: 'system', component: 'ORCHESTRATOR' },
        idempotencyKey: `opportunity:${opportunityId}:paid`,
        event: { type: 'PAYMENT_CONFIRMED', payload: {}, opportunityId },
      }),
    ).rejects.toThrow('PAID exige confirmação de pagamento real');

    const paid = await transitionOpportunity(pool, {
      id: opportunityId,
      from: 'PAYMENT_PENDING',
      to: 'PAID',
      actor: { kind: 'system', component: 'PAYMENT_CONFIRMATION' },
      idempotencyKey: `opportunity:${opportunityId}:paid`,
      event: { type: 'PAYMENT_CONFIRMED', payload: {}, opportunityId },
    });
    expect(paid.outcome).toBe('APPLIED');
  });
});
