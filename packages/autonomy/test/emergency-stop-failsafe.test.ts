import { describe, expect, it } from 'vitest';
import type { Queryable } from '@escritorio/database';
import { readStopState } from '../src/emergency-stop.js';

function db(query: () => Promise<{ rows: unknown[] }>): Queryable {
  return { query } as unknown as Queryable;
}

describe('readStopState: fail-safe', () => {
  it('banco fora: devolve UNVERIFIABLE e NUNCA lança', async () => {
    const state = await readStopState(
      db(async () => {
        throw new Error('conexão recusada');
      }),
    );
    expect(state).toEqual({ status: 'UNVERIFIABLE', error: 'conexão recusada' });
  });

  it('sem nenhuma linha, o sistema está liberado', async () => {
    expect(await readStopState(db(async () => ({ rows: [] })))).toEqual({ status: 'CLEAR' });
  });

  it('a última linha RELEASED libera; ENGAGED para', async () => {
    const at = new Date('2026-09-18T12:00:00.000Z');
    expect(await readStopState(db(async () => ({ rows: [{ kind: 'RELEASED', actor: 'FOUNDER_CLI', reason: 'ok', occurred_at: at }] })))).toEqual({
      status: 'CLEAR',
    });
    expect(await readStopState(db(async () => ({ rows: [{ kind: 'ENGAGED', actor: 'FOUNDER_API', reason: 'incidente', occurred_at: at }] })))).toEqual({
      status: 'ENGAGED',
      since: at,
      reason: 'incidente',
      actor: 'FOUNDER_API',
    });
  });
});
