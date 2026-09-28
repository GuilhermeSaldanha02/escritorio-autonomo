import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeCursor } from '@escritorio/office-contract';
import { createPool, migrateDown, migrateUp, migrationStatus, seedInitialAgents, type Pool } from '@escritorio/database';
import { createLogger } from '@escritorio/shared';
import { refreshOfficeProjection, readOfficeEnvelope, readOfficeObservedAt, readOfficeReplay } from '../../apps/api/src/office/journal.js';

function disposableUrl(): string {
  const value = process.env.TEST_DATABASE_URL;
  if (!value || new URL(value).pathname !== '/office_m7_test') throw new Error('Office integration tests require the isolated office_m7_test database');
  return value;
}

async function removeSyntheticOverflow(db: Pool, id: string): Promise<void> {
  // O reset do suite volta pela 0010 (numeric(14,2)); este valor sintético
  // precisa sair do banco descartável antes do downgrade. Nunca no domínio do owner.
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');
    await tx.query('ALTER TABLE financial_ledger DISABLE TRIGGER financial_ledger_append_only');
    await tx.query(`DELETE FROM financial_ledger WHERE id = $1`, [id]);
    await tx.query('ALTER TABLE financial_ledger ENABLE TRIGGER financial_ledger_append_only');
    await tx.query('COMMIT');
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally { tx.release(); }
}

let db: Pool;
beforeAll(async () => {
  db = createPool(disposableUrl(), createLogger('office-projection-test', 'silent'), 'office-projection-test');
  const status = await migrationStatus(db);
  if (status.applied.length) await migrateDown(db, status.applied.length);
  await migrateUp(db);
});
afterAll(async () => { await db?.end(); });

describe('journal persistido M7', () => {
  it('bootstrap consistente e reconciliação de agente sem evento', async () => {
    await seedInitialAgents(db);
    const first = await refreshOfficeProjection(db, { autonomyEnabled: false, autoSpendEnabled: false });
    const envelope = await readOfficeEnvelope(db);
    expect(envelope).not.toBeNull();
    expect(envelope?.streamCursor).toBe(first.streamCursor);
    expect(envelope?.snapshot.agents).toHaveLength(4);
    await db.query(`UPDATE agents SET state = 'CODING' WHERE id = 'DESENVOLVEDOR-001'`);
    const second = await refreshOfficeProjection(db, { autonomyEnabled: false, autoSpendEnabled: false });
    expect(BigInt(second.revision)).toBe(BigInt(first.revision) + 1n);
    expect((await readOfficeEnvelope(db))?.snapshot.agents.find(a => a.id === 'DESENVOLVEDOR-001')?.state).toBe('CODING');
  });
  it('I06: ticks sem alteração preservam o snapshot inteiro para o mesmo cursor', async () => {
    const before = await refreshOfficeProjection(db, { autonomyEnabled: false, autoSpendEnabled: false });
    await new Promise(resolve => setTimeout(resolve, 10));
    const after = await refreshOfficeProjection(db, { autonomyEnabled: false, autoSpendEnabled: false });
    expect(after.streamCursor).toBe(before.streamCursor);
    expect(after.snapshot).toEqual(before.snapshot);
    expect((await readOfficeEnvelope(db))?.snapshot).toEqual(before.snapshot);
    expect(Date.parse((await readOfficeObservedAt(db))!)).toBeGreaterThan(Date.parse(before.snapshot.metadata.observedAt!));
  });
  it('I06: replacement do journal reconstrói o snapshot da nova revisão, inclusive datas', async () => {
    await seedInitialAgents(db);
    const before = await refreshOfficeProjection(db, { autonomyEnabled: false, autoSpendEnabled: false });
    await db.query(`UPDATE agents SET state = 'TESTING' WHERE id = 'DESENVOLVEDOR-001'`);
    const after = await refreshOfficeProjection(db, { autonomyEnabled: false, autoSpendEnabled: false });
    const replay = await readOfficeReplay(db, before.streamCursor);
    expect(replay.status).toBe('OK');
    if (replay.status !== 'OK') throw new Error('Replay indisponível');
    const update = replay.updates.at(-1);
    expect(update?.cursor).toBe(after.streamCursor);
    expect(update?.changes).toMatchObject({ generatedAt: after.snapshot.generatedAt, metadata: after.snapshot.metadata });
    expect({ ...before.snapshot, ...update?.changes }).toEqual(after.snapshot);
  });
  it('ledger separa caixa de alocações, REAL de SIMULATION', async () => {
    const opportunity = (await db.query<{ id: string }>(
      `INSERT INTO opportunities (source, source_url, title) VALUES ('m7-test', 'https://example.invalid/office', 'canary') RETURNING id`,
    )).rows[0]!.id;
    const add = async (entry: string, amount: number, scope: string) => db.query(
      `INSERT INTO financial_ledger (entry_type, amount_cents, ledger_scope, description, opportunity_id, external_reference, idempotency_key)
       VALUES ($1, $2, $3, 'm7 test', $4, 'm7-test', $5)`, [entry, amount, scope, opportunity, crypto.randomUUID()],
    );
    await add('REVENUE', 10_000, 'SIMULATION');
    await add('RESERVE_ALLOCATION', 5_000, 'SIMULATION');
    await add('OPERATIONS_ALLOCATION', 3_000, 'SIMULATION');
    await add('EXPANSION_ALLOCATION', 2_000, 'SIMULATION');
    let snapshot = (await refreshOfficeProjection(db, { autonomyEnabled: false, autoSpendEnabled: false })).snapshot;
    expect(snapshot.financial.simulation).toMatchObject({ cashCents: 10_000, reserveCents: 5_000, operationsCents: 3_000, expansionCents: 2_000 });
    expect(snapshot.financial.real?.cashCents).toBe(0);
    await add('OPERATING_COST', 1_000, 'SIMULATION');
    await add('FOUNDER_SUBSIDY', 500, 'SIMULATION');
    snapshot = (await refreshOfficeProjection(db, { autonomyEnabled: false, autoSpendEnabled: false })).snapshot;
    expect(snapshot.financial.simulation?.cashCents).toBe(9_500);
    await add('OPERATING_COST', 200, 'REAL');
    expect((await refreshOfficeProjection(db, { autonomyEnabled: false, autoSpendEnabled: false })).snapshot.financial.real?.cashCents).toBe(-200);
  });
  it('commit tardio não some, replay mantém ordem e payload externo não vaza', async () => {
    const a = await db.connect();
    try {
      await a.query('BEGIN');
      const late = (await a.query<{ id: string }>(
        `INSERT INTO events (type, payload) VALUES ('TASK_CREATED', '{"text":"SECRET_CANARY"}'::jsonb) RETURNING id`,
      )).rows[0]!.id;
      const early = (await db.query<{ id: string }>(
        `INSERT INTO events (type, payload) VALUES ('TASK_CREATED', '{"text":"SECRET_CANARY"}'::jsonb) RETURNING id`,
      )).rows[0]!.id;
      const before = await refreshOfficeProjection(db, { autonomyEnabled: false, autoSpendEnabled: false });
      expect(before.snapshot.timeline.some(event => event.id === early)).toBe(true);
      expect(before.snapshot.timeline.some(event => event.id === late)).toBe(false);
      await a.query('COMMIT');
      const after = await refreshOfficeProjection(db, { autonomyEnabled: false, autoSpendEnabled: false });
      expect(after.snapshot.timeline.map(event => event.id)).toEqual(expect.arrayContaining([early, late]));
      expect(JSON.stringify(after)).not.toContain('SECRET_CANARY');
      const replay = await readOfficeReplay(db, before.streamCursor);
      expect(replay.status).toBe('OK');
      if (replay.status === 'OK') expect(replay.updates.at(-1)?.cursor).toBe(after.streamCursor);
      const receiptCount = await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM office_event_receipts WHERE source_event_id = $1`, [late]);
      expect(receiptCount.rows[0]?.count).toBe('1');
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      a.release();
    }
  });
  it('governança é leitura e serialização rejeita cursor futuro', async () => {
    await db.query(`INSERT INTO emergency_stop_events (kind, actor, reason) VALUES ('ENGAGED', 'FOUNDER_CLI', 'm7 test')`);
    await db.query(`INSERT INTO circuit_breaker_events (scope_type, scope_key, event_type) VALUES ('AGENT', 'REVISOR-001', 'OPENED')`);
    const before = await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM circuit_breaker_events`);
    const envelope = await refreshOfficeProjection(db, { autonomyEnabled: false, autoSpendEnabled: false });
    expect(envelope.snapshot.governance).toMatchObject({ emergencyStop: true, circuitBreaker: 'OPEN', autoSpendEnabled: false });
    expect((await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM circuit_breaker_events`)).rows[0]?.count).toBe(before.rows[0]?.count);
    const future = envelope.streamCursor.replace(/\.\d+$/, `.${BigInt(envelope.revision) + 1n}`);
    expect(await readOfficeReplay(db, future)).toMatchObject({ status: 'RESYNC', reason: 'CURSOR_AHEAD' });
  });
  it('duas projeções concorrentes não duplicam a revisão de um evento', async () => {
    const id = (await db.query<{ id: string }>(`INSERT INTO events (type) VALUES ('TASK_COMPLETED') RETURNING id`)).rows[0]!.id;
    const [a, b] = await Promise.all([
      refreshOfficeProjection(db, { autonomyEnabled: false, autoSpendEnabled: false }),
      refreshOfficeProjection(db, { autonomyEnabled: false, autoSpendEnabled: false }),
    ]);
    expect(a.streamCursor).toBe(b.streamCursor);
    const count = await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM office_event_receipts WHERE source_event_id = $1`, [id]);
    expect(count.rows[0]?.count).toBe('1');
    const journal = await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM office_stream_entries WHERE revision = $1`, [a.revision]);
    expect(journal.rows[0]?.count).toBe('1');
  });
  it('retry 40001 abre outra transação e restart após commit não duplica revisão', async () => {
    const id = (await db.query<{ id: string }>(`INSERT INTO events (type) VALUES ('TASK_COMPLETED') RETURNING id`)).rows[0]!.id;
    let connections = 0;
    let injected = false;
    const retryPool = {
      connect: async () => {
        const client = await db.connect();
        connections++;
        if (connections > 1) return client;
        return new Proxy(client, {
          get(target, key) {
            if (key === 'query') return (sql: string, ...params: unknown[]) => {
              if (!injected && sql.includes('FROM office_projection_head') && sql.includes('FOR UPDATE')) {
                injected = true;
                return Promise.reject(Object.assign(new Error('serialization test'), { code: '40001' }));
              }
              return Reflect.apply(target.query, target, [sql, ...params]);
            };
            if (key === 'release') return target.release.bind(target);
            return Reflect.get(target, key);
          },
        });
      },
    } as unknown as Pool;
    const committed = await refreshOfficeProjection(retryPool, { autonomyEnabled: false, autoSpendEnabled: false });
    expect(connections).toBe(2);
    const restarted = await refreshOfficeProjection(db, { autonomyEnabled: false, autoSpendEnabled: false });
    expect(restarted.streamCursor).toBe(committed.streamCursor);
    expect((await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM office_event_receipts WHERE source_event_id = $1`, [id])).rows[0]?.count).toBe('1');
  });
  it('rollback de evento não cria revisão ou recibo órfão', async () => {
    const before = await readOfficeEnvelope(db);
    expect(before).not.toBeNull();
    const tx = await db.connect();
    let id: string;
    try {
      await tx.query('BEGIN');
      id = (await tx.query<{ id: string }>(`INSERT INTO events (type) VALUES ('TASK_COMPLETED') RETURNING id`)).rows[0]!.id;
      await tx.query('ROLLBACK');
    } finally { tx.release(); }
    const after = await refreshOfficeProjection(db, { autonomyEnabled: false, autoSpendEnabled: false });
    expect(after.streamCursor).toBe(before!.streamCursor);
    expect((await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM office_event_receipts WHERE source_event_id = $1`, [id])).rows[0]?.count).toBe('0');
  });
  it('release e breakers SOURCE/AGENT preservam leitura sem consumo de probe', async () => {
    await db.query(`INSERT INTO emergency_stop_events (kind, actor, reason) VALUES ('RELEASED', 'FOUNDER_CLI', 'm7 test')`);
    await db.query(`INSERT INTO circuit_breaker_events (scope_type, scope_key, event_type) VALUES ('SOURCE', 'm7-source', 'OPENED'), ('SOURCE', 'm7-source', 'HALF_OPEN'), ('AGENT', 'REVISOR-001', 'CLOSED')`);
    const count = async () => (await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM circuit_breaker_events`)).rows[0]?.count;
    const before = await count();
    const envelope = await refreshOfficeProjection(db, { autonomyEnabled: false, autoSpendEnabled: false });
    expect(envelope.snapshot.governance).toMatchObject({ emergencyStop: false, circuitBreaker: 'HALF_OPEN', autoSpendEnabled: false });
    expect(envelope.snapshot.governance.breakers).toEqual(expect.arrayContaining([
      expect.objectContaining({ scopeType: 'SOURCE', scopeKey: 'm7-source', state: 'HALF_OPEN' }),
      expect.objectContaining({ scopeType: 'AGENT', scopeKey: 'REVISOR-001', state: 'CLOSED' }),
    ]));
    expect(await count()).toBe(before);
  });
  it('replay diferencia epoch inválida, cursor futuro e gap', async () => {
    const current = await readOfficeEnvelope(db);
    expect(current).not.toBeNull();
    const revision = BigInt(current!.revision);
    expect(await readOfficeReplay(db, encodeCursor({ epoch: crypto.randomUUID(), revision: current!.revision }))).toMatchObject({ status: 'RESYNC', reason: 'EPOCH_MISMATCH' });
    expect(await readOfficeReplay(db, encodeCursor({ epoch: current!.streamCursor.split('.')[1]!, revision: (revision + 1n).toString() }))).toMatchObject({ status: 'RESYNC', reason: 'CURSOR_AHEAD' });
    expect(await readOfficeReplay(db, 'invalid')).toMatchObject({ status: 'RESYNC', reason: 'INVALID_CURSOR' });
    if (revision > 1n) {
      const row = (await db.query<{ epoch: string; revision: string; base_revision: string; payload: unknown; created_at: Date }>(
        `SELECT epoch, revision, base_revision, payload, created_at FROM office_stream_entries WHERE revision > 1 ORDER BY revision LIMIT 1`,
      )).rows[0];
      if (row) {
        await db.query(`DELETE FROM office_stream_entries WHERE epoch = $1 AND revision = $2`, [row.epoch, row.revision]);
        try {
          expect(await readOfficeReplay(db, encodeCursor({ epoch: row.epoch, revision: '1' }))).toMatchObject({ status: 'RESYNC', reason: 'REVISION_GAP' });
        } finally {
          await db.query(`INSERT INTO office_stream_entries (epoch, revision, base_revision, payload, created_at) VALUES ($1, $2, $3, $4::jsonb, $5)`,
            [row.epoch, row.revision, row.base_revision, JSON.stringify(row.payload), row.created_at]);
        }
      }
    }
  });
  it('histórico sintético acima do lote reconcilia sem perder recibos nem exceder timeline', async () => {
    const sourceIds = (await db.query<{ id: string }>(
      `INSERT INTO events (type) SELECT 'TASK_CREATED' FROM generate_series(1, 250) RETURNING id`,
    )).rows.map(row => row.id);
    const before = await readOfficeEnvelope(db);
    expect(before).not.toBeNull();
    const first = await refreshOfficeProjection(db, { autonomyEnabled: false, autoSpendEnabled: false });
    const second = await refreshOfficeProjection(db, { autonomyEnabled: false, autoSpendEnabled: false });
    expect(BigInt(second.revision)).toBe(BigInt(first.revision) + 1n);
    const receipts = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM office_event_receipts WHERE source_event_id = ANY($1::uuid[])`, [sourceIds],
    );
    expect(receipts.rows[0]?.count).toBe('250');
    expect(second.snapshot.timeline.length).toBeLessThanOrEqual(50);
    const replay = await readOfficeReplay(db, before!.streamCursor);
    expect(replay.status).toBe('OK');
    if (replay.status === 'OK') expect(replay.updates.map(update => update.cursor)).toEqual([first.streamCursor, second.streamCursor]);
  });
  it('evento fonte desconhecido recebe recibo sem virar timeline nem revisão inventada', async () => {
    const before = await readOfficeEnvelope(db);
    expect(before).not.toBeNull();
    const id = (await db.query<{ id: string }>(
      `INSERT INTO events (type, payload) VALUES ('OFFICE_UNKNOWN_TEST', '{"text":"SECRET_CANARY"}'::jsonb) RETURNING id`,
    )).rows[0]!.id;
    const after = await refreshOfficeProjection(db, { autonomyEnabled: false, autoSpendEnabled: false });
    expect(after.streamCursor).toBe(before!.streamCursor);
    expect(after.snapshot.timeline.some(event => event.id === id)).toBe(false);
    expect(JSON.stringify(after)).not.toContain('SECRET_CANARY');
    expect((await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM office_event_receipts WHERE source_event_id = $1`, [id])).rows[0]?.count).toBe('1');
  });
  it('overflow financeiro permanece indisponível sem fabricar zero nem misturar REAL', async () => {
    const opportunity = (await db.query<{ id: string }>(
      `INSERT INTO opportunities (source, source_url, title) VALUES ('m7-overflow', 'https://example.invalid/overflow', 'm7 overflow') RETURNING id`,
    )).rows[0]!.id;
    const entry = (await db.query<{ id: string }>(
      `INSERT INTO financial_ledger (entry_type, amount_cents, ledger_scope, description, opportunity_id, external_reference, idempotency_key)
       VALUES ('REVENUE', $1, 'SIMULATION', 'm7 overflow', $2, 'm7-overflow', $3) RETURNING id`,
      ['9007199254740992', opportunity, crypto.randomUUID()],
    )).rows[0]!;
    try {
      const snapshot = (await refreshOfficeProjection(db, { autonomyEnabled: false, autoSpendEnabled: false })).snapshot;
      expect(snapshot.financial.simulation).toBeNull();
      expect(snapshot.financial.real?.cashCents).toBe(-200);
    } finally {
      await removeSyntheticOverflow(db, entry.id);
    }
  });
  it('replay iniciado antes da retenção preserva sua revisão e depois converge', async () => {
    const before = await readOfficeEnvelope(db);
    expect(before).not.toBeNull();
    await db.query(`INSERT INTO events (type) VALUES ('TASK_STARTED')`);
    const updated = await refreshOfficeProjection(db, { autonomyEnabled: false, autoSpendEnabled: false });
    await db.query(`UPDATE office_stream_entries SET created_at = clock_timestamp() - INTERVAL '25 hours'`);
    let releaseEntries!: () => void;
    let entriesReached!: () => void;
    const holdEntries = new Promise<void>(resolve => { releaseEntries = resolve; });
    const atEntries = new Promise<void>(resolve => { entriesReached = resolve; });
    const replayPool = {
      connect: async () => {
        const client = await db.connect();
        return new Proxy(client, {
          get(target, key) {
            if (key === 'query') return (sql: string, ...params: unknown[]) => {
              if (sql.includes('SELECT payload FROM office_stream_entries')) {
                entriesReached();
                return holdEntries.then(() => Reflect.apply(target.query, target, [sql, ...params]));
              }
              return Reflect.apply(target.query, target, [sql, ...params]);
            };
            if (key === 'release') return target.release.bind(target);
            return Reflect.get(target, key);
          },
        });
      },
    } as unknown as Pool;
    const pending = readOfficeReplay(replayPool, before!.streamCursor);
    await atEntries;
    try { await refreshOfficeProjection(db, { autonomyEnabled: false, autoSpendEnabled: false }); }
    finally { releaseEntries(); }
    const replay = await pending;
    expect(replay.status).toBe('OK');
    if (replay.status === 'OK') expect(replay.updates.at(-1)?.cursor).toBe(updated.streamCursor);
    expect(await readOfficeReplay(db, updated.streamCursor)).toMatchObject({ status: 'OK', updates: [] });
  });
  it('retenção expira prefixo contíguo e up/down 0014 não toca o domínio', async () => {
    const current = await readOfficeEnvelope(db);
    expect(current).not.toBeNull();
    const epoch = current!.streamCursor.split('.')[1];
    await db.query(`UPDATE office_stream_entries SET created_at = clock_timestamp() - INTERVAL '25 hours' WHERE epoch = $1 AND revision = 1`, [epoch]);
    await refreshOfficeProjection(db, { autonomyEnabled: false, autoSpendEnabled: false });
    expect(await readOfficeReplay(db, `v2.${epoch}.0`)).toMatchObject({ status: 'RESYNC', reason: 'CURSOR_EXPIRED' });
    const domainBefore = (await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM agents`)).rows[0]!.count;
    expect(await migrateDown(db, 1)).toEqual(['0014_office_projection']);
    expect((await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM agents`)).rows[0]!.count).toBe(domainBefore);
    expect(await migrateUp(db)).toEqual(['0014_office_projection']);
  });
});
