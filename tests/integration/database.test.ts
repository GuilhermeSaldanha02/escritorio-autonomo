import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INITIAL_AGENTS, migrateDown, migrateUp, migrationStatus, seedInitialAgents, type Pool } from '@escritorio/database';
import { EventStore } from '@escritorio/events';
import { createTestPool, resetDatabase } from './support.js';

const TABLES = ['agents', 'events', 'financial_ledger', 'model_calls', 'opportunities', 'outbox', 'tasks'];

let pool: Pool;

async function publicTables(): Promise<string[]> {
  const { rows } = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  return rows.map((row) => row.table_name);
}

beforeAll(async () => {
  pool = createTestPool();
  await resetDatabase(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('migrations', () => {
  it('criam as seis tabelas do M1, o outbox do M2 e a extensão pgvector', async () => {
    expect(await publicTables()).toEqual([...TABLES, 'schema_migrations'].sort());
    const { rows } = await pool.query(`SELECT extname FROM pg_extension WHERE extname = 'vector'`);
    expect(rows).toHaveLength(1);
  });

  it('são reversíveis e reaplicáveis', async () => {
    expect(await migrateDown(pool, 1)).toEqual(['0004_occurred_at_clock_real']);
    expect(await publicTables()).toContain('outbox'); // 0004 só muda um DEFAULT, não uma tabela

    expect(await migrateDown(pool, 1)).toEqual(['0003_orquestrador']);
    expect(await publicTables()).toContain('outbox'); // 0003 só remove uma coluna, não uma tabela

    expect(await migrateDown(pool, 1)).toEqual(['0002_outbox']);
    expect(await publicTables()).not.toContain('outbox');

    expect(await migrateDown(pool, 1)).toEqual(['0001_nucleo']);
    expect(await publicTables()).toEqual(['schema_migrations']);

    expect(await migrateUp(pool)).toEqual(['0001_nucleo', '0002_outbox', '0003_orquestrador', '0004_occurred_at_clock_real']);
    expect(await migrateUp(pool)).toEqual([]);
    expect(await migrationStatus(pool)).toEqual({
      applied: ['0001_nucleo', '0002_outbox', '0003_orquestrador', '0004_occurred_at_clock_real'],
      pending: [],
    });
  });
});

describe('seed', () => {
  it('cria os quatro agentes iniciais e é idempotente', async () => {
    expect((await seedInitialAgents(pool)).sort()).toEqual(INITIAL_AGENTS.map((a) => a.id).sort());
    expect(await seedInitialAgents(pool)).toEqual([]);

    const { rows } = await pool.query(
      'SELECT id, role, display_name, lifecycle_status, state FROM agents ORDER BY id',
    );
    expect(rows).toEqual([
      { id: 'CACADOR-001', role: 'CACADOR', display_name: 'Caçador', lifecycle_status: 'ACTIVE', state: 'IDLE' },
      {
        id: 'DESENVOLVEDOR-001',
        role: 'DESENVOLVEDOR',
        display_name: 'Desenvolvedor',
        lifecycle_status: 'ACTIVE',
        state: 'IDLE',
      },
      { id: 'DIRETOR-001', role: 'DIRETOR', display_name: 'Diretor', lifecycle_status: 'ACTIVE', state: 'IDLE' },
      { id: 'REVISOR-001', role: 'REVISOR', display_name: 'Revisor', lifecycle_status: 'ACTIVE', state: 'IDLE' },
    ]);
  });

  it('não sobrescreve o estado que um agente já acumulou', async () => {
    await pool.query(`UPDATE agents SET state = 'SEARCHING' WHERE id = 'CACADOR-001'`);
    await seedInitialAgents(pool);
    const { rows } = await pool.query(`SELECT state FROM agents WHERE id = 'CACADOR-001'`);
    expect(rows[0]).toEqual({ state: 'SEARCHING' });
  });
});

describe('regras de integridade no banco', () => {
  it('events é append-only: UPDATE e DELETE são recusados', async () => {
    const { event } = await new EventStore(pool).append({
      type: 'AGENT_STATE_CHANGED',
      payload: { agentId: 'CACADOR-001', from: 'IDLE', to: 'SEARCHING' },
    });
    await expect(pool.query(`UPDATE events SET type = 'X' WHERE id = $1`, [event.id])).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM events WHERE id = $1', [event.id])).rejects.toThrow(/append-only/);
  });

  it('financial_ledger é append-only e não aceita receita sem comprovante', async () => {
    await expect(
      pool.query(
        `INSERT INTO financial_ledger (entry_type, amount_brl, description, idempotency_key)
         VALUES ('REVENUE', 1, 'receita inventada', 'teste-receita')`,
      ),
    ).rejects.toThrow(/financial_ledger_check/);

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO financial_ledger (entry_type, amount_brl, description, idempotency_key)
       VALUES ('FOUNDER_SUBSIDY', 5, 'aporte experimental', 'teste-aporte') RETURNING id`,
    );
    await expect(
      pool.query('UPDATE financial_ledger SET amount_brl = 500 WHERE id = $1', [rows[0]?.id]),
    ).rejects.toThrow(/append-only/);
  });

  it('chamada de IA em modo mock não pode ter custo', async () => {
    await expect(
      pool.query(
        `INSERT INTO model_calls (agent_id, mode, provider, model, cost_brl, duration_ms, status)
         VALUES ('DIRETOR-001', 'mock', 'mock', 'mock-1', 0.5, 10, 'SUCCESS')`,
      ),
    ).rejects.toThrow(/model_calls_check/);
  });
});
