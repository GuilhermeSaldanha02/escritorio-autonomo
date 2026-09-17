import { createLogger, describeError, loadConfig, loadEnvFile } from '@escritorio/shared';
import { migrateDown, migrateUp, migrationStatus } from './migrator.js';
import { createPool } from './pool.js';
import { seedInitialAgents } from './seed.js';

const USAGE = 'uso: cli <migrate | rollback [passos] | seed | status>';

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  const logger = createLogger('database-cli', config.LOG_LEVEL);
  const [command, argument] = process.argv.slice(2);
  const pool = createPool(config.DATABASE_URL, logger, 'escritorio-database-cli');

  try {
    switch (command) {
      case 'migrate': {
        const applied = await migrateUp(pool);
        logger.info({ applied }, applied.length ? 'migrations aplicadas' : 'nenhuma migration pendente');
        break;
      }
      case 'rollback': {
        const reverted = await migrateDown(pool, argument === undefined ? 1 : Number(argument));
        logger.info({ reverted }, reverted.length ? 'migrations revertidas' : 'nenhuma migration para reverter');
        break;
      }
      case 'seed': {
        const inserted = await seedInitialAgents(pool);
        logger.info({ inserted }, inserted.length ? 'agentes iniciais criados' : 'agentes iniciais já existiam');
        break;
      }
      case 'status': {
        logger.info(await migrationStatus(pool), 'estado das migrations');
        break;
      }
      default:
        throw new Error(USAGE);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const cause = error instanceof Error && error.cause !== undefined ? describeError(error.cause) : undefined;
  createLogger('database-cli').fatal({ err: describeError(error), cause }, 'falha');
  process.exitCode = 1;
});
