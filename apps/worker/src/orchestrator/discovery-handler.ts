import type { Job } from 'bullmq';
import type { CircuitBreakerStore } from '@escritorio/autonomy';
import type { SourceConnector } from '@escritorio/cacador';
import { runDiscoveryCycle } from '@escritorio/cacador';
import type { Pool } from '@escritorio/database';
import { EventBus, type DiscoverOpportunitiesJobData, JOB_NAMES, QUEUE_NAMES } from '@escritorio/events';
import type { Governor } from '@escritorio/governor';
import type { Logger } from '@escritorio/shared';

export interface DiscoveryHandlerDeps {
  pool: Pool;
  bus: EventBus;
  governor: Governor;
  connector: SourceConnector;
  logger: Logger;
  /** M6: o resultado técnico da fonte alimenta o circuito dela. Ausente, nada é alimentado. */
  breakers?: CircuitBreakerStore;
}

/**
 * Processa `discover-opportunities`: roda um ciclo do Caçador
 * (SourceConnector → Normalizer → Deduplicator → Verifier → Promotion
 * Policy) e publica `OPPORTUNITY_FOUND` só para o que a Promotion Policy
 * liberou — o resto fica persistido em `opportunities`, disponível para
 * reavaliação futura, mas nunca chega ao Diretor sozinho (M4-PLANO.md).
 *
 * Falha da fonte (rate limit, indisponibilidade, schema drift) só loga e
 * encerra — nunca lança, porque isso é esperado da internet real, não um
 * erro do Worker.
 *
 * Idempotente por identidade: publica com `idempotencyKey =
 * opportunity:<id>:found`, então revisitar a mesma oportunidade já promovida
 * num ciclo seguinte (ex.: uma revisão que ainda promove) nunca duplica o
 * evento nem o job `decide-opportunity`.
 */
export function createDiscoveryHandler({ pool, bus, governor, connector, logger, breakers }: DiscoveryHandlerDeps) {
  return async function handleDiscoverOpportunities(job: Job<DiscoverOpportunitiesJobData>): Promise<void> {
    const { correlationId } = job.data;
    const result = await runDiscoveryCycle({ pool, connector });

    // O circuito da fonte é alimentado só por resultado TÉCNICO dela (indisponível, rate limit
    // esgotado, mudança de schema, payload grande demais), nunca por pausa ou espera.
    if (breakers) {
      await breakers.recordOutcome(
        { type: 'SOURCE', key: connector.source },
        result.sourceStatus === 'OK' ? 'SUCCESS' : 'FAILURE',
        new Date(),
        result.sourceStatus === 'OK' ? undefined : result.sourceStatus,
      );
    }

    if (result.sourceStatus !== 'OK') {
      logger.warn(
        { sourceStatus: result.sourceStatus, retryAfterMs: result.retryAfterMs, sourceError: result.sourceError },
        'ciclo de descoberta do Caçador não completou',
      );
      return;
    }

    const promoted = result.items.filter((item) => item.kind === 'PROMOTED');
    for (const item of promoted) {
      await bus.publish(
        {
          type: 'OPPORTUNITY_FOUND',
          payload: { source: connector.source },
          opportunityId: item.opportunityId,
          correlationId,
          idempotencyKey: `opportunity:${item.opportunityId}:found`,
        },
        {
          queue: QUEUE_NAMES.ORCHESTRATOR,
          jobName: JOB_NAMES.DECIDE_OPPORTUNITY,
          data: () => ({ opportunityId: item.opportunityId, correlationId }),
          attempts: governor.limits.MAX_TASK_RETRIES + 1,
          jobId: `decide-opportunity-${item.opportunityId}`,
        },
      );
    }

    logger.info({ totalCandidatos: result.items.length, promovidos: promoted.length }, 'ciclo de descoberta do Caçador concluído');
  };
}
