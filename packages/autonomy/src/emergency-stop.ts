import { type Pool, type Queryable, withTransaction } from '@escritorio/database';
import { EventStore } from '@escritorio/events';

/**
 * Só uma autoridade humana aciona ou libera o Emergency Stop (M6-PLANO.md,
 * critério 5). Estes são os únicos atores que o serviço e o banco aceitam: a
 * CLI e a API do fundador. Nenhum agente, scheduler, breaker ou handler tem
 * um valor válido aqui.
 */
export const STOP_ACTORS = ['FOUNDER_CLI', 'FOUNDER_API'] as const;
export type StopActor = (typeof STOP_ACTORS)[number];

export class InvalidStopActorError extends Error {
  constructor(readonly actor: string) {
    super(`Ator "${actor}" não pode acionar nem liberar o Emergency Stop: só ${STOP_ACTORS.join(' ou ')}`);
    this.name = 'InvalidStopActorError';
  }
}

export type StopState =
  | { status: 'CLEAR' }
  | { status: 'ENGAGED'; since: Date; reason: string; actor: StopActor }
  /** Não foi possível ler o estado. Trata-se como parado: fail-safe, nunca fail-open. */
  | { status: 'UNVERIFIABLE'; error: string };

interface StopRow {
  kind: 'ENGAGED' | 'RELEASED';
  actor: StopActor;
  reason: string;
  occurred_at: Date;
}

/** Lê a última linha (a que vale), ordenada por `seq`, e lança se o banco falhar. */
async function queryLastStop(db: Queryable): Promise<StopRow | undefined> {
  const { rows } = await db.query<StopRow>(
    `SELECT kind, actor, reason, occurred_at FROM emergency_stop_events ORDER BY seq DESC LIMIT 1`,
  );
  return rows[0];
}

function toState(last: StopRow | undefined): StopState {
  if (!last || last.kind === 'RELEASED') return { status: 'CLEAR' };
  return { status: 'ENGAGED', since: last.occurred_at, reason: last.reason, actor: last.actor };
}

/**
 * Lê o estado do Emergency Stop e **nunca lança**: se o banco não responde,
 * devolve `UNVERIFIABLE`. Uma exceção subindo daqui seria confundida com uma
 * falha técnica retentável e o fail-safe viraria fail-open sem ninguém notar
 * (critério 7). Health, diagnóstico e leitura continuam possíveis de propósito.
 */
export async function readStopState(db: Queryable): Promise<StopState> {
  try {
    return toState(await queryLastStop(db));
  } catch (error) {
    return { status: 'UNVERIFIABLE', error: error instanceof Error ? error.message : String(error) };
  }
}

export type StopTransition = 'ENGAGED' | 'ALREADY_ENGAGED' | 'RELEASED' | 'NOT_ENGAGED';

const STOP_LOCK = 'emergency-stop';

/**
 * Único dono das regras do Emergency Stop. A CLI e a API do fundador são só
 * portas de entrada para este serviço; nenhuma escreve na tabela diretamente
 * (um teste de arquitetura garante que ninguém mais chama `engage`/`release`).
 */
export class EmergencyStopService {
  constructor(private readonly pool: Pool) {}

  engage(actor: StopActor, reason: string): Promise<StopTransition> {
    return this.#transition('ENGAGED', actor, reason);
  }

  release(actor: StopActor, reason: string): Promise<StopTransition> {
    return this.#transition('RELEASED', actor, reason);
  }

  state(): Promise<StopState> {
    return readStopState(this.pool);
  }

  async #transition(kind: 'ENGAGED' | 'RELEASED', actor: StopActor, reason: string): Promise<StopTransition> {
    if (!(STOP_ACTORS as readonly string[]).includes(actor)) throw new InvalidStopActorError(String(actor));
    const trimmed = reason.trim();
    if (trimmed.length === 0 || trimmed.length > 500) throw new RangeError('O motivo do Emergency Stop precisa ter de 1 a 500 caracteres');

    return withTransaction(this.pool, async (tx) => {
      // Serializa engage/release: "a última linha vale" precisa de uma ordem total.
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [STOP_LOCK]);
      const current = toState(await queryLastStop(tx));

      if (kind === 'ENGAGED' && current.status === 'ENGAGED') return 'ALREADY_ENGAGED';
      if (kind === 'RELEASED' && current.status !== 'ENGAGED') return 'NOT_ENGAGED';

      await tx.query(`INSERT INTO emergency_stop_events (kind, actor, reason) VALUES ($1, $2, $3)`, [kind, actor, trimmed]);
      await new EventStore(tx).append({
        type: kind === 'ENGAGED' ? 'EMERGENCY_STOP_ENGAGED' : 'EMERGENCY_STOP_RELEASED',
        payload: { actor, reason: trimmed },
      });
      return kind;
    });
  }
}
