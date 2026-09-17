import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from './pool.js';

/** infrastructure/database/{src,dist} → ../migrations */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

const FILE_PATTERN = /^(\d{4}_[a-z0-9_]+)\.(up|down)\.sql$/;
/** Chave arbitrária e fixa: dois processos nunca migram ao mesmo tempo. */
const ADVISORY_LOCK_KEY = 7_310_001;

export interface Migration {
  id: string;
  up: string;
  down: string;
  checksum: string;
}

export class MigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

/** Lê pares `NNNN_nome.up.sql` / `NNNN_nome.down.sql`. Migration sem reversão é erro. */
export function readMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const halves = new Map<string, { up?: string; down?: string }>();

  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.sql')) continue;
    const match = FILE_PATTERN.exec(file);
    if (!match) {
      throw new MigrationError(`Nome de migration inválido: ${file} (esperado NNNN_nome.up.sql / .down.sql)`);
    }
    const [, id, direction] = match as unknown as [string, string, 'up' | 'down'];
    const entry = halves.get(id) ?? {};
    entry[direction] = readFileSync(join(dir, file), 'utf8');
    halves.set(id, entry);
  }

  return [...halves.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, { up, down }]) => {
      if (up === undefined || down === undefined) {
        throw new MigrationError(`Migration ${id} precisa dos dois arquivos: .up.sql e .down.sql`);
      }
      return { id, up, down, checksum: createHash('sha256').update(up).digest('hex') };
    });
}

interface AppliedRow {
  id: string;
  checksum: string;
}

async function withLock<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id         text PRIMARY KEY,
          checksum   text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )`);
      return await work(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

async function readApplied(client: PoolClient, migrations: Migration[]): Promise<AppliedRow[]> {
  const { rows } = await client.query<AppliedRow>('SELECT id, checksum FROM schema_migrations ORDER BY id');
  const known = new Map(migrations.map((migration) => [migration.id, migration]));
  for (const row of rows) {
    const file = known.get(row.id);
    if (!file) {
      throw new MigrationError(`Migration ${row.id} está aplicada no banco mas não existe no repositório`);
    }
    if (file.checksum !== row.checksum) {
      throw new MigrationError(
        `Migration ${row.id} foi editada depois de aplicada. Crie uma migration nova em vez de alterar a antiga.`,
      );
    }
  }
  return rows;
}

async function inTransaction(client: PoolClient, label: string, work: () => Promise<void>): Promise<void> {
  await client.query('BEGIN');
  try {
    await work();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw new MigrationError(`Falha em ${label}; transação revertida`, { cause: error });
  }
}

/** Aplica, em ordem e cada uma em sua transação, as migrations pendentes. */
export async function migrateUp(pool: Pool, migrations: Migration[] = readMigrations()): Promise<string[]> {
  return withLock(pool, async (client) => {
    const applied = new Set((await readApplied(client, migrations)).map((row) => row.id));
    const executed: string[] = [];
    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      await inTransaction(client, `${migration.id} (up)`, async () => {
        await client.query(migration.up);
        await client.query('INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)', [
          migration.id,
          migration.checksum,
        ]);
      });
      executed.push(migration.id);
    }
    return executed;
  });
}

/** Reverte as últimas `steps` migrations aplicadas, da mais nova para a mais antiga. */
export async function migrateDown(
  pool: Pool,
  steps = 1,
  migrations: Migration[] = readMigrations(),
): Promise<string[]> {
  if (!Number.isInteger(steps) || steps < 1) {
    throw new MigrationError(`Quantidade de passos inválida: ${steps}`);
  }
  return withLock(pool, async (client) => {
    const applied = await readApplied(client, migrations);
    const byId = new Map(migrations.map((migration) => [migration.id, migration]));
    const reverted: string[] = [];
    for (const row of applied.reverse().slice(0, steps)) {
      const migration = byId.get(row.id);
      if (!migration) throw new MigrationError(`Migration ${row.id} não encontrada`);
      await inTransaction(client, `${migration.id} (down)`, async () => {
        await client.query(migration.down);
        await client.query('DELETE FROM schema_migrations WHERE id = $1', [migration.id]);
      });
      reverted.push(migration.id);
    }
    return reverted;
  });
}

export async function migrationStatus(
  pool: Pool,
  migrations: Migration[] = readMigrations(),
): Promise<{ applied: string[]; pending: string[] }> {
  return withLock(pool, async (client) => {
    const applied = new Set((await readApplied(client, migrations)).map((row) => row.id));
    return {
      applied: migrations.filter((m) => applied.has(m.id)).map((m) => m.id),
      pending: migrations.filter((m) => !applied.has(m.id)).map((m) => m.id),
    };
  });
}
