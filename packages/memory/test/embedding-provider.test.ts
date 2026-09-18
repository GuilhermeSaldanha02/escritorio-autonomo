import { describe, expect, it } from 'vitest';
import { DeterministicEmbeddingProvider } from '../src/embedding-provider.js';

describe('DeterministicEmbeddingProvider', () => {
  it('mesma entrada sempre produz o mesmo vetor', () => {
    const provider = new DeterministicEmbeddingProvider();
    const a = provider.embed('corrigir bug no parser');
    const b = provider.embed('corrigir bug no parser');
    expect(a.vector).toEqual(b.vector);
  });

  it('entradas diferentes produzem vetores diferentes', () => {
    const provider = new DeterministicEmbeddingProvider();
    const a = provider.embed('corrigir bug no parser');
    const b = provider.embed('adicionar suporte a websocket');
    expect(a.vector).not.toEqual(b.vector);
  });

  it('vetor tem a dimensão declarada pelo provider', () => {
    const provider = new DeterministicEmbeddingProvider();
    const result = provider.embed('qualquer texto');
    expect(result.vector).toHaveLength(provider.dimensions);
    expect(result.dimensions).toBe(provider.dimensions);
  });

  it('vetor é normalizado (magnitude ~1)', () => {
    const provider = new DeterministicEmbeddingProvider();
    const { vector } = provider.embed('qualquer texto não vazio');
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1, 5);
  });

  it('identifica proveniência (provider/model/version) em todo resultado', () => {
    const provider = new DeterministicEmbeddingProvider();
    const result = provider.embed('texto');
    expect(result.provider).toBe('deterministic');
    expect(result.model).toBe(provider.model);
    expect(result.version).toBe(provider.version);
  });
});
