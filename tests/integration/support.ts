import { createPool, migrateDown, migrateUp, migrationStatus, type Pool } from '@escritorio/database';
import { createLogger, loadEnvFile, type Logger } from '@escritorio/shared';

loadEnvFile();

export const logger: Logger = createLogger('integration-test', process.env.TEST_LOG_LEVEL ?? 'silent');

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} não definido. Copie .env.example para .env e rode \`pnpm services:up\`.`);
  }
  return value;
}

export function testDatabaseUrl(): string {
  const url = requireEnv('TEST_DATABASE_URL');
  // Trava de segurança: os testes revertem migrations, então nunca rodam no banco de desenvolvimento.
  if (!new URL(url).pathname.endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL precisa apontar para um banco cujo nome termina em _test');
  }
  return url;
}

export function testRedisUrl(): string {
  return requireEnv('TEST_REDIS_URL');
}

/** Prefixo exclusivo por execução: filas de testes diferentes nunca se misturam. */
export function uniqueQueuePrefix(): string {
  return `escritorio-test-${crypto.randomUUID().slice(0, 8)}`;
}

export function createTestPool(): Pool {
  return createPool(testDatabaseUrl(), logger, 'escritorio-integration-test');
}

/** Reverte tudo e reaplica: todo arquivo de teste começa de um banco limpo e prova a reversibilidade. */
export async function resetDatabase(pool: Pool): Promise<void> {
  const { applied } = await migrationStatus(pool);
  if (applied.length > 0) await migrateDown(pool, applied.length);
  await migrateUp(pool);
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  { timeoutMs = 15_000, intervalMs = 100, label = 'condição' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Tempo esgotado (${timeoutMs} ms) esperando ${label}`);
}
