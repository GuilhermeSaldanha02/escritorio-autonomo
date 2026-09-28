import pg from 'pg';
import { describeError, type Logger } from '@escritorio/shared';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
/** Qualquer coisa que execute SQL: o pool ou um client dentro de transação. */
export type Queryable = Pick<pg.Pool, 'query'>;

export function createPool(connectionString: string, logger: Logger, applicationName: string): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    application_name: applicationName,
    // Pool pequeno de propósito: M1 roda numa máquina local de 8 GB.
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
  });
  // Sem este handler, a queda de uma conexão ociosa derruba o processo.
  pool.on('error', (error) => {
    logger.error({ err: describeError(error) }, 'erro em conexão ociosa do PostgreSQL');
  });
  // pg-pool remove seu listener de erro enquanto o client está adquirido.
  // Um erro assíncrono nesse intervalo precisa de um listener no próprio client;
  // a query/transação ainda rejeita normalmente e o pool descarta a conexão ruim.
  const onActiveError = (error: Error) => {
    logger.error({ err: describeError(error) }, 'erro em conexão ativa do PostgreSQL');
  };
  pool.on('acquire', (client) => client.on('error', onActiveError));
  pool.on('release', (_error, client) => client.removeListener('error', onActiveError));
  return pool;
}
