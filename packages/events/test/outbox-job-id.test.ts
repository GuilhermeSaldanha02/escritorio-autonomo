import { describe, expect, it } from 'vitest';
import type { Queryable } from '@escritorio/database';
import { enqueueInOutbox } from '../src/outbox.js';

const entry = { eventId: 'e', queue: 'q', jobName: 'j', payload: {}, jobAttempts: 1 };

describe('enqueueInOutbox — id de job', () => {
  it('recusa ":" (o BullMQ não aceita) antes de tocar o banco', async () => {
    const calls: unknown[] = [];
    const db = { query: async (...args: unknown[]) => void calls.push(args) } as unknown as Queryable;
    await expect(enqueueInOutbox(db, { ...entry, jobId: 'scheduled-DISCOVERY:1' })).rejects.toThrow(/BullMQ/);
    expect(calls).toHaveLength(0);
  });

  it('aceita um id sem ":"', async () => {
    const db = { query: async () => ({ rows: [] }) } as unknown as Queryable;
    await expect(enqueueInOutbox(db, { ...entry, jobId: 'scheduled-DISCOVERY-1' })).resolves.toBeUndefined();
  });
});
