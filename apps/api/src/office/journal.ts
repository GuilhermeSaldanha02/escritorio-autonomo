import type { Pool, PoolClient } from '@escritorio/database';
import { isDeepStrictEqual } from 'node:util';
import { ledgerBalanceCents } from '@escritorio/finance';
import { foldBreaker, readStopState, type CircuitEventType } from '@escritorio/autonomy';
import {
  CONTRACT_VERSION, decodeCursor, encodeCursor, officeEnvelopeSchema, officeStreamMessageSchema,
  type FinancialScopeSnapshot, type OfficeChanges, type OfficeEnvelope, type OfficeSnapshot,
  type OfficeStreamMessage,
} from '@escritorio/office-contract';
import { projectOfficeSnapshot, type OfficeProjectionInput, type SourceAgent, type SourcePause, type SourceTask } from './projection.js';
import type { OfficeSourceEvent } from './timeline.js';

interface HeadRow {
  epoch: string;
  revision: string;
  snapshot: OfficeSnapshot | null;
  observed_at: Date | null;
  min_replay_revision: string;
}

export interface OfficeConfiguration { autonomyEnabled: boolean; autoSpendEnabled: boolean }

const sections = ['agents', 'workstations', 'financial', 'governance', 'timeline'] as const;
const allowedEvents = new Set([
  'OPPORTUNITY_FOUND', 'OPPORTUNITY_VERIFYING', 'OPPORTUNITY_VERIFIED', 'OPPORTUNITY_EVALUATING', 'OPPORTUNITY_APPROVED', 'OPPORTUNITY_REJECTED',
  'TASK_CREATED', 'TASK_ASSIGNED', 'TASK_STARTED', 'TASK_WAITING_SLOT', 'TASK_COMPLETED', 'TASK_BLOCKED', 'AGENT_STATE_CHANGED', 'IMPLEMENTATION_READY',
  'REVIEW_STARTED', 'REVIEW_FAILED', 'REVIEW_PASSED', 'ACTION_BLOCKED', 'CIRCUIT_OPENED', 'CIRCUIT_HALF_OPEN', 'CIRCUIT_CLOSED',
  'EMERGENCY_STOP_ENGAGED', 'EMERGENCY_STOP_RELEASED', 'EMERGENCY_STOP_RECOMMENDED', 'EMERGENCY_QUIESCENCE_EXCEEDED',
  'WORK_PAUSED', 'WORK_RESUMED', 'AGENT_ACTIVATED', 'AGENT_WOKE', 'AGENT_SLEEP', 'RECOVERY_ACTION_TAKEN', 'RECONCILIATION_REPORTED',
]);

async function readFinancial(tx: PoolClient, scope: 'REAL' | 'SIMULATION'): Promise<FinancialScopeSnapshot | null> {
  try {
    const cashCents = await ledgerBalanceCents(tx, scope);
    const { rows } = await tx.query<{ reserve: string; operations: string; expansion: string }>(
      `SELECT COALESCE(SUM(amount_cents) FILTER (WHERE entry_type = 'RESERVE_ALLOCATION'), 0)::text AS reserve,
              COALESCE(SUM(amount_cents) FILTER (WHERE entry_type = 'OPERATIONS_ALLOCATION'), 0)::text AS operations,
              COALESCE(SUM(amount_cents) FILTER (WHERE entry_type = 'EXPANSION_ALLOCATION'), 0)::text AS expansion
         FROM financial_ledger WHERE ledger_scope = $1`, [scope],
    );
    const safe = (value: string): number => {
      const n = BigInt(value);
      if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(Number.MIN_SAFE_INTEGER)) throw new RangeError('Office financial overflow');
      return Number(n);
    };
    return { cashCents, reserveCents: safe(rows[0]?.reserve ?? '0'), operationsCents: safe(rows[0]?.operations ?? '0'), expansionCents: safe(rows[0]?.expansion ?? '0') };
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

async function readGovernance(tx: PoolClient, config: OfficeConfiguration): Promise<OfficeSnapshot['governance']> {
  const stop = await readStopState(tx);
  const { rows } = await tx.query<{ scope_type: 'SOURCE' | 'AGENT'; scope_key: string; event_type: CircuitEventType; occurred_at: Date }>(
    `SELECT scope_type, scope_key, event_type, occurred_at FROM circuit_breaker_events ORDER BY seq`,
  );
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.scope_type}:${row.scope_key}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const breakers = [...groups.values()].filter(group => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(group[0]!.scope_key)).map(group => ({
    scopeType: group[0]!.scope_type, scopeKey: group[0]!.scope_key,
    state: foldBreaker(group.map(row => ({ type: row.event_type, at: row.occurred_at }))).status,
  }));
  const circuitBreaker = breakers.some(b => b.state === 'OPEN') ? 'OPEN' : breakers.some(b => b.state === 'HALF_OPEN') ? 'HALF_OPEN' : 'CLOSED';
  return {
    autonomyEnabled: config.autonomyEnabled, autoSpendEnabled: config.autoSpendEnabled,
    emergencyStop: stop.status === 'UNVERIFIABLE' ? null : stop.status === 'ENGAGED',
    circuitBreaker, breakers, configurationSource: 'API',
  };
}

async function readDomain(tx: PoolClient, config: OfficeConfiguration, previous: OfficeSnapshot | null): Promise<{ input: OfficeProjectionInput; receipts: string[] }> {
  const observedAt = new Date().toISOString();
  const agents = (await tx.query<{ id: string; role: string; lifecycle_status: string; state: string }>(
    `SELECT id, role, lifecycle_status, state FROM agents ORDER BY id`,
  )).rows.map((row): SourceAgent => ({ id: row.id, role: row.role, lifecycleStatus: row.lifecycle_status, state: row.state }));
  const tasks = (await tx.query<{ id: string; status: string; assigned_agent_id: string | null; retry_count: number }>(
    `SELECT id, status, assigned_agent_id, retry_count FROM tasks WHERE status IN ('IN_PROGRESS', 'IN_REVIEW') ORDER BY id`,
  )).rows.map((row): SourceTask => ({ id: row.id, status: row.status, assignedAgentId: row.assigned_agent_id, retryCount: row.retry_count }));
  const pauses = (await tx.query<{ job_name: string; entity_id: string; resumed_at: Date | null }>(
    `SELECT job_name, entity_id, resumed_at FROM paused_work WHERE resumed_at IS NULL`,
  )).rows.map((row): SourcePause => ({ jobName: row.job_name, entityId: row.entity_id, resumedAt: row.resumed_at?.toISOString() ?? null }));
  const eventRows = (await tx.query<{
    id: string; type: string; occurred_at: Date; agent_id: string | null; task_id: string | null; opportunity_id: string | null; payload: Record<string, unknown>;
  }>(`SELECT e.id, e.type, e.occurred_at, e.agent_id, e.task_id, e.opportunity_id, e.payload
         FROM events e LEFT JOIN office_event_receipts r ON r.source_event_id = e.id
        WHERE r.source_event_id IS NULL ORDER BY e.occurred_at, e.id LIMIT 200`)).rows;
  const receipts = eventRows.map(row => row.id);
  const events: OfficeSourceEvent[] = eventRows.filter(row => allowedEvents.has(row.type)).map(row => ({
    id: row.id, type: row.type, occurredAt: row.occurred_at.toISOString(),
    agentId: row.agent_id ?? (typeof row.payload.agentId === 'string' ? row.payload.agentId : null),
    taskId: row.task_id ?? (typeof row.payload.taskId === 'string' ? row.payload.taskId : null),
    opportunityId: row.opportunity_id,
    newState: typeof row.payload.newState === 'string' ? row.payload.newState : undefined,
    applied: row.payload.applied === true,
  }));
  // O histórico já sanitizado conserva a janela, sem reabrir payloads anteriores.
  const priorTimeline: OfficeSourceEvent[] = previous?.timeline.map(row => ({ id: row.id, type: row.type, occurredAt: row.occurredAt, agentId: row.agentId })) ?? [];
  // A evidência do revisor vem de eventos fonte vinculados à tarefa ativa, não da atribuição ao desenvolvedor.
  const reviewRows = (await tx.query<{ id: string; type: string; occurred_at: Date; agent_id: string | null; task_id: string | null; payload: Record<string, unknown> }>(
    `SELECT id, type, occurred_at, agent_id, task_id, payload FROM events
      WHERE type IN ('REVIEW_STARTED', 'AGENT_STATE_CHANGED')
        AND (task_id IN (SELECT id FROM tasks WHERE status = 'IN_REVIEW')
          OR payload->>'taskId' IN (SELECT id::text FROM tasks WHERE status = 'IN_REVIEW'))`,
  )).rows;
  const reviewEvidence: OfficeSourceEvent[] = reviewRows.map(row => ({
    id: row.id, type: row.type, occurredAt: row.occurred_at.toISOString(),
    agentId: row.agent_id ?? (typeof row.payload.agentId === 'string' ? row.payload.agentId : null),
    taskId: row.task_id ?? (typeof row.payload.taskId === 'string' ? row.payload.taskId : null),
    newState: typeof row.payload.newState === 'string' ? row.payload.newState : undefined,
    applied: row.payload.applied === true,
  }));
  const mergedTimeline = new Map([...priorTimeline, ...events].map(event => [event.id, event]));
  return {
    receipts,
    input: {
      observedAt, agents, tasks, pauses, events: [...mergedTimeline.values()], reviewEvidence,
      financial: { real: await readFinancial(tx, 'REAL'), simulation: await readFinancial(tx, 'SIMULATION') },
      governance: await readGovernance(tx, config),
    },
  };
}

function changedSections(before: OfficeSnapshot | null, next: OfficeSnapshot): OfficeChanges {
  const changes: Record<string, unknown> = {};
  for (const section of sections) if (!before || !isDeepStrictEqual(before[section], next[section])) changes[section] = next[section];
  return changes as OfficeChanges;
}

async function oneRefresh(pool: Pool, config: OfficeConfiguration): Promise<OfficeEnvelope> {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const { rows } = await tx.query<HeadRow>(`SELECT epoch, revision, snapshot, observed_at, min_replay_revision FROM office_projection_head WHERE singleton = true FOR UPDATE`);
    const head = rows[0];
    if (!head) throw new Error('Office projection migration missing');
    const { input, receipts } = await readDomain(tx, config, head.snapshot);
    const projected = projectOfficeSnapshot(input);
    const sectionChanges = changedSections(head.snapshot, projected);
    const advance = Object.keys(sectionChanges).length > 0;
    const snapshot = advance ? projected : head.snapshot ?? projected;
    const changes: OfficeChanges = advance ? { ...sectionChanges, generatedAt: snapshot.generatedAt, metadata: snapshot.metadata } : sectionChanges;
    const revision = advance ? (BigInt(head.revision) + 1n).toString() : head.revision;
    const streamCursor = encodeCursor({ epoch: head.epoch, revision });
    if (advance) {
      const baseCursor = encodeCursor({ epoch: head.epoch, revision: head.revision });
      const payload = officeStreamMessageSchema.parse({ type: 'OFFICE_UPDATED', baseCursor, cursor: streamCursor, revision, changes });
      await tx.query(`INSERT INTO office_stream_entries (epoch, revision, base_revision, payload) VALUES ($1, $2, $3, $4::jsonb)`,
        [head.epoch, revision, head.revision, JSON.stringify(payload)]);
    }
    for (const id of receipts) await tx.query(`INSERT INTO office_event_receipts (source_event_id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
    await tx.query(`UPDATE office_projection_head SET revision = $1, snapshot = $2::jsonb, observed_at = $3, contract_version = $4 WHERE singleton = true`,
      [revision, JSON.stringify(snapshot), input.observedAt, CONTRACT_VERSION]);
    await pruneJournal(tx, head.epoch, revision, head.min_replay_revision);
    await tx.query('COMMIT');
    return officeEnvelopeSchema.parse({ contractVersion: CONTRACT_VERSION, streamCursor, revision, snapshot });
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    tx.release();
  }
}

async function pruneJournal(tx: PoolClient, epoch: string, revision: string, priorMinimum: string): Promise<void> {
  const { rows } = await tx.query<{ oldest_retained: string | null }>(
    `SELECT MIN(revision)::text AS oldest_retained FROM office_stream_entries
      WHERE epoch = $1 AND created_at >= clock_timestamp() - INTERVAL '24 hours'`, [epoch],
  );
  const ageCutoff = rows[0]?.oldest_retained ? BigInt(rows[0].oldest_retained) - 1n : BigInt(revision);
  const countCutoff = BigInt(revision) > 10_000n ? BigInt(revision) - 10_000n : 0n;
  const cutoff = [BigInt(priorMinimum), ageCutoff, countCutoff].reduce((max, value) => value > max ? value : max, 0n);
  if (cutoff === BigInt(priorMinimum)) return;
  await tx.query(`DELETE FROM office_stream_entries WHERE epoch = $1 AND revision <= $2`, [epoch, cutoff.toString()]);
  await tx.query(`UPDATE office_projection_head SET min_replay_revision = $1 WHERE singleton = true`, [cutoff.toString()]);
}

export async function refreshOfficeProjection(pool: Pool, config: OfficeConfiguration): Promise<OfficeEnvelope> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await oneRefresh(pool, config); }
    catch (error) {
      if ((error as { code?: string }).code !== '40001' || attempt === 2) throw error;
    }
  }
  throw new Error('Office projection retry exhausted');
}

export async function readOfficeEnvelope(pool: Pool): Promise<OfficeEnvelope | null> {
  const { rows } = await pool.query<HeadRow>(`SELECT epoch, revision, snapshot, observed_at, min_replay_revision FROM office_projection_head WHERE singleton = true`);
  const head = rows[0];
  if (!head?.snapshot) return null;
  return officeEnvelopeSchema.parse({ contractVersion: CONTRACT_VERSION, streamCursor: encodeCursor({ epoch: head.epoch, revision: head.revision }), revision: head.revision, snapshot: head.snapshot });
}

/** Frescor do tick separado do snapshot versionado; heartbeat não altera cursor nem payload. */
export async function readOfficeObservedAt(pool: Pool): Promise<string | null> {
  const { rows } = await pool.query<Pick<HeadRow, 'observed_at'>>(`SELECT observed_at FROM office_projection_head WHERE singleton = true`);
  return rows[0]?.observed_at?.toISOString() ?? null;
}

export type ReplayResult =
  | { status: 'OK'; throughCursor: string; updates: Extract<OfficeStreamMessage, { type: 'OFFICE_UPDATED' }>[] }
  | { status: 'RESYNC'; reason: 'INVALID_CURSOR' | 'EPOCH_MISMATCH' | 'CURSOR_EXPIRED' | 'CURSOR_AHEAD' | 'REVISION_GAP' | 'UNAVAILABLE' };

/** Captura um head e lê uma faixa limitada. O tail repete esta operação desde o último cursor aplicado. */
export async function readOfficeReplay(pool: Pool, afterCursor: string, limit = 200): Promise<ReplayResult> {
  let after: ReturnType<typeof decodeCursor>;
  try { after = decodeCursor(afterCursor); }
  catch { return { status: 'RESYNC', reason: 'INVALID_CURSOR' }; }
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RangeError('Invalid replay limit');
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const resync = async (reason: Extract<ReplayResult, { status: 'RESYNC' }>['reason']): Promise<ReplayResult> => {
      await tx.query('ROLLBACK');
      return { status: 'RESYNC', reason };
    };
    const { rows } = await tx.query<HeadRow>(`SELECT epoch, revision, snapshot, observed_at, min_replay_revision FROM office_projection_head WHERE singleton = true`);
    const head = rows[0];
    if (!head?.snapshot) return resync('UNAVAILABLE');
    if (after.epoch !== head.epoch) return resync('EPOCH_MISMATCH');
    if (BigInt(after.revision) > BigInt(head.revision)) return resync('CURSOR_AHEAD');
    if (BigInt(after.revision) < BigInt(head.min_replay_revision)) return resync('CURSOR_EXPIRED');
    const entries = (await tx.query<{ payload: unknown }>(
      `SELECT payload FROM office_stream_entries WHERE epoch = $1 AND revision > $2 AND revision <= $3 ORDER BY revision LIMIT $4`,
      [head.epoch, after.revision, head.revision, limit],
    )).rows.map(row => officeStreamMessageSchema.parse(row.payload));
    let cursor = afterCursor;
    for (const entry of entries) {
      if (entry.type !== 'OFFICE_UPDATED' || entry.baseCursor !== cursor) return resync('REVISION_GAP');
      cursor = entry.cursor;
    }
    if (entries.length === 0 && BigInt(after.revision) < BigInt(head.revision)) return resync('REVISION_GAP');
    await tx.query('COMMIT');
    return { status: 'OK', throughCursor: encodeCursor({ epoch: head.epoch, revision: head.revision }), updates: entries as Extract<OfficeStreamMessage, { type: 'OFFICE_UPDATED' }>[] };
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    tx.release();
  }
}
