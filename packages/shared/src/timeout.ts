export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} não respondeu em ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

/** Rejeita se a promessa não resolver no prazo. Não cancela a operação original. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
