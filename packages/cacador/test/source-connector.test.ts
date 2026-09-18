import { describe, expect, it } from 'vitest';
import { FakeSourceConnector } from '../src/fake-source-connector.js';
import { sha256Hex } from '../src/hash.js';
import { makeRawCandidate } from '../src/source-connector.js';

describe('makeRawCandidate', () => {
  it('calcula o hash sha256 do conteúdo bruto e marca trustLevel/truncated por padrão', () => {
    const candidate = makeRawCandidate({
      source: 'algora',
      externalId: 'bounty-1',
      url: 'https://algora.io/bounty/1',
      rawContent: 'conteúdo bruto de exemplo',
    });

    expect(candidate.rawHash).toBe(sha256Hex('conteúdo bruto de exemplo'));
    expect(candidate.trustLevel).toBe('UNTRUSTED_EXTERNAL');
    expect(candidate.truncated).toBe(false);
  });

  it('calcula rawHash mesmo quando truncated é true — o rastro de auditoria não se perde', () => {
    const full = 'x'.repeat(10_000);
    const truncatedContent = full.slice(0, 100);
    const candidate = makeRawCandidate({
      source: 'algora',
      externalId: 'bounty-2',
      url: 'https://algora.io/bounty/2',
      rawContent: truncatedContent,
      truncated: true,
    });

    expect(candidate.truncated).toBe(true);
    expect(candidate.rawHash).toBe(sha256Hex(truncatedContent));
  });

  it('rawHash muda quando o conteúdo muda — não é um hash constante disfarçado', () => {
    const a = makeRawCandidate({ source: 'algora', externalId: '1', url: 'u', rawContent: 'a' });
    const b = makeRawCandidate({ source: 'algora', externalId: '1', url: 'u', rawContent: 'b' });
    expect(a.rawHash).not.toBe(b.rawHash);
  });
});

describe('FakeSourceConnector', () => {
  it('exige ao menos um resultado configurado', () => {
    expect(() => new FakeSourceConnector('algora', [])).toThrow();
  });

  it('devolve os resultados na ordem configurada e repete o último depois de esgotar a lista', async () => {
    const okResult = { status: 'OK' as const, candidates: [] };
    const rateLimited = { status: 'SOURCE_RATE_LIMITED' as const, candidates: [], retryAfterMs: 5_000 };
    const connector = new FakeSourceConnector('algora', [rateLimited, okResult]);

    await expect(connector.discover()).resolves.toEqual(rateLimited);
    await expect(connector.discover()).resolves.toEqual(okResult);
    await expect(connector.discover()).resolves.toEqual(okResult); // repete o último, não estoura
    expect(connector.callCount).toBe(3);
  });

  it('expõe o source configurado', () => {
    const connector = new FakeSourceConnector('algora', [{ status: 'OK', candidates: [] }]);
    expect(connector.source).toBe('algora');
  });
});
