import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from '@escritorio/database';
import {
  AutonomyController,
  type BreakerPolicy,
  CircuitBreakerStore,
  type CircuitScope,
  EmergencyStopService,
  InvalidStopActorError,
  readStopState,
  stopReaderFor,
} from '@escritorio/autonomy';
import { Governor, loadConstitution } from '@escritorio/governor';
import { createTestPool, resetDatabase } from './support.js';

/**
 * Critérios 5 a 12 do M6 contra Postgres real: o Emergency Stop é humano,
 * append-only e serializado; o circuit breaker é por escopo, persistido e só
 * admite UMA sonda sob concorrência. O tempo é injetado.
 */
let pool: Pool;

beforeAll(async () => {
  pool = createTestPool();
});

beforeEach(async () => {
  await resetDatabase(pool);
});

afterAll(async () => {
  await pool.end();
});

async function count(sql: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`);
  return Number(rows[0]!.n);
}

/**
 * Prova DETERMINÍSTICA de atomicidade: o teste segura o mesmo advisory lock que o
 * store usa e afirma que a operação fica BLOQUEADA enquanto ele está preso. Uma corrida
 * de verdade entre conexões depende de tempo e pode nunca acontecer.
 */
async function blockedWhileLockHeld<T>(lockKey: string, operation: () => Promise<T>): Promise<T> {
  const holder = await pool.connect();
  await holder.query('BEGIN');
  await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);
  let finished = false;
  const pending = operation().then((value) => {
    finished = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const wasBlocked = !finished;
  await holder.query('COMMIT');
  holder.release();
  const result = await pending;
  expect(wasBlocked, `a operação devia esperar o lock ${lockKey}`).toBe(true);
  return result;
}

describe('Emergency Stop', () => {
  it('engaja e libera, é idempotente e mantém uma linha por transição real', async () => {
    const stop = new EmergencyStopService(pool);
    expect((await stop.state()).status).toBe('CLEAR');

    expect(await stop.engage('FOUNDER_CLI', 'incidente de teste')).toBe('ENGAGED');
    expect(await stop.engage('FOUNDER_CLI', 'de novo')).toBe('ALREADY_ENGAGED');
    expect(await stop.state()).toMatchObject({ status: 'ENGAGED', actor: 'FOUNDER_CLI', reason: 'incidente de teste' });
    expect(await count('emergency_stop_events')).toBe(1);

    expect(await stop.release('FOUNDER_API', 'resolvido')).toBe('RELEASED');
    expect(await stop.release('FOUNDER_API', 'de novo')).toBe('NOT_ENGAGED');
    expect((await stop.state()).status).toBe('CLEAR');
    expect(await count('emergency_stop_events')).toBe(2);
  });

  it('o estado é a ÚLTIMA linha por seq: engaja, libera, engaja de novo => engajado', async () => {
    const stop = new EmergencyStopService(pool);
    await stop.engage('FOUNDER_CLI', 'a');
    await stop.release('FOUNDER_CLI', 'b');
    await stop.engage('FOUNDER_API', 'c');
    expect(await stop.state()).toMatchObject({ status: 'ENGAGED', reason: 'c' });
    expect(await count('emergency_stop_events')).toBe(3);
  });

  it('cinco engajamentos simultâneos resultam em UM só', async () => {
    const stop = new EmergencyStopService(pool);
    const results = await Promise.all(Array.from({ length: 5 }, () => stop.engage('FOUNDER_CLI', 'corrida')));
    expect(results.filter((r) => r === 'ENGAGED')).toHaveLength(1);
    expect(results.filter((r) => r === 'ALREADY_ENGAGED')).toHaveLength(4);
    expect(await count('emergency_stop_events')).toBe(1);
  });

  it('só o fundador aciona: o serviço recusa qualquer outro ator, e o banco também', async () => {
    const stop = new EmergencyStopService(pool);
    await expect(stop.engage('DIRETOR-001' as never, 'x')).rejects.toThrow(InvalidStopActorError);
    await expect(stop.release('SCHEDULER' as never, 'x')).rejects.toThrow(InvalidStopActorError);
    expect(await count('emergency_stop_events')).toBe(0);

    await expect(
      pool.query(`INSERT INTO emergency_stop_events (kind, actor, reason) VALUES ('ENGAGED', 'AGENT', 'forjado')`),
    ).rejects.toThrow(/actor_check/);
  });

  it('engage serializa pelo lock do Stop: fica bloqueado enquanto ele está preso', async () => {
    const stop = new EmergencyStopService(pool);
    expect(await blockedWhileLockHeld('emergency-stop', () => stop.engage('FOUNDER_CLI', 'lock'))).toBe('ENGAGED');
  });

  it('exige um motivo', async () => {
    await expect(new EmergencyStopService(pool).engage('FOUNDER_CLI', '   ')).rejects.toThrow(RangeError);
  });

  it('é append-only: UPDATE e DELETE são recusados', async () => {
    await new EmergencyStopService(pool).engage('FOUNDER_CLI', 'x');
    await expect(pool.query(`UPDATE emergency_stop_events SET kind = 'RELEASED'`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM emergency_stop_events`)).rejects.toThrow(/append-only/);
  });

  it('publica EMERGENCY_STOP_ENGAGED e EMERGENCY_STOP_RELEASED no Event Bus', async () => {
    const stop = new EmergencyStopService(pool);
    await stop.engage('FOUNDER_CLI', 'x');
    await stop.release('FOUNDER_CLI', 'y');
    const { rows } = await pool.query<{ type: string }>(`SELECT type FROM events WHERE type LIKE 'EMERGENCY_STOP_%' ORDER BY occurred_at`);
    expect(rows.map((r) => r.type)).toEqual(['EMERGENCY_STOP_ENGAGED', 'EMERGENCY_STOP_RELEASED']);
  });

  it('FAIL-SAFE contra o banco real: tabela ilegível resulta em UNVERIFIABLE, sem lançar', async () => {
    await pool.query('ALTER TABLE emergency_stop_events RENAME TO emergency_stop_events_off');
    try {
      const state = await readStopState(pool);
      expect(state.status).toBe('UNVERIFIABLE');
    } finally {
      await pool.query('ALTER TABLE emergency_stop_events_off RENAME TO emergency_stop_events');
    }
  });
});

describe('Circuit breaker', () => {
  const POLICY: BreakerPolicy = { failureThreshold: 3, cooldownMs: 60_000, minSample: 1 };
  const T0 = new Date('2026-09-18T12:00:00.000Z');
  const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
  const SOURCE: CircuitScope = { type: 'SOURCE', key: 'github' };
  const AGENT: CircuitScope = { type: 'AGENT', key: 'DESENVOLVEDOR-001' };
  const store = () => new CircuitBreakerStore(pool, () => POLICY);

  async function failTimes(s: CircuitBreakerStore, scope: CircuitScope, n: number, startSecond = 0) {
    for (let i = 0; i < n; i++) await s.recordOutcome(scope, 'FAILURE', at(startSecond + i), 'falha técnica');
  }

  it('abre no limiar de falhas consecutivas, emite CIRCUIT_OPENED e nega até o cooldown', async () => {
    const s = store();
    await failTimes(s, SOURCE, 2);
    expect((await s.state(SOURCE)).status).toBe('CLOSED');
    await failTimes(s, SOURCE, 1, 2);
    expect((await s.state(SOURCE)).status).toBe('OPEN');

    expect(await s.admit(SOURCE, at(30))).toBe('DENY');
    const { rows } = await pool.query(`SELECT payload FROM events WHERE type = 'CIRCUIT_OPENED'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ scopeType: 'SOURCE', scopeKey: 'github' });
  });

  it('circuito aberto bloqueia SÓ o seu escopo: o do agente segue admitindo', async () => {
    const s = store();
    await failTimes(s, SOURCE, 3);
    expect(await s.admit(SOURCE, at(10))).toBe('DENY');
    expect(await s.admit(AGENT, at(10))).toBe('ADMIT');
    expect((await s.state(AGENT)).status).toBe('CLOSED');
  });

  it('o isolamento vale em cada dimensão: outra chave do mesmo tipo, e a mesma chave em outro tipo', async () => {
    const s = store();
    await failTimes(s, { type: 'SOURCE', key: 'github' }, 3);
    expect(await s.admit({ type: 'SOURCE', key: 'github' }, at(10))).toBe('DENY');
    expect(await s.admit({ type: 'SOURCE', key: 'gitlab' }, at(10))).toBe('ADMIT'); // mesma dimensão de tipo, outra chave
    expect(await s.admit({ type: 'AGENT', key: 'github' }, at(10))).toBe('ADMIT'); // mesma chave, outro tipo
  });

  it('depois do cooldown, exatamente UMA sonda passa, mesmo com cinco tentativas simultâneas', async () => {
    const s = store();
    await failTimes(s, SOURCE, 3);
    const results = await Promise.all(Array.from({ length: 5 }, () => s.admit(SOURCE, at(120))));
    expect(results.filter((r) => r === 'PROBE')).toHaveLength(1);
    expect(results.filter((r) => r === 'DENY')).toHaveLength(4);
    expect(await count(`circuit_breaker_events WHERE event_type = 'HALF_OPEN'`)).toBe(1);
  });

  it('admit e recordOutcome serializam pelo lock do escopo: ficam bloqueados enquanto ele está preso', async () => {
    const s = store();
    await failTimes(s, SOURCE, 3);
    expect(await blockedWhileLockHeld('circuit:SOURCE:github', () => s.admit(SOURCE, at(120)))).toBe('PROBE');
    await blockedWhileLockHeld('circuit:SOURCE:github', () => s.recordOutcome(SOURCE, 'SUCCESS', at(121)));
    expect((await s.state(SOURCE)).status).toBe('CLOSED');
  });

  it('o lock é por escopo: preso o de uma fonte, outro escopo NÃO espera', async () => {
    const s = store();
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['circuit:SOURCE:github']);
    try {
      expect(await s.admit({ type: 'SOURCE', key: 'gitlab' }, at(0))).toBe('ADMIT');
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }
  });

  it('sonda bem-sucedida FECHA o circuito e emite CIRCUIT_CLOSED', async () => {
    const s = store();
    await failTimes(s, SOURCE, 3);
    expect(await s.admit(SOURCE, at(120))).toBe('PROBE');
    expect((await s.recordOutcome(SOURCE, 'SUCCESS', at(121))).status).toBe('CLOSED');
    expect(await s.admit(SOURCE, at(122))).toBe('ADMIT');
    expect(await count(`events WHERE type = 'CIRCUIT_CLOSED'`)).toBe(1);
  });

  it('sonda que falha REABRE, e o cooldown recomeça daquele instante', async () => {
    const s = store();
    await failTimes(s, SOURCE, 3);
    await s.admit(SOURCE, at(120));
    expect((await s.recordOutcome(SOURCE, 'FAILURE', at(121), 'sonda falhou')).status).toBe('OPEN');
    expect(await s.admit(SOURCE, at(150))).toBe('DENY'); // 29s depois: cooldown ainda não venceu
    expect(await s.admit(SOURCE, at(181))).toBe('PROBE'); // 60s depois da reabertura
  });

  it('respeita o mínimo de amostra do escopo de agente', async () => {
    const s = new CircuitBreakerStore(pool, () => ({ ...POLICY, minSample: 5 }));
    await failTimes(s, AGENT, 3);
    expect((await s.state(AGENT)).status).toBe('CLOSED'); // 3 falhas, mas só 3 desfechos
    await failTimes(s, AGENT, 2, 3);
    expect((await s.state(AGENT)).status).toBe('OPEN');
  });

  it('o estado sobrevive a um novo store (restart): vem do banco, não da memória', async () => {
    await failTimes(store(), SOURCE, 3);
    expect((await store().state(SOURCE)).status).toBe('OPEN');
  });

  it('é append-only: UPDATE e DELETE são recusados', async () => {
    await failTimes(store(), SOURCE, 1);
    await expect(pool.query(`UPDATE circuit_breaker_events SET event_type = 'CLOSED'`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM circuit_breaker_events`)).rejects.toThrow(/append-only/);
  });
});

describe('AutonomyController sobre o Postgres real', () => {
  it('o Stop engajado nega; liberado, permite; e o circuito aberto nega só o escopo dele', async () => {
    const governor = new Governor(loadConstitution());
    const breakers = new CircuitBreakerStore(pool, () => ({ failureThreshold: 1, cooldownMs: 600_000, minSample: 1 }));
    const controller = new AutonomyController({ governor, stop: stopReaderFor(pool), breakers });
    const stop = new EmergencyStopService(pool);
    const github: CircuitScope = { type: 'SOURCE', key: 'github' };

    expect(await controller.authorize({ origin: 'DIRECT', scopes: [github] })).toEqual({ allowed: true });

    await stop.engage('FOUNDER_CLI', 'teste');
    expect(await controller.authorize({ origin: 'DIRECT' })).toMatchObject({ allowed: false, gate: 'EMERGENCY_STOP' });
    await stop.release('FOUNDER_CLI', 'ok');
    expect(await controller.authorize({ origin: 'DIRECT' })).toEqual({ allowed: true });

    await breakers.recordOutcome(github, 'FAILURE', new Date());
    expect(await controller.authorize({ origin: 'DIRECT', scopes: [github] })).toMatchObject({ allowed: false, gate: 'CIRCUIT_OPEN' });
    expect(await controller.authorize({ origin: 'DIRECT', scopes: [{ type: 'AGENT', key: 'DESENVOLVEDOR-001' }] })).toEqual({ allowed: true });
  });

  it('com a autonomia desligada (o padrão da Constituição real), uma ação AGENDADA é negada e a DIRETA segue', async () => {
    const controller = new AutonomyController({
      governor: new Governor(loadConstitution()),
      stop: stopReaderFor(pool),
      breakers: new CircuitBreakerStore(pool, () => ({ failureThreshold: 5, cooldownMs: 1000, minSample: 1 })),
    });
    expect(await controller.authorize({ origin: 'SCHEDULED' })).toMatchObject({ allowed: false, gate: 'AUTONOMY_DISABLED' });
    expect(await controller.authorize({ origin: 'DIRECT' })).toEqual({ allowed: true });
  });
});
