import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createGracefulShutdown, createLogger, exitOnShutdownSignals, type ShutdownStep } from '@escritorio/shared';

const logger = createLogger('shutdown-test', 'silent');

function recordingSteps(calls: string[], overrides: Partial<Record<string, () => Promise<unknown>>> = {}): ShutdownStep[] {
  return ['worker', 'redis', 'postgres'].map((name) => ({
    name,
    close: async () => {
      calls.push(name);
      await overrides[name]?.();
    },
  }));
}

describe('createGracefulShutdown', () => {
  it('fecha as etapas em ordem: consumidor antes dos recursos', async () => {
    const calls: string[] = [];
    const shutdown = createGracefulShutdown({ logger, steps: recordingSteps(calls), timeoutMs: 1_000 });
    expect(await shutdown('SIGTERM')).toBe('clean');
    expect(calls).toEqual(['worker', 'redis', 'postgres']);
  });

  it('chamada repetida não fecha nada duas vezes', async () => {
    const calls: string[] = [];
    const shutdown = createGracefulShutdown({ logger, steps: recordingSteps(calls), timeoutMs: 1_000 });
    const [first, second] = await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
    expect([first, second]).toEqual(['clean', 'clean']);
    expect(await shutdown('SIGTERM')).toBe('clean');
    expect(calls).toEqual(['worker', 'redis', 'postgres']);
  });

  it('falha numa etapa não impede as seguintes', async () => {
    const calls: string[] = [];
    const steps = recordingSteps(calls, {
      redis: async () => {
        throw new Error('Connection is closed.');
      },
    });
    const shutdown = createGracefulShutdown({ logger, steps, timeoutMs: 1_000 });
    expect(await shutdown('SIGTERM')).toBe('with-errors');
    expect(calls).toEqual(['worker', 'redis', 'postgres']);
  });

  it('desiste no prazo quando uma etapa pendura', async () => {
    const steps = recordingSteps([], { worker: () => new Promise(() => undefined) });
    const shutdown = createGracefulShutdown({ logger, steps, timeoutMs: 50 });
    expect(await shutdown('SIGTERM')).toBe('timed-out');
  });
});

describe('exitOnShutdownSignals', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)('%s encerra e sai com 0 quando limpo', async (signal) => {
    const source = new EventEmitter();
    const exit = vi.fn();
    const shutdown = vi.fn(async () => 'clean' as const);
    exitOnShutdownSignals(source, shutdown, exit, logger);

    source.emit(signal);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(shutdown).toHaveBeenCalledWith(signal);
  });

  it('sai com 1 quando o encerramento não foi limpo', async () => {
    const source = new EventEmitter();
    const exit = vi.fn();
    exitOnShutdownSignals(source, async () => 'timed-out', exit, logger);
    source.emit('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });

  it('segundo sinal durante o encerramento sai imediatamente com 1', () => {
    const source = new EventEmitter();
    const exit = vi.fn();
    const shutdown = vi.fn(() => new Promise<'clean'>(() => undefined));
    exitOnShutdownSignals(source, shutdown, exit, logger);

    source.emit('SIGTERM');
    expect(exit).not.toHaveBeenCalled();
    source.emit('SIGINT');
    expect(exit).toHaveBeenCalledWith(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
