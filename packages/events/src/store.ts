import type { ZodType } from 'zod';
import type { Queryable } from '@escritorio/database';
import type { JsonObject } from '@escritorio/shared';
import { EVENT_PAYLOAD_SCHEMAS, eventTypeSchema, type EventPayload, type EventType } from './catalog.js';

export interface NewEvent<T extends EventType = EventType> {
  type: T;
  payload: EventPayload<T>;
  agentId?: string;
  taskId?: string;
  opportunityId?: string;
  correlationId?: string;
  /** Mesma chave = mesmo evento. Use em tudo que pode ser reexecutado por retry. */
  idempotencyKey?: string;
}

export interface StoredEvent {
  id: string;
  type: EventType;
  payload: JsonObject;
  agentId: string | null;
  taskId: string | null;
  opportunityId: string | null;
  correlationId: string | null;
  idempotencyKey: string | null;
  occurredAt: Date;
}

export interface AppendResult {
  event: StoredEvent;
  /** false quando a chave de idempotência já existia e nada foi inserido. */
  created: boolean;
}

export class EventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventValidationError';
  }
}

interface EventRow {
  id: string;
  type: EventType;
  payload: JsonObject;
  agent_id: string | null;
  task_id: string | null;
  opportunity_id: string | null;
  correlation_id: string | null;
  idempotency_key: string | null;
  occurred_at: Date;
}

const COLUMNS = 'id, type, payload, agent_id, task_id, opportunity_id, correlation_id, idempotency_key, occurred_at';

function toStoredEvent(row: EventRow): StoredEvent {
  return {
    id: row.id,
    type: row.type,
    payload: row.payload,
    agentId: row.agent_id,
    taskId: row.task_id,
    opportunityId: row.opportunity_id,
    correlationId: row.correlation_id,
    idempotencyKey: row.idempotency_key,
    occurredAt: row.occurred_at,
  };
}

function validate(event: NewEvent): void {
  if (!eventTypeSchema.safeParse(event.type).success) {
    throw new EventValidationError(`Tipo de evento fora do catálogo: ${String(event.type)}`);
  }
  const schemas: Partial<Record<EventType, ZodType>> = EVENT_PAYLOAD_SCHEMAS;
  const result = schemas[event.type]?.safeParse(event.payload);
  if (result && !result.success) {
    throw new EventValidationError(`Payload inválido para ${event.type}: ${result.error.message}`);
  }
}

/** Persistência append-only de eventos. Não há update nem delete — nem aqui, nem no banco. */
export class EventStore {
  constructor(private readonly db: Queryable) {}

  async append<T extends EventType>(event: NewEvent<T>): Promise<AppendResult> {
    validate(event as NewEvent);

    const { rows } = await this.db.query<EventRow>(
      `INSERT INTO events (type, payload, agent_id, task_id, opportunity_id, correlation_id, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        event.type,
        JSON.stringify(event.payload),
        event.agentId ?? null,
        event.taskId ?? null,
        event.opportunityId ?? null,
        event.correlationId ?? null,
        event.idempotencyKey ?? null,
      ],
    );
    const inserted = rows[0];
    if (inserted) return { event: toStoredEvent(inserted), created: true };

    const existing = await this.db.query<EventRow>(`SELECT ${COLUMNS} FROM events WHERE idempotency_key = $1`, [
      event.idempotencyKey,
    ]);
    const row = existing.rows[0];
    if (!row) {
      throw new Error(`Conflito de idempotência sem evento correspondente (${event.idempotencyKey})`);
    }
    if (row.type !== event.type) {
      throw new EventValidationError(
        `Chave de idempotência ${event.idempotencyKey} já pertence a um evento ${row.type}, não ${event.type}`,
      );
    }
    return { event: toStoredEvent(row), created: false };
  }

  async listByCorrelation(correlationId: string, limit = 100): Promise<StoredEvent[]> {
    const { rows } = await this.db.query<EventRow>(
      `SELECT ${COLUMNS} FROM events WHERE correlation_id = $1 ORDER BY occurred_at, id LIMIT $2`,
      [correlationId, limit],
    );
    return rows.map(toStoredEvent);
  }
}
