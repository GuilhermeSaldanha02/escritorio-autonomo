import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AiGateway, ModelRouter } from '@escritorio/ai';
import { type Pool, seedInitialAgents } from '@escritorio/database';
import { Governor, loadConstitution } from '@escritorio/governor';
import { createTestPool, logger, resetDatabase } from './support.js';

const governor = new Governor(loadConstitution());
let pool: Pool;

beforeAll(async () => {
  pool = createTestPool();
});
beforeEach(async () => {
  await resetDatabase(pool);
  await seedInitialAgents(pool);
});
afterAll(async () => {
  await pool.end();
});

async function modelCallRow(id: string) {
  const { rows } = await pool.query(
    `SELECT mode, status, cost_brl, error, budget_reservation_id FROM model_calls WHERE id = $1`,
    [id],
  );
  return rows[0] as { mode: string; status: string; cost_brl: string; error: string | null; budget_reservation_id: string | null };
}

describe('AiGateway — modo mock (operacional no M3)', () => {
  it('completa com sucesso, custo R$0, e registra em model_calls', async () => {
    const gateway = new AiGateway({ pool, governor, router: new ModelRouter({ mode: 'mock' }), logger });
    const outcome = await gateway.complete({ agentId: 'DIRETOR-001', taskId: undefined, prompt: 'decida algo' });

    expect(outcome.status).toBe('SUCCESS');
    expect(outcome.content).toContain('mock');

    const row = await modelCallRow(outcome.modelCallId);
    expect(row.mode).toBe('mock');
    expect(row.status).toBe('SUCCESS');
    expect(Number(row.cost_brl)).toBe(0);
  });
});

describe('AiGateway — idempotência da auditoria (recomendação da revisão externa no fechamento do M3)', () => {
  it('duas chamadas com o mesmo agentId+correlationId resolvem para a MESMA linha em model_calls', async () => {
    const gateway = new AiGateway({ pool, governor, router: new ModelRouter({ mode: 'mock' }), logger });
    const correlationId = crypto.randomUUID();

    const first = await gateway.complete({ agentId: 'DIRETOR-001', correlationId, prompt: 'resuma a decisão' });
    const second = await gateway.complete({ agentId: 'DIRETOR-001', correlationId, prompt: 'resuma a decisão' });

    expect(second.modelCallId).toBe(first.modelCallId);
    expect(second.status).toBe('SUCCESS');

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM model_calls WHERE agent_id = 'DIRETOR-001' AND correlation_id = $1`,
      [correlationId],
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it('correlationId diferente nunca compartilha a linha — não é uma dedup por acidente', async () => {
    const gateway = new AiGateway({ pool, governor, router: new ModelRouter({ mode: 'mock' }), logger });
    const first = await gateway.complete({ agentId: 'DIRETOR-001', correlationId: crypto.randomUUID(), prompt: 'x' });
    const second = await gateway.complete({ agentId: 'DIRETOR-001', correlationId: crypto.randomUUID(), prompt: 'x' });
    expect(second.modelCallId).not.toBe(first.modelCallId);
  });
});

describe('AiGateway — orçamento nega antes de qualquer execução (critério 4)', () => {
  it('BLOCKED quando o Governor nega o orçamento; nunca chama o adapter', async () => {
    const gateway = new AiGateway({
      pool,
      governor,
      router: new ModelRouter({ mode: 'mock' }),
      logger,
      // DEVELOPMENT_EXTERNAL_SERVICE tem teto R$0 — qualquer valor > 0 é negado sem AUTO_SPEND.
      estimateCostBrl: () => 1,
    });
    const outcome = await gateway.complete({ agentId: 'DIRETOR-001', prompt: 'x' });

    expect(outcome.status).toBe('BLOCKED');
    const row = await modelCallRow(outcome.modelCallId);
    expect(row.status).toBe('BLOCKED');
    expect(Number(row.cost_brl)).toBe(0);
    expect(row.error).toMatch(/AUTO_SPEND|DEVELOPMENT_EXTERNAL_SERVICES_TARGET_BRL/);
  });
});

describe('AiGateway — local/api NOT_CONFIGURED vira ERRO conhecido, não sucesso silencioso (critério 10)', () => {
  it('modo local sem baseUrl: ERROR registrado, reserva devolvida', async () => {
    const gateway = new AiGateway({ pool, governor, router: new ModelRouter({ mode: 'local' }), logger });
    const outcome = await gateway.complete({ agentId: 'DESENVOLVEDOR-001', prompt: 'codifique' });

    expect(outcome.status).toBe('ERROR');
    expect(outcome.error).toMatch(/NOT_CONFIGURED/);

    const row = await modelCallRow(outcome.modelCallId);
    expect(row.mode).toBe('local');
    expect(row.status).toBe('ERROR');
    expect(Number(row.cost_brl)).toBe(0);

    // A reserva foi devolvida (RELEASED), não ficou presa como RESERVED.
    const { rows } = await pool.query<{ status: string }>('SELECT status FROM budget_reservations WHERE id = $1', [
      row.budget_reservation_id,
    ]);
    expect(rows[0]?.status).toBe('RELEASED');
  });
});
