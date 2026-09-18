import { EmergencyStopService, releaseAndResume, type StopState } from '@escritorio/autonomy';
import type { Pool } from '@escritorio/database';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const USAGE = `Uso:
  stop status
  stop engage  --reason "<motivo>"
  stop release --reason "<motivo>"`;

function describeState(state: StopState): string {
  switch (state.status) {
    case 'CLEAR':
      return 'Emergency Stop: LIBERADO';
    case 'ENGAGED':
      return `Emergency Stop: ACIONADO desde ${state.since.toISOString()} por ${state.actor} (${state.reason})`;
    case 'UNVERIFIABLE':
      return `Emergency Stop: NÃO VERIFICÁVEL, tratado como acionado (${state.error})`;
  }
}

function readReason(args: readonly string[]): string | undefined {
  const at = args.indexOf('--reason');
  return at >= 0 ? args[at + 1] : undefined;
}

/**
 * Porta de linha de comando do fundador para o Emergency Stop. Só traduz argumentos para o
 * `EmergencyStopService`; devolve o código de saída (0 ok, 1 erro de uso ou de execução).
 */
export async function runStopCommand(pool: Pool, attempts: number, args: readonly string[], io: CliIo): Promise<number> {
  const [action, ...rest] = args;
  const service = new EmergencyStopService(pool);

  if (action === 'status') {
    const state = await service.state();
    io.out(describeState(state));
    return state.status === 'UNVERIFIABLE' ? 1 : 0;
  }

  if (action === 'engage' || action === 'release') {
    const reason = readReason(rest);
    if (!reason?.trim()) {
      io.err(`O motivo é obrigatório.\n${USAGE}`);
      return 1;
    }
    if (action === 'engage') {
      io.out(`Emergency Stop: ${await service.engage('FOUNDER_CLI', reason)}`);
      return 0;
    }
    const { transition, resumed } = await releaseAndResume(pool, 'FOUNDER_CLI', reason, attempts);
    io.out(`Emergency Stop: ${transition}; trabalho retomado: ${resumed}`);
    return 0;
  }

  io.err(USAGE);
  return 1;
}
