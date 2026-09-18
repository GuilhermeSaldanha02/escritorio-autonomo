import type { Queryable } from '@escritorio/database';
import { EventStore } from '@escritorio/events';

export interface StopRecommendation {
  /** Componente que recomenda (ex.: `CIRCUIT_BREAKER`, `RECONCILIATION`). */
  source: string;
  /** Código curto e estável do motivo; entra na identidade da recomendação. */
  code: string;
  detail: string;
}

/**
 * Único jeito de um componente determinístico se manifestar sobre o Emergency Stop:
 * RECOMENDAR, gravando um evento para o fundador ver. Não engaja, não libera e não muda
 * nenhum estado (M6-PLANO.md, critério 9). A recomendação se repete no máximo uma vez por
 * hora e por (fonte, código), para um problema persistente não inundar o timeline.
 */
export async function recommendEmergencyStop(db: Queryable, recommendation: StopRecommendation, now: Date = new Date()): Promise<boolean> {
  const hourBucket = Math.floor(now.getTime() / 3_600_000);
  const { created } = await new EventStore(db).append({
    type: 'EMERGENCY_STOP_RECOMMENDED',
    payload: { source: recommendation.source, code: recommendation.code, detail: recommendation.detail },
    idempotencyKey: `stop-recommended:${recommendation.source}:${recommendation.code}:${hourBucket}`,
  });
  return created;
}
