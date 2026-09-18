import { createServer, type Server } from 'node:http';
import { isIP } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResponseTooLargeError, SsrfBlockedError, TooManyRedirectsError } from '../src/errors.js';

// Mocka só a resolução de nomes fictícios usados nos testes de redirect; para
// qualquer endereço IP literal (como 127.0.0.1, usado pelos testes com servidor
// real abaixo), reproduz o comportamento real do node:dns — devolve o próprio
// IP sem tentar resolver nada. Sem isso, os testes com servidor real passariam
// pelo motivo errado (falha de resolução de DNS, não a checagem de IP privado).
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (hostname: string) => {
    const table: Record<string, Array<{ address: string; family: number }>> = {
      'public.example.test': [{ address: '93.184.216.34', family: 4 }],
      'evil.example.test': [{ address: '127.0.0.1', family: 4 }],
    };
    if (table[hostname]) return table[hostname];
    const version = isIP(hostname);
    if (version) return [{ address: hostname, family: version }];
    throw new Error(`ENOTFOUND ${hostname}`);
  }),
}));

const { SafeHttpClient } = await import('../src/safe-http-client.js');

describe('SafeHttpClient — bloqueio de SSRF (servidor local real)', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    server = createServer((req, res) => {
      if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('x'.repeat(1024));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('bloqueia requisição para loopback por padrão', async () => {
    const client = new SafeHttpClient();
    await expect(client.fetch(baseUrl)).rejects.toThrow(SsrfBlockedError);
  });

  it('permite loopback quando allowPrivateNetworks está ligado (uso exclusivo de teste)', async () => {
    const client = new SafeHttpClient({ allowPrivateNetworks: true });
    const response = await client.fetch(baseUrl);
    expect(response.status).toBe(200);
    expect(response.body).toBe('ok');
  });

  it('bloqueia protocolo não http/https mesmo com allowPrivateNetworks', async () => {
    const client = new SafeHttpClient({ allowPrivateNetworks: true });
    await expect(client.fetch('file:///etc/passwd')).rejects.toThrow(SsrfBlockedError);
  });

  it('rejeita resposta acima do limite de bytes', async () => {
    const client = new SafeHttpClient({ allowPrivateNetworks: true, maxResponseBytes: 100 });
    await expect(client.fetch(`${baseUrl}/big`)).rejects.toThrow(ResponseTooLargeError);
  });
});

describe('SafeHttpClient — revalidação por hop de redirect (DNS controlado)', () => {
  const originalFetch = globalThis.fetch;
  let fetchedUrls: string[];

  beforeEach(() => {
    fetchedUrls = [];
    globalThis.fetch = (async (url: string | URL) => {
      const href = typeof url === 'string' ? url : url.toString();
      fetchedUrls.push(href);
      if (href === 'http://public.example.test/start') {
        return new Response(null, { status: 302, headers: { location: 'http://evil.example.test/payload' } });
      }
      return new Response('não deveria ser alcançado', { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('bloqueia o redirect para um host que resolve para endereço privado, sem nunca buscá-lo', async () => {
    const client = new SafeHttpClient();
    await expect(client.fetch('http://public.example.test/start')).rejects.toThrow(SsrfBlockedError);
    expect(fetchedUrls).toEqual(['http://public.example.test/start']);
    expect(fetchedUrls).not.toContain('http://evil.example.test/payload');
  });

  it('segue um redirect cujo destino resolve para endereço público', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const href = typeof url === 'string' ? url : url.toString();
      fetchedUrls.push(href);
      if (href === 'http://public.example.test/start') {
        return new Response(null, { status: 302, headers: { location: 'http://public.example.test/end' } });
      }
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const client = new SafeHttpClient();
    const response = await client.fetch('http://public.example.test/start');
    expect(response.status).toBe(200);
    expect(response.body).toBe('ok');
    expect(fetchedUrls).toEqual(['http://public.example.test/start', 'http://public.example.test/end']);
  });

  it('estoura o limite de redirects em vez de seguir indefinidamente', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const href = typeof url === 'string' ? url : url.toString();
      fetchedUrls.push(href);
      return new Response(null, { status: 302, headers: { location: 'http://public.example.test/loop' } });
    }) as typeof fetch;

    const client = new SafeHttpClient({ maxRedirects: 2 });
    await expect(client.fetch('http://public.example.test/loop')).rejects.toThrow(TooManyRedirectsError);
  });
});
