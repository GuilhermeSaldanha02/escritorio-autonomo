import { type Pool, type Queryable, withTransaction } from '@escritorio/database';
import type { EventType } from './catalog.js';
import { enqueueInOutbox } from './outbox.js';
import { type AppendResult, EventStore, type NewEvent, type StoredEvent } from './store.js';

export interface JobDispatch {
  queue: string;
  jobName: string;
  /** Recebe o evento já persistido: o job carrega o id real do evento que o originou. */
  data: (event: StoredEvent) => Record<string, unknown>;
  /** Total de tentativas (1 + retries). Vem do Governor, nunca de um número solto. */
  attempts: number;
  /** Padrão: o id do evento. Mesmo jobId = mesmo job no BullMQ. */
  jobId?: string;
}

export interface PublishResult extends AppendResult {
  jobId?: string;
}

/**
 * Event Bus com Transactional Outbox: o evento e o pedido de job são gravados
 * na mesma transação. Quem publica no BullMQ é o `OutboxDispatcher` — se o
 * Redis estiver fora, o job espera no PostgreSQL em vez de se perder.
 */
export class EventBus {
  constructor(private readonly pool: Pool) {}

  async publish<T extends EventType>(event: NewEvent<T>, dispatch?: JobDispatch): Promise<PublishResult> {
    return withTransaction(this.pool, (tx) => EventBus.publishIn(tx, event, dispatch));
  }

  /** Publica dentro de uma transação existente — o Orquestrador junta transição de estado, evento e próximo job. */
  static async publishIn<T extends EventType>(
    tx: Queryable,
    event: NewEvent<T>,
    dispatch?: JobDispatch,
  ): Promise<PublishResult> {
    const result = await new EventStore(tx).append(event);
    if (!dispatch) return result;

    const jobId = dispatch.jobId ?? result.event.id;
    await enqueueInOutbox(tx, {
      eventId: result.event.id,
      queue: dispatch.queue,
      jobName: dispatch.jobName,
      jobId,
      payload: dispatch.data(result.event),
      jobAttempts: dispatch.attempts,
    });
    return { ...result, jobId };
  }
}
