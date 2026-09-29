import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createPool, type PoolClient } from '../src/pool.js';
import type { Logger } from '@escritorio/shared';

function setup() {
  const error = vi.fn();
  const logger = { error } as unknown as Logger;
  const pool = createPool('postgres://unused:unused@127.0.0.1:1/unused', logger, 'pool-error-test');
  const client = new EventEmitter() as PoolClient;
  return { pool, client, error };
}

describe('pg.Pool: erros de conexão', () => {
  it('registra erro do client em uso sem Unhandled error e mantém o pool para novas aquisições', async () => {
    const { pool, client, error } = setup();
    pool.emit('connect', client);
    pool.emit('acquire', client);
    expect(() => client.emit('error', Object.assign(new Error('conexão perdida'), { code: '57P01' }))).not.toThrow();
    expect(error).toHaveBeenCalledWith(
      { err: { name: 'Error', message: 'conexão perdida', code: '57P01' } },
      'erro em conexão ativa do PostgreSQL',
    );
    pool.emit('release', undefined, client);
    expect(client.listenerCount('error')).toBe(0);

    const recovered = new EventEmitter() as PoolClient;
    pool.emit('connect', recovered);
    pool.emit('acquire', recovered);
    expect(() => recovered.emit('error', new Error('nova interrupção'))).not.toThrow();
    expect(error).toHaveBeenCalledTimes(2);
    pool.emit('release', undefined, recovered);
    await pool.end();
  });

  it('mantém o tratamento de conexão ociosa pelo pool, sem listener ativo residual', async () => {
    const { pool, client, error } = setup();
    pool.emit('connect', client);
    pool.emit('acquire', client);
    pool.emit('release', undefined, client);
    pool.emit('error', Object.assign(new Error('idle reset'), { code: 'ECONNRESET' }), client);
    expect(error).toHaveBeenCalledWith(
      { err: { name: 'Error', message: 'idle reset', code: 'ECONNRESET' } },
      'erro em conexão ociosa do PostgreSQL',
    );
    expect(error).toHaveBeenCalledTimes(1);
    await pool.end();
  });
});
