import { createPool } from '@escritorio/database';
import { Governor, loadConstitution } from '@escritorio/governor';
import { createLogger, describeError, loadConfig, loadEnvFile } from '@escritorio/shared';
import { runStopCommand } from './stop-command.js';

const out = (line: string): void => void process.stdout.write(`${line}\n`);
const err = (line: string): void => void process.stderr.write(`${line}\n`);

/** CLI do fundador: `stop status|engage|release`. Só o ambiente do próprio processo, nunca um agente, a chama. */
async function main(): Promise<number> {
  loadEnvFile();
  const config = loadConfig();
  const [command, ...args] = process.argv.slice(2);
  if (command !== 'stop') {
    err('Comandos: stop status | stop engage --reason "<motivo>" | stop release --reason "<motivo>"');
    return 1;
  }
  const governor = new Governor(loadConstitution(config.CONSTITUTION_PATH));
  const pool = createPool(config.DATABASE_URL, createLogger('cli', 'silent'), 'escritorio-cli');
  try {
    return await runStopCommand(pool, governor.limits.MAX_TASK_RETRIES + 1, args, { out, err });
  } finally {
    await pool.end();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    err(`Falha: ${describeError(error)}`);
    process.exit(1);
  },
);
