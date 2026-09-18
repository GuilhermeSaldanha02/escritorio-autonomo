import { describe, expect, it } from 'vitest';
import { ApiAdapter } from '../src/adapters/api-adapter.js';
import { LocalAdapter } from '../src/adapters/local-adapter.js';
import { MockAdapter } from '../src/adapters/mock-adapter.js';
import { ModelUnavailableError } from '../src/types.js';

describe('MockAdapter', () => {
  it('é determinístico e nunca tem custo (não retorna cost — Gateway garante 0)', async () => {
    const adapter = new MockAdapter();
    const result = await adapter.complete({ agentId: 'DIRETOR-001', prompt: 'olá' });
    expect(result.provider).toBe('mock');
    expect(result.content).toContain('resposta determinística');
    expect(result.inputTokens).toBeGreaterThan(0);
  });
});

describe('LocalAdapter — NOT_CONFIGURED por padrão', () => {
  it('rejeita sem tentar rede quando não há baseUrl configurada', async () => {
    const adapter = new LocalAdapter();
    await expect(adapter.complete({ agentId: 'DESENVOLVEDOR-001', prompt: 'x' })).rejects.toThrow(ModelUnavailableError);
    await expect(adapter.complete({ agentId: 'DESENVOLVEDOR-001', prompt: 'x' })).rejects.toThrow(/NOT_CONFIGURED/);
  });
});

describe('ApiAdapter — NOT_CONFIGURED por padrão', () => {
  it('rejeita sem tentar rede quando não há apiKey/baseUrl configurada', async () => {
    const adapter = new ApiAdapter();
    await expect(adapter.complete({ agentId: 'DIRETOR-001', prompt: 'x' })).rejects.toThrow(ModelUnavailableError);
    await expect(adapter.complete({ agentId: 'DIRETOR-001', prompt: 'x' })).rejects.toThrow(/NOT_CONFIGURED/);
  });

  it('rejeita mesmo com baseUrl se faltar apiKey — nunca chama sem as duas', async () => {
    const adapter = new ApiAdapter({ baseUrl: 'http://exemplo.invalido' });
    await expect(adapter.complete({ agentId: 'DIRETOR-001', prompt: 'x' })).rejects.toThrow(/NOT_CONFIGURED/);
  });
});
