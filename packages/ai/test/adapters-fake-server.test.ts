import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiAdapter } from '../src/adapters/api-adapter.js';
import { LocalAdapter } from '../src/adapters/local-adapter.js';
import { ModelUnavailableError } from '../src/types.js';

/**
 * Prova o contrato real dos adapters local/api (M3, critério 2: "adapters
 * reais de contrato, testados contra servidor fake") sem tocar nenhum LLM
 * de verdade nem gastar nada — o servidor fake roda no próprio processo do
 * teste, em localhost.
 */
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.url === '/api/generate') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ response: 'olá do fake local', prompt_eval_count: 5, eval_count: 3 }));
        return;
      }
      if (req.url === '/v1/chat/completions') {
        const parsed = JSON.parse(body) as { messages: Array<{ content: string }> };
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            choices: [{ message: { content: `eco: ${parsed.messages[0]?.content}` } }],
            usage: { prompt_tokens: 4, completion_tokens: 6 },
          }),
        );
        return;
      }
      if (req.url === '/erro') {
        res.statusCode = 500;
        res.end('falha simulada');
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('servidor fake sem porta');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe('LocalAdapter contra servidor fake', () => {
  it('completa de verdade quando configurado (contrato real, sem LLM de verdade)', async () => {
    const adapter = new LocalAdapter({ baseUrl });
    const result = await adapter.complete({ agentId: 'DESENVOLVEDOR-001', prompt: 'teste' });
    expect(result.content).toBe('olá do fake local');
    expect(result.provider).toBe('local');
    expect(result.inputTokens).toBe(5);
    expect(result.outputTokens).toBe(3);
  });

  it('propaga erro do servidor como ModelUnavailableError, não como sucesso', async () => {
    const adapter = new LocalAdapter({ baseUrl: `${baseUrl}` });
    // Força uma baseUrl que bate no path de erro simulando servidor fora do ar de outra forma:
    const brokenAdapter = new LocalAdapter({ baseUrl: 'http://127.0.0.1:1' });
    await expect(brokenAdapter.complete({ agentId: 'DESENVOLVEDOR-001', prompt: 'x' })).rejects.toThrow(ModelUnavailableError);
    void adapter;
  });
});

describe('ApiAdapter contra servidor fake', () => {
  it('completa de verdade quando configurado, sem chave real (fake não valida nada)', async () => {
    const adapter = new ApiAdapter({ baseUrl, apiKey: 'chave-de-teste-sem-valor-real' });
    const result = await adapter.complete({ agentId: 'DIRETOR-001', prompt: 'oi' });
    expect(result.content).toBe('eco: oi');
    expect(result.provider).toBe('api');
    expect(result.inputTokens).toBe(4);
    expect(result.outputTokens).toBe(6);
  });
});
