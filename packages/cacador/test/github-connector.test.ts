import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SafeHttpClient } from '@escritorio/http-safe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitHubConnector } from '../src/github-connector.js';

let server: Server;
let baseUrl: string;
let requestLog: Array<{ url: string; userAgent: string | undefined }>;
let handler: (url: URL, res: import('node:http').ServerResponse) => void;

beforeEach(async () => {
  requestLog = [];
  handler = (_url, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ items: [] }));
  };
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requestLog.push({ url: url.pathname + url.search, userAgent: req.headers['user-agent'] });
    handler(url, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function connector(overrides: Partial<ConstructorParameters<typeof GitHubConnector>[0]> = {}): GitHubConnector {
  return new GitHubConnector({
    httpClient: new SafeHttpClient({ allowPrivateNetworks: true }),
    userAgent: 'escritorio-autonomo-cacador-test',
    baseUrl,
    queries: ['label:bounty is:issue is:open'],
    ...overrides,
  });
}

describe('GitHubConnector', () => {
  it('envia o header User-Agent exigido pela API do GitHub', async () => {
    await connector().discover();
    expect(requestLog[0]?.userAgent).toBe('escritorio-autonomo-cacador-test');
  });

  it('mapeia items da busca em RawCandidate com identidade e conteúdo bruto', async () => {
    handler = (_url, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          items: [
            {
              node_id: 'I_kwDOabc123',
              html_url: 'https://github.com/owner/repo/issues/42',
              updated_at: '2026-09-01T00:00:00Z',
              title: 'Corrigir bug',
            },
          ],
        }),
      );
    };
    const result = await connector().discover();
    expect(result.status).toBe('OK');
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0]!;
    expect(candidate.source).toBe('github');
    expect(candidate.externalId).toBe('I_kwDOabc123');
    expect(candidate.url).toBe('https://github.com/owner/repo/issues/42');
    expect(candidate.trustLevel).toBe('UNTRUSTED_EXTERNAL');
    expect(candidate.sourceUpdatedAt).toBe('2026-09-01T00:00:00Z');
    expect(JSON.parse(candidate.rawContent)).toMatchObject({ node_id: 'I_kwDOabc123', title: 'Corrigir bug' });
  });

  it('zero candidatos é OK, não erro — resultado válido (critério 18)', async () => {
    const result = await connector().discover();
    expect(result.status).toBe('OK');
    expect(result.candidates).toEqual([]);
  });

  it('403 com Retry-After vira SOURCE_RATE_LIMITED com o atraso em ms', async () => {
    handler = (_url, res) => {
      res.writeHead(403, { 'retry-after': '30' });
      res.end('rate limited');
    };
    const result = await connector().discover();
    expect(result.status).toBe('SOURCE_RATE_LIMITED');
    expect(result.retryAfterMs).toBe(30_000);
  });

  it('429 sem Retry-After mas com x-ratelimit-reset calcula o atraso a partir do epoch', async () => {
    const resetAt = Math.floor(Date.now() / 1000) + 45;
    handler = (_url, res) => {
      res.writeHead(429, { 'x-ratelimit-reset': String(resetAt) });
      res.end('rate limited');
    };
    const result = await connector().discover();
    expect(result.status).toBe('SOURCE_RATE_LIMITED');
    expect(result.retryAfterMs).toBeGreaterThan(40_000);
    expect(result.retryAfterMs).toBeLessThanOrEqual(45_000);
  });

  it('status inesperado (500) vira SOURCE_UNAVAILABLE, não lança', async () => {
    handler = (_url, res) => {
      res.writeHead(500);
      res.end('erro interno');
    };
    const result = await connector().discover();
    expect(result.status).toBe('SOURCE_UNAVAILABLE');
  });

  it('JSON inválido vira SOURCE_SCHEMA_DRIFT, não lança', async () => {
    handler = (_url, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('isto não é JSON');
    };
    const result = await connector().discover();
    expect(result.status).toBe('SOURCE_SCHEMA_DRIFT');
  });

  it('JSON válido mas fora do formato esperado (sem items) vira SOURCE_SCHEMA_DRIFT', async () => {
    handler = (_url, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ unexpected: true }));
    };
    const result = await connector().discover();
    expect(result.status).toBe('SOURCE_SCHEMA_DRIFT');
  });

  it('item da lista sem node_id/html_url também é SOURCE_SCHEMA_DRIFT — nunca inventa identidade', async () => {
    handler = (_url, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ items: [{ title: 'sem identidade' }] }));
    };
    const result = await connector().discover();
    expect(result.status).toBe('SOURCE_SCHEMA_DRIFT');
  });

  it('roda cada query configurada em sequência e agrega os candidatos', async () => {
    let call = 0;
    handler = (_url, res) => {
      call += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          items: [{ node_id: `id-${call}`, html_url: `https://github.com/owner/repo/issues/${call}` }],
        }),
      );
    };
    const result = await connector({ queries: ['query um', 'query dois'] }).discover();
    expect(result.status).toBe('OK');
    expect(result.candidates.map((c) => c.externalId)).toEqual(['id-1', 'id-2']);
    expect(requestLog).toHaveLength(2);
  });

  it('se uma query no meio da sequência falhar, para ali — nunca mistura parcial com estado de erro escondido', async () => {
    let call = 0;
    handler = (_url, res) => {
      call += 1;
      if (call === 1) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ items: [{ node_id: 'id-1', html_url: 'https://github.com/owner/repo/issues/1' }] }));
        return;
      }
      res.writeHead(403, { 'retry-after': '10' });
      res.end('rate limited');
    };
    const result = await connector({ queries: ['query um', 'query dois', 'query tres'] }).discover();
    expect(result.status).toBe('SOURCE_RATE_LIMITED');
    expect(requestLog).toHaveLength(2); // parou na segunda, nunca chegou na terceira
  });
});
