import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AutonomyController, CircuitBreakerStore, EmergencyStopService, QuiescenceGuard, type StopState, stopReaderFor } from '@escritorio/autonomy';
import { type Pool, seedInitialAgents } from '@escritorio/database';
import { Governor, loadConstitution } from '@escritorio/governor';
import { ToolGateway } from '@escritorio/tool-gateway';
import { createDockerClient, SANDBOX_NAME_PREFIX, SandboxManager } from '@escritorio/tools';
import { createTestPool, logger, resetDatabase } from './support.js';

/**
 * Critério 8 do M6: quiescência com PRAZO. Depois do ENGAGE a operação em curso tem um período
 * de graça; vencido, o que é cancelável é encerrado de forma controlada e o que não é tem o
 * resultado descartado. Nada disso é falha. Postgres e Docker reais.
 */
const governor = new Governor(loadConstitution());
let pool: Pool;
let stop: EmergencyStopService;

beforeAll(() => {
  pool = createTestPool();
});
beforeEach(async () => {
  await resetDatabase(pool);
  await seedInitialAgents(pool);
  stop = new EmergencyStopService(pool);
});
afterAll(async () => {
  await pool.end();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const guard = (timeoutMs: number, reader = stopReaderFor(pool)) => new QuiescenceGuard({ db: pool, stop: reader, timeoutMs, pollMs: 40 });

async function exceededEvents(): Promise<Array<{ operation: string; action: string }>> {
  const { rows } = await pool.query<{ payload: { operation: string; action: string } }>(`SELECT payload FROM events WHERE type = 'EMERGENCY_QUIESCENCE_EXCEEDED'`);
  return rows.map((r) => ({ operation: r.payload.operation, action: r.payload.action }));
}

describe('QuiescenceGuard', () => {
  it('sem Stop, a operação completa e nada é registrado', async () => {
    const result = await guard(100).run(async () => 'ok', { operation: 'TESTE', cancelable: true });
    expect(result).toEqual({ status: 'COMPLETED', value: 'ok' });
    expect(await exceededEvents()).toEqual([]);
  });

  it('DENTRO do período de graça o Stop sozinho não aborta: a operação termina o passo atual', async () => {
    const running = guard(5_000).run(async () => { await sleep(300); return 'terminou'; }, { operation: 'TESTE', cancelable: true });
    await stop.engage('FOUNDER_CLI', 'incidente');
    expect(await running).toEqual({ status: 'COMPLETED', value: 'terminou' });
    expect(await exceededEvents()).toEqual([]);
  });

  it('cancelável: vencido o prazo o sinal dispara e a operação é encerrada (ABORTED)', async () => {
    let sawAbort = false;
    const started = Date.now();
    const running = guard(200).run(
      (signal) => new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => { sawAbort = true; reject(new Error('abortado')); });
      }),
      { operation: 'TESTE', cancelable: true },
    );
    await stop.engage('FOUNDER_CLI', 'incidente');
    expect(await running).toEqual({ status: 'EXCEEDED', action: 'ABORTED' });
    expect(sawAbort).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await exceededEvents()).toEqual([{ operation: 'TESTE', action: 'ABORTED' }]);
  });

  it('NÃO cancelável: termina sozinha, mas o resultado é descartado e o evento diz PROGRESS_BLOCKED', async () => {
    let finished = false;
    const running = guard(150).run(async () => { await sleep(700); finished = true; return 'não pode progredir'; }, { operation: 'TESTE_NC', cancelable: false });
    await stop.engage('FOUNDER_CLI', 'incidente');
    const result = await running;
    expect(finished).toBe(true); // a operação não foi interrompida
    expect(result).toEqual({ status: 'EXCEEDED', action: 'PROGRESS_BLOCKED' }); // e o valor nunca chega a quem chamou
    expect(await exceededEvents()).toEqual([{ operation: 'TESTE_NC', action: 'PROGRESS_BLOCKED' }]);
  });

  it('estado do Stop ILEGÍVEL não aborta nada (um soluço do banco não mata trabalho)', async () => {
    const unreadable = { read: async (): Promise<StopState> => ({ status: 'UNVERIFIABLE', error: 'banco fora' }) };
    const result = await guard(50, unreadable).run(async () => { await sleep(300); return 'ok'; }, { operation: 'TESTE', cancelable: true });
    expect(result).toEqual({ status: 'COMPLETED', value: 'ok' });
  });

  it('um erro da própria operação, sem Stop, continua sendo erro', async () => {
    await expect(guard(100).run(async () => { throw new Error('falha de verdade'); }, { operation: 'TESTE', cancelable: true })).rejects.toThrow('falha de verdade');
  });
});

describe('Tool Gateway com prazo de quiescência (Docker real)', () => {
  it('Stop no meio de uma sandbox longa: encerrada de forma controlada, PAUSED, sem falha, sem container vazado', async () => {
    const docker = createDockerClient();
    const controller = new AutonomyController({
      governor,
      stop: stopReaderFor(pool),
      breakers: new CircuitBreakerStore(pool, () => ({ failureThreshold: 5, cooldownMs: 1000, minSample: 1 })),
    });
    const gateway = new ToolGateway({
      pool,
      governor,
      sandboxManager: new SandboxManager(docker, logger),
      logger,
      autonomy: controller,
      quiescence: guard(300),
    });

    const started = Date.now();
    const running = gateway.execute({
      agentId: 'DESENVOLVEDOR-001',
      correlationId: crypto.randomUUID(),
      tool: 'CODE_EXECUTION',
      payload: { command: ['sleep', '60'], limits: { timeoutMs: 60_000 } },
    });
    await sleep(1_500); // o container já está de pé
    await stop.engage('FOUNDER_CLI', 'incidente');
    const outcome = await running;

    expect(outcome.status).toBe('PAUSED');
    expect(outcome.pauseGate).toBe('EMERGENCY_STOP');
    expect(Date.now() - started).toBeLessThan(20_000); // muito antes dos 60 s da sandbox
    const { rows } = await pool.query<{ status: string }>('SELECT status FROM tool_calls');
    expect(rows.map((r) => r.status)).toEqual(['PAUSED']);
    expect(await exceededEvents()).toEqual([{ operation: 'SANDBOX_RUN', action: 'ABORTED' }]);

    const leaked = (await docker.listContainers({ all: true })).filter((c) => c.Names.some((n) => n.replace(/^\//, '').startsWith(SANDBOX_NAME_PREFIX)));
    expect(leaked).toEqual([]);
    const { rows: reservations } = await pool.query<{ status: string }>(`SELECT status FROM budget_reservations WHERE status = 'RESERVED'`);
    expect(reservations).toEqual([]);
  }, 60_000);
});
