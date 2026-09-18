export class SsrfBlockedError extends Error {
  constructor(
    readonly url: string,
    readonly reason: string,
  ) {
    super(`Requisição bloqueada (SSRF): ${url} — ${reason}`);
    this.name = 'SsrfBlockedError';
  }
}

export class TooManyRedirectsError extends Error {
  constructor(readonly url: string) {
    super(`Excedeu o limite de redirects a partir de: ${url}`);
    this.name = 'TooManyRedirectsError';
  }
}

export class ResponseTooLargeError extends Error {
  constructor(
    readonly url: string,
    readonly maxBytes: number,
  ) {
    super(`Resposta de ${url} excedeu o limite de ${maxBytes} bytes`);
    this.name = 'ResponseTooLargeError';
  }
}
