import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '@escritorio/api';
import { runStopCommand } from '@escritorio/cli';
import { type Pool, seedInitialAgents } from '@escritorio/database';
import { EventBus, EventStore, JOB_NAMES } from '@escritorio/events';
import { Governor, loadConstitution } from '@escritorio/governor';
import { createTestPool, logger, resetDatabase } from './support.js';

/**
 * As duas portas do fundador para o Emergency Stop (M6, critério 5), contra Postgres real:
 * a rota da API (com segredo só de ambiente) e a CLI. As duas só traduzem para o mesmo
 * serviço, e o RELEASE de ambas devolve o trabalho pausado à fila sem duplicar.
 */
const SECRET = 'segredo-do-fundador-de-teste-0123456789';
const governor = new Governor(loadConstitution());
const attempts = governor.limits.MAX_TASK_RETRIES + 1;
let pool: Pool;

async function buildApp(adminSecret?: string) {
  return buildServer({
    logger,
    db: pool,
    redis: {} as Redis, // nenhuma rota exercitada aqui toca o Redis
    bus: new EventBus(pool),
    store: new EventStore(pool),
    governor,
    aiMode: 'mock',
    pool,
    adminSecret,
  });
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params);
  return Number(rows[0]!.n);
}

async function pauseSomeWork(): Promise<string> {
  const entityId = crypto.randomUUID();
  await pool.query(`INSERT INTO paused_work (job_name, entity_id, correlation_id, pause_reason) VALUES ($1, $2, $3, 'EMERGENCY_STOP')`, [
    JOB_NAMES.DEVELOP_TASK,
    entityId,
    crypto.randomUUID(),
  ]);
  return entityId;
}

beforeAll(() => {
  pool = createTestPool();
});

beforeEach(async () => {
  await resetDatabase(pool);
  await seedInitialAgents(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('API do fundador', () => {
  it('sem segredo no ambiente a rota nem existe (404), e nada é gravado', async () => {
    const app = await buildApp(undefined);
    const response = await app.inject({ method: 'POST', url: '/admin/emergency-stop', payload: { reason: 'x' }, headers: { 'x-admin-secret': SECRET } });
    expect(response.statusCode).toBe(404);
    expect(await count('emergency_stop_events')).toBe(0);
    await app.close();
  });

  it.each([
    ['sem cabeçalho', {}],
    ['segredo errado', { 'x-admin-secret': 'errado-errado-errado-errado' }],
    ['segredo de tamanho diferente', { 'x-admin-secret': 'curto' }],
  ])('%s: 401 e nada é gravado', async (_name, headers) => {
    const app = await buildApp(SECRET);
    for (const [method, url] of [['GET', '/admin/emergency-stop'], ['POST', '/admin/emergency-stop'], ['POST', '/admin/emergency-stop/release']] as const) {
      const response = await app.inject({ method, url, payload: method === 'POST' ? { reason: 'x' } : undefined, headers });
      expect(response.statusCode).toBe(401);
    }
    expect(await count('emergency_stop_events')).toBe(0);
    await app.close();
  });

  it('engage grava o ator FOUNDER_API, é idempotente e o estado reflete', async () => {
    const app = await buildApp(SECRET);
    const headers = { 'x-admin-secret': SECRET };

    const first = await app.inject({ method: 'POST', url: '/admin/emergency-stop', payload: { reason: 'incidente' }, headers });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ transition: 'ENGAGED' });
    expect((await app.inject({ method: 'POST', url: '/admin/emergency-stop', payload: { reason: 'de novo' }, headers })).json()).toEqual({ transition: 'ALREADY_ENGAGED' });

    const { rows } = await pool.query<{ actor: string; reason: string }>('SELECT actor, reason FROM emergency_stop_events');
    expect(rows).toEqual([{ actor: 'FOUNDER_API', reason: 'incidente' }]);
    expect(await count(`events WHERE type = 'EMERGENCY_STOP_ENGAGED'`)).toBe(1);

    const state = (await app.inject({ method: 'GET', url: '/admin/emergency-stop', headers })).json<{ state: { status: string; reason: string } }>();
    expect(state.state).toMatchObject({ status: 'ENGAGED', reason: 'incidente' });
    expect(JSON.stringify(state)).not.toContain(SECRET);
    await app.close();
  });

  it.each([
    ['motivo vazio', { reason: '   ' }],
    ['motivo ausente', {}],
    ['motivo grande demais', { reason: 'x'.repeat(501) }],
    ['campo extra', { reason: 'ok', actor: 'FOUNDER_CLI' }],
  ])('%s: 400 e nada é gravado', async (_name, payload) => {
    const app = await buildApp(SECRET);
    for (const url of ['/admin/emergency-stop', '/admin/emergency-stop/release']) {
      const response = await app.inject({ method: 'POST', url, payload, headers: { 'x-admin-secret': SECRET } });
      expect(response.statusCode).toBe(400);
    }
    expect(await count('emergency_stop_events')).toBe(0);
    await app.close();
  });

  it('release devolve o trabalho pausado à fila UMA vez; repetir não duplica', async () => {
    const app = await buildApp(SECRET);
    const headers = { 'x-admin-secret': SECRET };
    await app.inject({ method: 'POST', url: '/admin/emergency-stop', payload: { reason: 'incidente' }, headers });
    const entityId = await pauseSomeWork();

    const release = await app.inject({ method: 'POST', url: '/admin/emergency-stop/release', payload: { reason: 'resolvido' }, headers });
    expect(release.json()).toEqual({ transition: 'RELEASED', resumed: 1 });
    expect(await count(`outbox WHERE job_name = $1`, [JOB_NAMES.DEVELOP_TASK])).toBe(1);
    expect(await count(`events WHERE type = 'WORK_RESUMED' AND payload->>'entityId' = $1`, [entityId])).toBe(1);

    const again = await app.inject({ method: 'POST', url: '/admin/emergency-stop/release', payload: { reason: 'resolvido' }, headers });
    expect(again.json()).toEqual({ transition: 'NOT_ENGAGED', resumed: 0 });
    expect(await count('outbox')).toBe(1);
    await app.close();
  });

  it('release com o Stop já liberado conclui uma retomada que ficou pela metade', async () => {
    const app = await buildApp(SECRET);
    const headers = { 'x-admin-secret': SECRET };
    await app.inject({ method: 'POST', url: '/admin/emergency-stop', payload: { reason: 'i' }, headers });
    await app.inject({ method: 'POST', url: '/admin/emergency-stop/release', payload: { reason: 'r' }, headers });
    await pauseSomeWork(); // o processo caiu entre liberar e retomar

    const retry = await app.inject({ method: 'POST', url: '/admin/emergency-stop/release', payload: { reason: 'r2' }, headers });
    expect(retry.json()).toEqual({ transition: 'NOT_ENGAGED', resumed: 1 });
    await app.close();
  });
});

describe('CLI do fundador', () => {
  function io() {
    const lines: string[] = [];
    const errors: string[] = [];
    return { lines, errors, io: { out: (l: string) => lines.push(l), err: (l: string) => errors.push(l) } };
  }

  it('status, engage e release: ator FOUNDER_CLI e retomada', async () => {
    const a = io();
    expect(await runStopCommand(pool, attempts, ['status'], a.io)).toBe(0);
    expect(a.lines[0]).toContain('LIBERADO');

    expect(await runStopCommand(pool, attempts, ['engage', '--reason', 'manutenção'], a.io)).toBe(0);
    expect(a.lines[1]).toContain('ENGAGED');
    expect(await runStopCommand(pool, attempts, ['status'], a.io)).toBe(0);
    expect(a.lines[2]).toContain('ACIONADO');
    expect(a.lines[2]).toContain('FOUNDER_CLI');

    await pauseSomeWork();
    expect(await runStopCommand(pool, attempts, ['release', '--reason', 'ok'], a.io)).toBe(0);
    expect(a.lines[3]).toContain('RELEASED');
    expect(a.lines[3]).toContain('retomado: 1');
    expect(await count('outbox')).toBe(1);

    const { rows } = await pool.query<{ actor: string }>('SELECT DISTINCT actor FROM emergency_stop_events');
    expect(rows).toEqual([{ actor: 'FOUNDER_CLI' }]);
  });

  it.each([
    ['engage sem motivo', ['engage']],
    ['engage com motivo vazio', ['engage', '--reason', '  ']],
    ['release sem motivo', ['release']],
    ['comando desconhecido', ['explode']],
    ['sem comando', []],
  ])('%s: código 1, mensagem de uso e nada gravado', async (_name, args) => {
    const a = io();
    expect(await runStopCommand(pool, attempts, args, a.io)).toBe(1);
    expect(a.errors.length).toBeGreaterThan(0);
    expect(await count('emergency_stop_events')).toBe(0);
  });
});
