import type { Queue } from 'bullmq';
import type { EventType } from './catalog.js';
import type { AppendResult, EventStore, NewEvent, StoredEvent } from './store.js';

export interface JobDispatch {
  queue: Queue;
  jobName: string;
  /** Recebe o evento já persistido: o job carrega o id real do evento que o originou. */
  data: (event: StoredEvent) => Record<string, unknown>;
  /** Total de tentativas (1 + retries). Vem do Governor, nunca de um número solto. */
  attempts: number;
}

export interface PublishResult extends AppendResult {
  jobId?: string;
}

/**
 * Event Bus mínimo: persiste primeiro, enfileira depois. O job usa o id do
 * evento como jobId, então republicar o mesmo evento não cria job duplicado.
 *
 * Limitação conhecida do M1: se o Redis cair entre a persistência e o
 * enfileiramento, o evento fica gravado sem job. O Orquestrador (M2/M6) é quem
 * reconcilia; até lá o erro sobe para quem publicou.
 */
export class EventBus {
  constructor(private readonly store: EventStore) {}

  async publish<T extends EventType>(event: NewEvent<T>, dispatch?: JobDispatch): Promise<PublishResult> {
    const result = await this.store.append(event);
    if (!dispatch) return result;

    const job = await dispatch.queue.add(dispatch.jobName, dispatch.data(result.event), {
      jobId: result.event.id,
      attempts: dispatch.attempts,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: { count: 1_000 },
      removeOnFail: { count: 5_000 },
    });
    if (job.id === undefined) {
      throw new Error(`BullMQ não devolveu id para o job do evento ${result.event.id}`);
    }
    return { ...result, jobId: job.id };
  }
}
