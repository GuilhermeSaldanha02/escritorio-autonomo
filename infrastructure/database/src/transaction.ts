import type { Pool, PoolClient } from './pool.js';

/**
 * Executa `work` numa transação: COMMIT se resolver, ROLLBACK se lançar.
 * O erro original sobe intacto; uma falha no próprio ROLLBACK não o esconde.
 */
export async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch((rollbackError: unknown) => {
        throw new AggregateError([error, rollbackError], 'Falha na transação e no ROLLBACK');
      });
      throw error;
    }
  } finally {
    client.release();
  }
}
