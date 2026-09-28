import { describe, expect, it } from 'vitest';
import { OFFICE_DEMO_FIXTURE } from '../../../apps/office/src/fixtures.js';
import { decodeCursor, encodeCursor, officeChangesSchema, officeEnvelopeSchema, officeSnapshotSchema, officeStreamMessageSchema } from '../src/index.js';

const epoch = '123e4567-e89b-42d3-a456-426614174000';
describe('I01/I03/I13 contrato browser-safe', () => {
  it('aceita fixture e normaliza estado desconhecido sem inventar datas', () => {
    const fixture = structuredClone(OFFICE_DEMO_FIXTURE.snapshot);
    Object.assign(fixture.agents[0]!, { state: 'FUTURE', stateSince: null });
    const parsed = officeSnapshotSchema.parse(fixture);
    expect(parsed.agents[0]!.state).toBe('UNKNOWN');
    expect(parsed.agents[0]!.stateSince).toBeNull();
    expect(officeSnapshotSchema.safeParse(OFFICE_DEMO_FIXTURE.snapshot).success).toBe(true);
    expect(officeSnapshotSchema.safeParse({ ...fixture, secret: 'CANARY' }).success).toBe(false);
  });
  it('valida cursor canônico limitado sem perder precisão', () => {
    const cursor = encodeCursor({ epoch, revision: '9007199254740993' });
    expect(decodeCursor(cursor)).toEqual({ version: '2.0.0', epoch, revision: '9007199254740993' });
    for (const invalid of ['', cursor + '=', cursor.toUpperCase(), 'x'.repeat(513)]) {
      expect(() => decodeCursor(invalid)).toThrow();
    }
    expect(() => encodeCursor({ epoch, revision: '01' })).toThrow();
  });
  it('rejeita comandos desconhecidos, campos extras e revisão divergente', () => {
    const cursor = encodeCursor({ epoch, revision: '1' });
    expect(officeEnvelopeSchema.safeParse({ contractVersion: '2.0.0', streamCursor: cursor, revision: '2', snapshot: OFFICE_DEMO_FIXTURE.snapshot }).success).toBe(false);
    expect(officeStreamMessageSchema.safeParse({ type: 'HACK' }).success).toBe(false);
    expect(officeStreamMessageSchema.safeParse({ type: 'SUBSCRIBE', clientVersion: '2.0.0', afterCursor: cursor }).success).toBe(true);
    expect(officeStreamMessageSchema.safeParse({ type: 'SYNC_COMPLETE', cursor, payload: 'CANARY' }).success).toBe(false);
    expect(officeStreamMessageSchema.safeParse({ type: 'OFFICE_UPDATED', baseCursor: cursor, cursor, revision: '1', changes: { cashDelta: 1 } }).success).toBe(false);
  });
  it('I06: permite datas no replacement, mas não revisão causada só por data', () => {
    const baseCursor = encodeCursor({ epoch, revision: '1' });
    const cursor = encodeCursor({ epoch, revision: '2' });
    const { generatedAt, metadata, agents } = OFFICE_DEMO_FIXTURE.snapshot;
    expect(officeStreamMessageSchema.safeParse({ type: 'OFFICE_UPDATED', baseCursor, cursor, revision: '2', changes: { agents, generatedAt, metadata } }).success).toBe(true);
    expect(officeStreamMessageSchema.safeParse({ type: 'OFFICE_UPDATED', baseCursor, cursor, revision: '2', changes: { generatedAt, metadata } }).success).toBe(false);
  });
  it('I11: changes parciais não materializam metadata nem outras seções omitidas', () => {
    expect(officeChangesSchema.parse({ timeline: [] })).toEqual({ timeline: [] });
    const baseCursor = encodeCursor({ epoch, revision: '1' });
    const cursor = encodeCursor({ epoch, revision: '2' });
    const message = officeStreamMessageSchema.parse({ type: 'OFFICE_UPDATED', baseCursor, cursor, revision: '2', changes: { timeline: [] } });
    expect(message.type === 'OFFICE_UPDATED' && message.changes).toEqual({ timeline: [] });
  });
  it('I11: metadata explícita substitui a seção; snapshot completo preserva seus defaults', () => {
    const metadata = { ...OFFICE_DEMO_FIXTURE.snapshot.metadata, connection: 'LIVE' as const };
    expect(officeChangesSchema.parse({ timeline: [], metadata })).toEqual({ timeline: [], metadata });
    expect(officeChangesSchema.safeParse({ timeline: [], metadata: {} }).success).toBe(false);
    const { metadata: _omitted, ...snapshotWithoutMetadata } = OFFICE_DEMO_FIXTURE.snapshot;
    expect(officeSnapshotSchema.parse(snapshotWithoutMetadata).metadata.connection).toBe('DEMO');
  });
});
