import { describe, expect, it } from 'vitest';
import { normalizeCandidate } from '../src/normalizer.js';
import { makeRawCandidate } from '../src/source-connector.js';

function candidate(rawContent: string) {
  return makeRawCandidate({ source: 'algora', externalId: '1', url: 'https://algora.io/bounty/1', rawContent });
}

describe('normalizeCandidate', () => {
  it('separa rawExternalContent de normalizedContent e preserva o rawHash original', () => {
    const raw = candidate('  Corrija o bug no parser.  ');
    const result = normalizeCandidate(raw);

    expect(result.status).toBe('OK');
    expect(result.rawExternalContent).toBe('  Corrija o bug no parser.  ');
    expect(result.normalizedContent).toBe('Corrija o bug no parser.');
    expect(result.rawHash).toBe(raw.rawHash);
    expect(result.trustLevel).toBe('UNTRUSTED_EXTERNAL');
  });

  it('remove caracteres de controle do conteúdo normalizado, mas preserva quebras de linha e tabs', () => {
    const raw = candidate('linha 1\nlinha 2\tcom tab\u0007e sino de terminal\u0000nulo');
    const result = normalizeCandidate(raw);

    expect(result.normalizedContent).toBe('linha 1\nlinha 2\tcom tabe sino de terminalnulo');
  });

  it('marca SOURCE_PAYLOAD_TOO_LARGE quando o conteúdo bruto excede o limite configurado, e trunca em vez de lançar', () => {
    const raw = candidate('a'.repeat(1000));
    const result = normalizeCandidate(raw, { maxRawContentBytes: 100 });

    expect(result.status).toBe('SOURCE_PAYLOAD_TOO_LARGE');
    expect(Buffer.byteLength(result.rawExternalContent, 'utf8')).toBe(100);
    expect(result.rawHash).toBe(raw.rawHash); // hash do conteúdo completo, não do truncado
  });

  it('marca SOURCE_PAYLOAD_TOO_LARGE quando só o conteúdo normalizado excede seu próprio limite', () => {
    const raw = candidate('b'.repeat(1000));
    const result = normalizeCandidate(raw, { maxRawContentBytes: 100_000, maxNormalizedContentBytes: 50 });

    expect(result.status).toBe('SOURCE_PAYLOAD_TOO_LARGE');
    expect(Buffer.byteLength(result.normalizedContent, 'utf8')).toBe(50);
  });

  it('propaga SOURCE_PAYLOAD_TOO_LARGE quando o próprio RawCandidate já veio truncated do connector', () => {
    const raw = { ...candidate('conteúdo curto'), truncated: true };
    const result = normalizeCandidate(raw);
    expect(result.status).toBe('SOURCE_PAYLOAD_TOO_LARGE');
  });

  it('não corta nada quando o conteúdo está dentro dos limites', () => {
    const raw = candidate('conteúdo pequeno');
    const result = normalizeCandidate(raw, { maxRawContentBytes: 10_000, maxNormalizedContentBytes: 10_000 });
    expect(result.status).toBe('OK');
    expect(result.normalizedContent).toBe('conteúdo pequeno');
  });
});
