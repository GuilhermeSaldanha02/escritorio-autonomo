import {
  AutonomyController,
  breakerPolicyFrom,
  CircuitBreakerStore,
  LifecycleService,
  RecoveryService,
  Scheduler,
  stopReaderFor,
} from '@escritorio/autonomy';
import type { Pool } from '@escritorio/database';
import type { Governor } from '@escritorio/governor';
import { describeError, type Logger } from '@escritorio/shared';
import { type createDockerClient, reapLeakedSandboxes } from '@escritorio/tools';
import { createScheduleActions } from './scheduler-actions.js';

export interface AutonomyRuntimeDeps {
  pool: Pool;
  governor: Governor;
  docker: ReturnType<typeof createDockerClient>;
  logger: Logger;
  /** Frequência com que o laço consulta o Scheduler. Cada agenda só roda quando SUA janela vira; isto só transporta o disparo. */
  tickIntervalMs?: number;
}

export interface AutonomyRuntime {
  scheduler: Scheduler;
  recovery: RecoveryService;
  lifecycle: LifecycleService;
  stop(): void;
}

/**
 * Liga a autonomia do M6 ao processo do worker. A identidade de cada execução agendada
 * é do Postgres (`scheduled_executions`): este laço é só transporte, então dois workers,
 * um restart ou um tick repetido nunca duplicam um efeito.
 *
 * Com `AUTONOMY_ENABLED=false` (o padrão), o laço roda mas nenhuma agenda executa: cada
 * janela só grava que foi negada. A varredura de recovery do BOOT roda sempre, porque
 * cuida de trabalho que já estava em andamento, e só o Emergency Stop a barra.
 */
export function startAutonomyRuntime({ pool, governor, docker, logger, tickIntervalMs = 60_000 }: AutonomyRuntimeDeps): AutonomyRuntime {
  const controller = new AutonomyController({
    governor,
    stop: stopReaderFor(pool),
    breakers: new CircuitBreakerStore(pool, breakerPolicyFrom(governor)),
  });
  const attempts = governor.limits.MAX_TASK_RETRIES + 1;
  const recovery = new RecoveryService({
    pool,
    governor,
    controller,
    attempts,
    sandboxes: { reap: (olderThanMs, now) => reapLeakedSandboxes(docker, olderThanMs, now, logger) },
  });
  const lifecycle = new LifecycleService({ pool, governor, controller, resumeAttempts: attempts });
  const scheduler = new Scheduler({ pool, governor, controller, actions: createScheduleActions({ pool, governor, recovery, lifecycle }) });

  recovery
    .sweep(new Date())
    .then((report) => logger.info({ report }, 'varredura de recovery no boot'))
    .catch((error: unknown) => logger.warn({ err: describeError(error) }, 'varredura de recovery no boot falhou'));

  const timer = setInterval(() => {
    scheduler
      .runDue(new Date())
      .then((results) => {
        const acted = results.filter((r) => r.outcome === 'DISPATCHED' || r.outcome === 'FAILED');
        if (acted.length > 0) logger.info({ ticks: acted }, 'agendas executadas');
      })
      .catch((error: unknown) => logger.warn({ err: describeError(error) }, 'tick do Scheduler falhou'));
  }, tickIntervalMs);
  timer.unref();

  return { scheduler, recovery, lifecycle, stop: () => clearInterval(timer) };
}
