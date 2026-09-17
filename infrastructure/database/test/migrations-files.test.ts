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
    expect(migrations.map((m) => m.id)).toEqual(['0001_nucleo', '0002_outbox']);
  });

  it('a migration inicial cria e reverte as seis tabelas do M1', () => {
    const [initial] = readMigrations();
    for (const table of REQUIRED_TABLES) {
      expect(initial?.up).toMatch(new RegExp(`CREATE TABLE ${table} \\(`));
      expect(initial?.down).toContain(`DROP TABLE IF EXISTS ${table};`);
    }
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
