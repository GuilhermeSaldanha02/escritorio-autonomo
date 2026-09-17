import type { Queue } from 'bullmq';
import { type Pool, type Queryable, withTransaction } from '@escritorio/database';
import { describeError, type Logger, withTimeout } from '@escritorio/shared';

export interface OutboxEntry {
  eventId: string;
  queue: string;
  jobName: string;
  jobId: string;
  payload: Record<string, unknown>;
  jobAttempts: number;
  /**
   * Espera antes de o dispatcher publicar (ex.: reagendar `develop-task`
   * quando o Governor não tem slot — revisão externa do M2). `available_at`
   * já existia para o backoff de falha de publicação; aqui é o mesmo campo
   * usado para atraso deliberado desde a criação da linha.
   */
  delayMs?: number;
}

/** Grava o pedido de job. Mesmo `jobId` duas vezes é ignorado: nunca duplica. */
export async function enqueueInOutbox(tx: Queryable, entry: OutboxEntry): Promise<void> {
  await tx.query(
    `INSERT INTO outbox (event_id, queue, job_name, job_id, payload, job_attempts, available_at)
     VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp() + make_interval(secs => $7::double precision / 1000))
     ON CONFLICT (job_id) DO NOTHING`,
    [
      entry.eventId,
      entry.queue,
      entry.jobName,
      entry.jobId,
      JSON.stringify(entry.payload),
      entry.jobAttempts,
      entry.delayMs ?? 0,
    ],
  );
}

interface PendingRow {
  id: string;
  queue: string;
  job_name: string;
  job_id: string;
  payload: Record<string, unknown>;
  job_attempts: number;
  dispatch_attempts: number;
}

export interface DispatchReport {
  dispatched: number;
  failed: number;
}

export interface OutboxDispatcherOptions {
  pool: Pool;
  /** Filas conhecidas pelo nome. Pedido para fila desconhecida fica pendente com erro registrado. */
  queues: ReadonlyMap<string, Pick<Queue, 'add'>>;
  logger: Logger;
  batchSize?: number;
  pollIntervalMs?: number;
  maxBackoffMs?: number;
  /**
   * Prazo de cada publicação. Obrigatório na prática: com o Redis fora, o
   * `queue.add` do BullMQ espera a conexão indefinidamente em vez de falhar.
   */
  publishTimeoutMs?: number;
}

/**
 * Publica no BullMQ os jobs pendentes do outbox.
 *
 * - `FOR UPDATE SKIP LOCKED`: dois dispatchers nunca publicam a mesma linha ao mesmo tempo.
 * - Falha ou demora ao publicar (Redis fora): registra o erro e reagenda com
 *   backoff exponencial. Sem o prazo, o BullMQ esperaria a conexão para sempre
 *   segurando a transação e os locks das linhas.
 * - Queda entre publicar e marcar como publicado: a linha é republicada com o
 *   mesmo `jobId`, e o BullMQ devolve o job existente em vez de criar outro
 *   (enquanto ele estiver retido — ver `removeOnComplete`/`removeOnFail`).
 */
export class OutboxDispatcher {
  readonly #pool: Pool;
  readonly #queues: ReadonlyMap<string, Pick<Queue, 'add'>>;
  readonly #logger: Logger;
  readonly #batchSize: number;
  readonly #pollIntervalMs: number;
  readonly #maxBackoffMs: number;
  readonly #publishTimeoutMs: number;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #stopped = true;

  constructor(options: OutboxDispatcherOptions) {
    this.#pool = options.pool;
    this.#queues = options.queues;
    this.#logger = options.logger;
    this.#batchSize = options.batchSize ?? 50;
    this.#pollIntervalMs = options.pollIntervalMs ?? 250;
    this.#maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.#publishTimeoutMs = options.publishTimeoutMs ?? 5_000;
  }

  /** Um lote. Público para testes e para quem quiser drenar sob demanda. */
  async dispatchPending(): Promise<DispatchReport> {
    return withTransaction(this.#pool, async (tx) => {
      const { rows } = await tx.query<PendingRow>(
        `SELECT id, queue, job_name, job_id, payload, job_attempts, dispatch_attempts
           FROM outbox
          WHERE dispatched_at IS NULL AND available_at <= now()
          ORDER BY available_at, created_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [this.#batchSize],
      );

      // Nas escritas abaixo, clock_timestamp() e não now(): now() é o início da
      // transação, e o backoff contado a partir dele nasceria vencido.
      const report: DispatchReport = { dispatched: 0, failed: 0 };
      for (const row of rows) {
        try {
          const queue = this.#queues.get(row.queue);
          if (!queue) throw new Error(`Fila desconhecida: ${row.queue}`);
          await withTimeout(
            queue.add(row.job_name, row.payload, {
              jobId: row.job_id,
              attempts: row.job_attempts,
              backoff: { type: 'exponential', delay: 1_000 },
              removeOnComplete: { count: 1_000 },
              removeOnFail: { count: 5_000 },
            }),
            this.#publishTimeoutMs,
            `publicação do job ${row.job_id}`,
          );
          await tx.query(
            `UPDATE outbox SET dispatched_at = clock_timestamp(), dispatch_attempts = dispatch_attempts + 1, last_error = NULL
              WHERE id = $1`,
            [row.id],
          );
          report.dispatched += 1;
        } catch (error) {
          const backoffMs = Math.min(this.#maxBackoffMs, 500 * 2 ** row.dispatch_attempts);
          const { name, message } = describeError(error);
          await tx.query(
            `UPDATE outbox
                SET dispatch_attempts = dispatch_attempts + 1,
                    available_at = clock_timestamp() + make_interval(secs => $2::double precision / 1000),
                    last_error = $3
              WHERE id = $1`,
            [row.id, backoffMs, `${name}: ${message}`.slice(0, 500)],
          );
          report.failed += 1;
          this.#logger.warn(
            { outboxId: row.id, jobId: row.job_id, queue: row.queue, backoffMs, err: describeError(error) },
            'falha ao publicar job do outbox; reagendado',
          );
        }
      }
      return report;
    });
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#schedule(0);
  }

  /** Para de agendar e espera o lote em andamento terminar. */
  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    await this.#running;
  }

  #schedule(delayMs: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#running = this.#tick();
    }, delayMs);
  }

  async #tick(): Promise<void> {
    let fullBatch = false;
    try {
      const report = await this.dispatchPending();
      fullBatch = report.dispatched + report.failed >= this.#batchSize;
    } catch (error) {
      this.#logger.error({ err: describeError(error) }, 'dispatcher do outbox não conseguiu ler pendentes');
    }
    // Lote cheio: provavelmente há mais pendentes, segue sem esperar.
    this.#schedule(fullBatch ? 0 : this.#pollIntervalMs);
  }
}
