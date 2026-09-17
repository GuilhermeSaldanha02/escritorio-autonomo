import { pino, type Logger } from 'pino';

export type { Logger };

/** Logger JSON estruturado. `service` identifica o processo em todo registro. */
export function createLogger(service: string, level: string = 'info'): Logger {
  return pino({
    level,
    base: { service, pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['*.password', '*.token', '*.apiKey', '*.secret', 'DATABASE_URL', 'REDIS_URL'],
      censor: '[REDACTED]',
    },
  });
}

/** Extrai uma mensagem segura de um valor lançado, sem perder o tipo do erro. */
export function describeError(error: unknown): { name: string; message: string; code?: string } {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return typeof code === 'string'
      ? { name: error.name, message: error.message, code }
      : { name: error.name, message: error.message };
  }
  return { name: 'UnknownError', message: String(error) };
}
