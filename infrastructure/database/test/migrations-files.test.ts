import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MigrationError, readMigrations } from '@escritorio/database';

const REQUIRED_TABLES = ['agents', 'opportunities', 'tasks', 'events', 'model_calls', 'financial_ledger'];

function tempDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'migrations-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

describe('arquivos de migration', () => {
  it('toda migration do repositório tem up e down, em ordem', () => {
    const migrations = readMigrations();
    expect(migrations.map((m) => m.id)).toEqual([
      '0001_nucleo',
      '0002_outbox',
      '0003_orquestrador',
      '0004_occurred_at_clock_real',
      '0005_budget',
      '0006_model_calls_audit',
      '0007_tool_calls',
      '0008_model_calls_idempotent',
      '0009_opportunities_m4_identity',
      '0010_financial_ledger_economy',
      '0011_memoria_performance',
      '0012_memories_scope_trust',
      '0013_autonomia',
    ]);
  });

  it('a migration inicial cria e reverte as seis tabelas do M1', () => {
    const [initial] = readMigrations();
    for (const table of REQUIRED_TABLES) {
      expect(initial?.up).toMatch(new RegExp(`CREATE TABLE ${table} \\(`));
      expect(initial?.down).toContain(`DROP TABLE IF EXISTS ${table};`);
    }
  });

  it('o checksum ignora fim de linha: o mesmo arquivo com CRLF não vira "migration editada"', () => {
    const lf = readMigrations(tempDir({ '0001_x.up.sql': 'SELECT 1;\nSELECT 2;\n', '0001_x.down.sql': 'SELECT 0;' }));
    const crlf = readMigrations(tempDir({ '0001_x.up.sql': 'SELECT 1;\r\nSELECT 2;\r\n', '0001_x.down.sql': 'SELECT 0;' }));
    expect(crlf[0]?.checksum).toBe(lf[0]?.checksum);
  });

  it('o checksum ainda muda quando o conteúdo muda de verdade', () => {
    const a = readMigrations(tempDir({ '0001_x.up.sql': 'SELECT 1;', '0001_x.down.sql': 'SELECT 0;' }));
    const b = readMigrations(tempDir({ '0001_x.up.sql': 'SELECT 2;', '0001_x.down.sql': 'SELECT 0;' }));
    expect(a[0]?.checksum).not.toBe(b[0]?.checksum);
  });

  it('recusa migration sem arquivo de reversão', () => {
    const dir = tempDir({ '0001_x.up.sql': 'SELECT 1;' });
    expect(() => readMigrations(dir)).toThrow(/precisa dos dois arquivos/);
  });

  it('recusa nome fora do padrão', () => {
    const dir = tempDir({ 'cria_tabela.sql': 'SELECT 1;' });
    expect(() => readMigrations(dir)).toThrow(MigrationError);
  });
});
