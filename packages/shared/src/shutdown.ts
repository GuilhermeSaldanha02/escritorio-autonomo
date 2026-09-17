import { describeError, type Logger } from './logger.js';

export interface ShutdownStep {
  name: string;
  close: () => Promise<unknown>;
}

/** `clean`: tudo fechou · `with-errors`: alguma etapa falhou · `timed-out`: estourou o prazo. */
export type ShutdownOutcome = 'clean' | 'with-errors' | 'timed-out';

export interface GracefulShutdownOptions {
  logger: Logger;
  /** Executadas em ordem. A ordem importa: quem consome recursos fecha antes dos recursos. */
  steps: readonly ShutdownStep[];
  timeoutMs: number;
}

export type GracefulShutdown = (reason: string) => Promise<ShutdownOutcome>;

/**
 * Encerramento gracioso: roda as etapas em sequência, registra a falha de uma
 * sem pular as seguintes (um pool aberto não pode sobrar porque a fila falhou),
 * e desiste no prazo. Chamadas repetidas devolvem o mesmo encerramento.
 */
export function createGracefulShutdown({ logger, steps, timeoutMs }: GracefulShutdownOptions): GracefulShutdown {
  let running: Promise<ShutdownOutcome> | undefined;

  const runSteps = async (): Promise<ShutdownOutcome> => {
    let failed = false;
    for (const step of steps) {
      try {
        await step.close();
        logger.debug({ step: step.name }, 'etapa de encerramento concluída');
      } catch (error) {
        failed = true;
        logger.error({ step: step.name, err: describeError(error) }, 'falha em etapa de encerramento');
      }
    }
    return failed ? 'with-errors' : 'clean';
  };

  return (reason) => {
    if (running) return running;

    const startedAt = Date.now();
    logger.info({ reason, timeoutMs }, 'encerrando');
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<ShutdownOutcome>((resolve) => {
      timer = setTimeout(() => resolve('timed-out'), timeoutMs);
    });

    running = Promise.race([runSteps(), deadline]).then((outcome) => {
      clearTimeout(timer);
      const log = outcome === 'clean' ? logger.info.bind(logger) : logger.error.bind(logger);
      log({ outcome, durationMs: Date.now() - startedAt }, 'encerrado');
      return outcome;
    });
    return running;
  };
}

/** O que `process` oferece para sinais — permite testar com um EventEmitter. */
export interface SignalSource {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

/**
 * Primeiro SIGINT/SIGTERM: encerramento gracioso e saída 0 (ou 1 se não foi
 * limpo). Segundo sinal durante o encerramento: saída imediata com 1 — o
 * operador que insiste não pode ficar preso esperando.
 */
export function exitOnShutdownSignals(
  source: SignalSource,
  shutdown: GracefulShutdown,
  exit: (code: number) => void,
  logger: Logger,
): void {
  let received: string | undefined;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    source.on(signal, () => {
      if (received) {
        logger.warn({ signal, first: received }, 'segundo sinal durante o encerramento: saída imediata');
        exit(1);
        return;
      }
      received = signal;
      void shutdown(signal).then((outcome) => exit(outcome === 'clean' ? 0 : 1));
    });
  }
}
