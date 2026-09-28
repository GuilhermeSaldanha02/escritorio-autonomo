import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from '@escritorio/database';
import type { Logger } from '@escritorio/shared';
import { OutboxDispatcher, type DispatchReport } from '../src/outbox.js';

const empty: DispatchReport = { dispatched: 0, failed: 0 };
const unavailable = (code: string) => Object.assign(new Error('PostgreSQL indisponível'), { code });
const dispatchers: OutboxDispatcher[] = [];

function started(results: Array<DispatchReport | Error> = []) {
  const error = vi.fn();
  const dispatcher = new OutboxDispatcher({
    pool: {} as Pool,
    queues: new Map(),
    logger: { error } as unknown as Logger,
  });
  const dispatch = vi.spyOn(dispatcher, 'dispatchPending').mockImplementation(async () => {
    const result = results.shift() ?? empty;
    if (result instanceof Error) throw result;
    return result;
  });
  dispatchers.push(dispatcher);
  dispatcher.start();
  return { dispatcher, dispatch, error };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});

afterEach(async () => {
  await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.stop()));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('OutboxDispatcher: retry de infraestrutura', () => {
  it('mantém polling saudável de 250 ms e lote cheio sem espera', async () => {
    const { dispatch } = started([empty, { dispatched: 50, failed: 0 }, empty]);
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(dispatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(dispatch).toHaveBeenCalledTimes(2);
    // Fake timers executam um setTimeout(0) aninhado no próximo milissegundo.
    await vi.advanceTimersByTimeAsync(1);
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it('aumenta a espera a cada falha transitória e respeita o teto', async () => {
    const { dispatch, error } = started(Array.from({ length: 9 }, () => unavailable('ECONNREFUSED')));
    await vi.advanceTimersByTimeAsync(0);
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      const calls = dispatch.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(dispatch).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(1);
      expect(dispatch).toHaveBeenCalledTimes(calls + 1);
    }
    expect(error).toHaveBeenCalledTimes(8);
  });

  it('dispersa as tentativas entre instâncias sem ultrapassar o teto', async () => {
    vi.mocked(Math.random).mockReturnValueOnce(0).mockReturnValueOnce(1);
    const { dispatch } = started([unavailable('ECONNRESET'), unavailable('ECONNRESET'), empty]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(749);
    expect(dispatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(dispatch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_499);
    expect(dispatch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it('reseta o backoff após sucesso e volta ao polling normal', async () => {
    const { dispatch } = started([unavailable('ECONNREFUSED'), empty, unavailable('ECONNREFUSED'), empty]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(dispatch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(249);
    expect(dispatch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(dispatch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(999);
    expect(dispatch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(dispatch).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['startup PostgreSQL', unavailable('57P03')],
    ['SQLSTATE de conexão', unavailable('08006')],
    ['conexão encerrada sem código', new Error('Connection terminated unexpectedly')],
    ['timeout de conexão sem código', new Error('Connection terminated due to connection timeout')],
    ['client não consultável', new Error('Client has encountered a connection error and is not queryable')],
  ])('trata %s como indisponibilidade transitória', async (_label, failure) => {
    const { dispatch, error } = started([failure, empty]);
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ nextRetryMs: 1_000 }),
      'dispatcher do outbox não conseguiu ler pendentes',
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(dispatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('mantém falhas não transitórias visíveis sem confundi-las com queda de infraestrutura', async () => {
    const { dispatch, error } = started([new TypeError('erro de programação'), empty]);
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ nextRetryMs: 250 }),
      'dispatcher do outbox não conseguiu ler pendentes',
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('não sobrepõe ticks enquanto uma tentativa ainda está em andamento', async () => {
    let finish!: (report: DispatchReport) => void;
    const pending = new Promise<DispatchReport>((resolve) => { finish = resolve; });
    const { dispatcher, dispatch } = started();
    dispatch.mockImplementationOnce(() => pending);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dispatch).toHaveBeenCalledTimes(1);
    finish(empty);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(250);
    expect(dispatch).toHaveBeenCalledTimes(2);
    await dispatcher.stop();
  });

  it('stop durante backoff cancela a tentativa seguinte', async () => {
    const { dispatcher, dispatch } = started([unavailable('57P03'), empty]);
    await vi.advanceTimersByTimeAsync(0);
    await dispatcher.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
