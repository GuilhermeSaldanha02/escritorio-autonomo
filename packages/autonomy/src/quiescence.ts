import type { Queryable } from '@escritorio/database';
import { EventStore } from '@escritorio/events';
import type { StopState } from './emergency-stop.js';

export interface QuiescenceGuardDeps {
  /** Só para registrar o evento. Uma transação de banco NUNCA passa por este guard: nunca é interrompida no meio. */
  db: Queryable;
  stop: { read(): Promise<StopState> };
  /** `EMERGENCY_QUIESCENCE_TIMEOUT_SECONDS` em ms: o período de graça depois do ENGAGE. */
  timeoutMs: number;
  /** De quanto em quanto tempo o estado do Stop é relido enquanto a operação roda. */
  pollMs?: number;
  now?: () => Date;
}

export interface QuiescenceOptions {
  /** Nome curto da operação, para o evento (ex.: `SANDBOX_RUN`). */
  operation: string;
  /**
   * `true`: a operação observa o `AbortSignal` e se encerra de forma controlada.
   * `false`: não dá para cancelar; passado o prazo ela termina sozinha, mas o resultado é DESCARTADO.
   */
  cancelable: boolean;
}

export type QuiescenceResult<T> =
  | { status: 'COMPLETED'; value: T }
  /** Passou do prazo depois do Stop. Nunca há valor: quem chamou não pode progredir com o que a operação produziu. */
  | { status: 'EXCEEDED'; action: 'ABORTED' | 'PROGRESS_BLOCKED' };

/**
 * Quiescência com prazo máximo (M6-PLANO.md, critério 8). Depois do ENGAGE, uma operação em
 * andamento tem `timeoutMs` para terminar o passo atual. Vencido o prazo:
 *
 *  - cancelável: o `AbortSignal` dispara e a operação se encerra de forma controlada
 *    (a sandbox mata e remove o container);
 *  - não cancelável: ela termina sozinha, é registrada como "ultrapassou a quiescência" e o
 *    resultado é descartado, então nenhum progresso posterior acontece.
 *
 * Não é falha: quem recebe `EXCEEDED` trata como pausa (o trabalho é retomado no RELEASE).
 */
export class QuiescenceGuard {
  constructor(private readonly deps: QuiescenceGuardDeps) {}

  async run<T>(operation: (signal: AbortSignal) => Promise<T>, options: QuiescenceOptions): Promise<QuiescenceResult<T>> {
    const { stop, timeoutMs, pollMs = 1000, now = () => new Date() } = this.deps;
    const controller = new AbortController();
    let exceededSince: Date | undefined;

    const check = async (): Promise<void> => {
      if (exceededSince) return;
      const state = await stop.read();
      // ILEGÍVEL não aborta nada: matar trabalho por um soluço do banco seria pior que esperar o próximo poll.
      if (state.status !== 'ENGAGED') return;
      if (now().getTime() - state.since.getTime() < timeoutMs) return;
      exceededSince = state.since;
      if (options.cancelable) controller.abort();
    };

    const timer = setInterval(() => void check().catch(() => undefined), pollMs);
    try {
      let value: T | undefined;
      try {
        value = await operation(controller.signal);
      } catch (error) {
        // Um aborto que o próprio guard provocou não é erro da operação.
        if (!exceededSince) throw error;
      }
      // Última leitura: uma operação curta pode terminar entre dois polls, já depois do prazo.
      await check().catch(() => undefined);
      if (!exceededSince) return { status: 'COMPLETED', value: value as T };

      const action = options.cancelable ? 'ABORTED' : 'PROGRESS_BLOCKED';
      await new EventStore(this.deps.db).append({
        type: 'EMERGENCY_QUIESCENCE_EXCEEDED',
        payload: { operation: options.operation, action, stopSince: exceededSince.toISOString(), timeoutMs },
        idempotencyKey: `quiescence-exceeded:${options.operation}:${exceededSince.getTime()}:${crypto.randomUUID()}`,
      });
      return { status: 'EXCEEDED', action };
    } finally {
      clearInterval(timer);
    }
  }
}
