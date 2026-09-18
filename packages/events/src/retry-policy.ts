/**
 * Política de retry do M6 (docs/M6-PLANO.md, critérios 13 e 14). NÃO é um novo
 * motor de retry: o que já existia (retry funcional do Revisor, `attempts` do
 * BullMQ, espera de slot) só ganha uma CLASSIFICAÇÃO para nunca se misturar.
 *
 *   BUSINESS_RETRY   falha funcional (o Revisor reprovou)     CONSOME MAX_TASK_RETRIES
 *   TECHNICAL_RETRY  falha de transporte ou infraestrutura    não consome
 *   CAPACITY_WAIT    sem slot para começar (TASK_WAITING_SLOT) não consome
 *   CIRCUIT_BLOCK    circuito aberto no escopo                não consome
 *   EMERGENCY_PAUSE  Emergency Stop engajado                  não consome
 *
 * Só o primeiro incrementa `tasks.retry_count`.
 */
export const RETRY_CLASSES = ['BUSINESS_RETRY', 'TECHNICAL_RETRY', 'CAPACITY_WAIT', 'CIRCUIT_BLOCK', 'EMERGENCY_PAUSE'] as const;
export type RetryClass = (typeof RETRY_CLASSES)[number];

export function consumesTaskRetry(retryClass: RetryClass): boolean {
  return retryClass === 'BUSINESS_RETRY';
}

export type RetryCause =
  | { kind: 'REVIEW_FAILED' }
  | { kind: 'SLOT_UNAVAILABLE' }
  /** Um portão de autonomia barrou o trabalho (nome do portão, ex.: `EMERGENCY_STOP`, `CIRCUIT_OPEN`). */
  | { kind: 'GATE'; gate: string }
  | { kind: 'ERROR'; error: unknown };

const CIRCUIT_GATES = new Set(['CIRCUIT_OPEN', 'CIRCUIT_UNVERIFIABLE']);

export function classifyRetry(cause: RetryCause): RetryClass {
  switch (cause.kind) {
    case 'REVIEW_FAILED':
      return 'BUSINESS_RETRY';
    case 'SLOT_UNAVAILABLE':
      return 'CAPACITY_WAIT';
    case 'GATE':
      // Emergency Stop, ilegível ou autonomia desligada são pausas globais; circuito é local ao escopo.
      return CIRCUIT_GATES.has(cause.gate) ? 'CIRCUIT_BLOCK' : 'EMERGENCY_PAUSE';
    case 'ERROR':
      return 'TECHNICAL_RETRY';
  }
}

/** Erros de programação: repetir não muda nada, então não são retentáveis. */
const PROGRAMMING_ERRORS = [TypeError, RangeError, ReferenceError, SyntaxError];
/** Marcados como irrecuperáveis pelo BullMQ ou pela validação de entrada: repetir só gasta tentativa. */
const NON_RETRYABLE_NAMES = new Set(['UnrecoverableError', 'ZodError']);

/**
 * Um erro técnico vale a pena repetir? Falha de rede, de conexão com o banco ou
 * de fila sim; erro de programação, de validação ou marcado como irrecuperável
 * não: repeti-los só gasta tentativa e atrasa o sinal. Erro desconhecido segue
 * retentável, que é o comportamento anterior ao M6 (a lista do que NÃO se repete
 * é fechada e pequena; a do que se repete não seria).
 */
export function isRetryableTechnicalError(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  if (NON_RETRYABLE_NAMES.has(error.name)) return false;
  return !PROGRAMMING_ERRORS.some((type) => error instanceof type);
}

/**
 * Backoff técnico dos jobs: exponencial a partir de 1s, com jitter de 50% para
 * várias falhas simultâneas não voltarem juntas. O teto prático é o número de
 * tentativas (`MAX_TASK_RETRIES + 1`, hoje 4, ou seja, atrasos de ~1s, 2s e 4s):
 * não há teto de tempo separado porque o limite de tentativas já o impõe.
 */
export const TECHNICAL_BACKOFF = { type: 'exponential', delay: 1_000, jitter: 0.5 } as const;
