import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Pool, seedInitialAgents } from '@escritorio/database';
import { Governor, loadConstitution } from '@escritorio/governor';
import { ToolGateway } from '@escritorio/tool-gateway';
import { createDockerClient, SandboxManager } from '@escritorio/tools';
import { createTestPool, logger, resetDatabase } from './support.js';

const governor = new Governor(loadConstitution());
let pool: Pool;
let sandboxManager: SandboxManager;
let gateway: ToolGateway;

beforeAll(async () => {
  pool = createTestPool();
  sandboxManager = new SandboxManager(createDockerClient(), logger);
});
beforeEach(async () => {
  await resetDatabase(pool);
  await seedInitialAgents(pool);
  gateway = new ToolGateway({ pool, governor, sandboxManager, logger });
});
afterAll(async () => {
  await pool.end();
});

async function toolCallRow(id: string) {
  const { rows } = await pool.query(
    `SELECT tool, status, cost_brl, error, budget_reservation_id FROM tool_calls WHERE id = $1`,
    [id],
  );
  return rows[0] as { tool: string; status: string; cost_brl: string; error: string | null; budget_reservation_id: string | null };
}

describe('ToolGateway — execução real na sandbox do M2 (critério 6 e 7)', () => {
  it(
    'executa código de verdade e registra em tool_calls, custo R$0',
    async () => {
      const outcome = await gateway.execute({
        agentId: 'DESENVOLVEDOR-001',
        tool: 'CODE_EXECUTION',
        payload: { command: ['node', '-e', 'console.log("ok")'] },
      });

      expect(outcome.status).toBe('SUCCESS');
      expect(outcome.result?.stdout.trim()).toBe('ok');
      expect(outcome.result?.exitCode).toBe(0);

      const row = await toolCallRow(outcome.toolCallId);
      expect(row.tool).toBe('CODE_EXECUTION');
      expect(row.status).toBe('SUCCESS');
      expect(Number(row.cost_brl)).toBe(0);
    },
    30_000,
  );

  it('ferramenta fora do registro do Governor é BLOCKED antes de tocar a sandbox (critério 6)', async () => {
    const outcome = await gateway.execute({
      agentId: 'DESENVOLVEDOR-001',
      // @ts-expect-error — ferramenta inválida de propósito, simulando entrada não confiável.
      tool: 'DELETE_PRODUCTION_DATABASE',
      payload: { command: ['node', '-e', '1'] },
    });

    expect(outcome.status).toBe('BLOCKED');
    expect(outcome.error).toMatch(/UNKNOWN_TOOL|desconhecida/);
    const row = await toolCallRow(outcome.toolCallId);
    expect(row.status).toBe('BLOCKED');
    expect(row.budget_reservation_id).toBeNull(); // nem chegou a reservar orçamento
  });

  it('limites inválidos erram antes do Docker; reserva é devolvida, não fica presa', async () => {
    const outcome = await gateway.execute({
      agentId: 'DESENVOLVEDOR-001',
      tool: 'CODE_EXECUTION',
      payload: { command: ['node', '-e', '1'], limits: { cpuFraction: 0.0001 } },
    });

    expect(outcome.status).toBe('ERROR');
    const row = await toolCallRow(outcome.toolCallId);
    expect(row.status).toBe('ERROR');

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM budget_reservations WHERE id = $1', [
      row.budget_reservation_id,
    ]);
    expect(rows[0]?.status).toBe('RELEASED');
  });
});
