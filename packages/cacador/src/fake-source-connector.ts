import type { SourceConnector, SourceDiscoveryResult } from './source-connector.js';

/**
 * Connector de testes (M4, critério 19 — Deterministic Discovery E2E). Devolve
 * uma sequência configurada de resultados, um por chamada de `discover()`; a
 * última entrada se repete se `discover()` for chamado mais vezes do que a
 * lista tem — assim um teste pode simular "primeira chamada dá 429, segunda
 * chamada (depois do backoff) dá os candidatos" sem se preocupar em prever
 * exatamente quantas vezes o código sob teste vai chamar.
 */
export class FakeSourceConnector implements SourceConnector {
  readonly source: string;
  #results: readonly SourceDiscoveryResult[];
  #callCount = 0;

  constructor(source: string, results: readonly SourceDiscoveryResult[]) {
    if (results.length === 0) throw new Error('FakeSourceConnector precisa de ao menos um resultado configurado');
    this.source = source;
    this.#results = results;
  }

  get callCount(): number {
    return this.#callCount;
  }

  async discover(): Promise<SourceDiscoveryResult> {
    const index = Math.min(this.#callCount, this.#results.length - 1);
    this.#callCount++;
    return this.#results[index]!;
  }
}
