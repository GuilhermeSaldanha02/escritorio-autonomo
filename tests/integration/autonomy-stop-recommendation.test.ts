import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EmergencyStopService, recommendEmergencyStop } from '@escritorio/autonomy';
import type { Pool } from '@escritorio/database';
import { createTestPool, resetDatabase } from './support.js';

/** Critério 9 do M6: componentes determinísticos só RECOMENDAM o Stop; nada o aciona. */
let pool: Pool;

beforeAll(() => {
  pool = createTestPool();
});
beforeEach(async () => {
  await resetDatabase(pool);
});
afterAll(async () => {
  await pool.end();
});

describe('recomendação do Emergency Stop', () => {
  const rec = { source: 'CIRCUIT_BREAKER', code: 'MULTIPLOS_CIRCUITOS', detail: 'dois circuitos abertos' };

  it('grava o evento e NÃO muda o estado do Stop', async () => {
    expect(await recommendEmergencyStop(pool, rec)).toBe(true);
    const { rows } = await pool.query(`SELECT payload FROM events WHERE type = 'EMERGENCY_STOP_RECOMMENDED'`);
    expect(rows).toHaveLength(1);
    expect((await new EmergencyStopService(pool).state()).status).toBe('CLEAR');
    const { rows: stops } = await pool.query('SELECT 1 FROM emergency_stop_events');
    expect(stops).toHaveLength(0);
  });

  it('repetir na mesma hora não duplica; em outra hora, ou outro código, registra de novo', async () => {
    const t = new Date('2026-09-18T12:10:00Z');
    expect(await recommendEmergencyStop(pool, rec, t)).toBe(true);
    expect(await recommendEmergencyStop(pool, rec, new Date(t.getTime() + 60_000))).toBe(false);
    expect(await recommendEmergencyStop(pool, rec, new Date(t.getTime() + 3_600_000))).toBe(true);
    expect(await recommendEmergencyStop(pool, { ...rec, code: 'OUTRO' }, t)).toBe(true);
    const { rows } = await pool.query(`SELECT 1 FROM events WHERE type = 'EMERGENCY_STOP_RECOMMENDED'`);
    expect(rows).toHaveLength(3);
  });
});
