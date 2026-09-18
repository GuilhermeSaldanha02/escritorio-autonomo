import { createHash } from 'node:crypto';

export interface EmbeddingResult {
  vector: readonly number[];
  provider: string;
  model: string;
  version: string;
  dimensions: number;
}

export interface EmbeddingProvider {
  readonly provider: string;
  readonly model: string;
  readonly version: string;
  readonly dimensions: number;
  embed(text: string): EmbeddingResult;
}

const DIMENSIONS = 32;

function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) return vector;
  return vector.map((value) => value / magnitude);
}

/**
 * Provider de embedding do M5 — nunca chama IA, nunca custa nada, nunca sai
 * para a rede. Mesma entrada sempre produz o mesmo vetor (hash SHA-256 do
 * texto, mapeado para `[-1, 1]` e normalizado).
 *
 * Ajuste 3 da revisão externa, registrado aqui de propósito: isto prova
 * armazenamento vetorial, compatibilidade dimensional, filtro de escopo e
 * recuperação top-K funcionando — **nunca** qualidade de recuperação
 * semântica. Um hash não entende significado. Busca semanticamente útil só
 * existe quando um `EmbeddingProvider` real (local ou de API) existir, fora
 * do M5.
 */
export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly provider = 'deterministic';
  readonly model = 'sha256-hash-v1';
  readonly version = '1';
  readonly dimensions = DIMENSIONS;

  embed(text: string): EmbeddingResult {
    const hash = createHash('sha256').update(text, 'utf8').digest();
    const raw: number[] = [];
    for (let i = 0; i < this.dimensions; i++) {
      const byte = hash[i % hash.length]!;
      raw.push((byte / 255) * 2 - 1);
    }
    return {
      vector: normalize(raw),
      provider: this.provider,
      model: this.model,
      version: this.version,
      dimensions: this.dimensions,
    };
  }
}
