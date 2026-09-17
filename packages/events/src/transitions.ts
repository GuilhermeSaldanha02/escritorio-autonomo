import {
  type Actor,
  assertOpportunityTransition,
  assertTaskTransition,
  type OpportunityStatus,
  type TaskStatus,
} from '@escritorio/shared';
import { type Pool, type Queryable, withTransaction } from '@escritorio/database';
import { EventBus, type JobDispatch, type PublishResult } from './bus.js';
import type { EventType } from './catalog.js';
import type { NewEvent, StoredEvent } from './store.js';
import type { JsonObject } from '@escritorio/shared';

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

async function fetchEventByIdempotencyKey(tx: Queryable, idempotencyKey: string): Promise<StoredEvent> {
  const { rows } = await tx.query<EventRow>(
    `SELECT id, type, payload, agent_id, task_id, opportunity_id, correlation_id, idempotency_key, occurred_at
       FROM events WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  const row = rows[0];
  if (!row) throw new Error(`Evento com idempotency_key ${idempotencyKey} deveria existir e não foi encontrado`);
  return toStoredEvent(row);
}

/**
 * Transição de estado + evento + outbox como uma única operação atômica no
 * banco (revisão externa do M2: "não existe estado novo sem evento
 * correspondente nem evento anunciando uma transição que não ocorreu").
 *
 * Fecha o gap deixado conscientemente no passo 2 (`packages/shared/src/lifecycle.ts`):
 * lá a validação é só em memória; aqui o `UPDATE ... WHERE status = $from`
 * torna a transição uma garantia real do banco, não apenas de quem passa
 * pelo código certo.
 */

type EntityTable = 'opportunities' | 'tasks';

export class TransitionNotFoundError extends Error {
  constructor(
    readonly table: EntityTable,
    readonly id: string,
  ) {
    super(`${table} ${id} não existe`);
    this.name = 'TransitionNotFoundError';
  }
}

/** rowCount=0 e a linha não está nem em `from` nem já em `to` — alguém moveu para outro lugar, ou há um bug de leitura. */
export class TransitionConflictError extends Error {
  constructor(
    readonly table: EntityTable,
    readonly id: string,
    readonly expectedFrom: string,
    readonly actualStatus: string,
  ) {
    super(`${table} ${id}: esperava status ${expectedFrom}, encontrou ${actualStatus}`);
    this.name = 'TransitionConflictError';
  }
}

export type TransitionOutcome = 'APPLIED' | 'ALREADY_APPLIED';

export interface TransitionResult extends PublishResult {
  outcome: TransitionOutcome;
}

interface TransitionRequest<T extends EventType> {
  id: string;
  from: string;
  to: string;
  /**
   * Chave de reentrega: duas entregas do mesmo job com a mesma chave
   * resultam em ALREADY_APPLIED na segunda, nunca em duas transições nem
   * em erro. Deve identificar a transição lógica (ex.: `task:{id}:in-review`),
   * não a tentativa de entrega.
   */
  idempotencyKey: string;
  event: Omit<NewEvent<T>, 'idempotencyKey'>;
  dispatch?: JobDispatch;
}

async function updateStatusConditionally(
  tx: Queryable,
  table: EntityTable,
  id: string,
  from: string,
  to: string,
): Promise<boolean> {
  const { rowCount } = await tx.query(`UPDATE ${table} SET status = $1, updated_at = now() WHERE id = $2 AND status = $3`, [
    to,
    id,
    from,
  ]);
  return rowCount === 1;
}

async function currentStatus(tx: Queryable, table: EntityTable, id: string): Promise<string | undefined> {
  const { rows } = await tx.query<{ status: string }>(`SELECT status FROM ${table} WHERE id = $1`, [id]);
  return rows[0]?.status;
}

async function transitionEntityIn<T extends EventType>(
  tx: Queryable,
  table: EntityTable,
  request: TransitionRequest<T>,
): Promise<TransitionResult> {
  const { id, from, to, idempotencyKey } = request;
  const applied = await updateStatusConditionally(tx, table, id, from, to);

  if (!applied) {
    const status = await currentStatus(tx, table, id);
    if (status === undefined) throw new TransitionNotFoundError(table, id);
    if (status === to) {
      const existing = await tx.query(`SELECT 1 FROM events WHERE idempotency_key = $1`, [idempotencyKey]);
      if (existing.rows.length > 0) {
        // Mesma transição, entrega duplicada do job (BullMQ é at-least-once):
        // já foi aplicada por uma tentativa anterior — no-op seguro, não um erro.
        return { outcome: 'ALREADY_APPLIED', created: false, event: await fetchEventByIdempotencyKey(tx, idempotencyKey) };
      }
    }
    throw new TransitionConflictError(table, id, from, status);
  }

  const result = await EventBus.publishIn(tx, { ...request.event, idempotencyKey } as NewEvent<T>, request.dispatch);
  return { outcome: 'APPLIED', ...result };
}

export interface TransitionOpportunityRequest<T extends EventType> extends TransitionRequest<T> {
  from: OpportunityStatus;
  to: OpportunityStatus;
  actor: Actor;
}

export async function transitionOpportunity<T extends EventType>(
  pool: Pool,
  request: TransitionOpportunityRequest<T>,
): Promise<TransitionResult> {
  assertOpportunityTransition(request.from, request.to, request.actor);
  return withTransaction(pool, (tx) => transitionEntityIn(tx, 'opportunities', request));
}

export async function transitionOpportunityIn<T extends EventType>(
  tx: Queryable,
  request: TransitionOpportunityRequest<T>,
): Promise<TransitionResult> {
  assertOpportunityTransition(request.from, request.to, request.actor);
  return transitionEntityIn(tx, 'opportunities', request);
}

export interface TransitionTaskRequest<T extends EventType> extends TransitionRequest<T> {
  from: TaskStatus;
  to: TaskStatus;
}

export async function transitionTask<T extends EventType>(
  pool: Pool,
  request: TransitionTaskRequest<T>,
): Promise<TransitionResult> {
  assertTaskTransition(request.from, request.to);
  return withTransaction(pool, (tx) => transitionEntityIn(tx, 'tasks', request));
}

export async function transitionTaskIn<T extends EventType>(
  tx: Queryable,
  request: TransitionTaskRequest<T>,
): Promise<TransitionResult> {
  assertTaskTransition(request.from, request.to);
  return transitionEntityIn(tx, 'tasks', request);
}
