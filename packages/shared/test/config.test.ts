import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '@escritorio/shared';

const validEnv = {
  DATABASE_URL: 'postgres://usuario:senha@localhost:5432/escritorio',
  REDIS_URL: 'redis://localhost:6379/0',
};

describe('loadConfig', () => {
  it('aplica os padrões Free-First quando o mínimo está definido', () => {
    const config = loadConfig(validEnv);
    expect(config.AI_MODE).toBe('mock');
    expect(config.API_PORT).toBe(3000);
    expect(config.QUEUE_PREFIX).toBe('escritorio');
  });

  it('lista todas as variáveis obrigatórias ausentes de uma vez', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*REDIS_URL/);
  });

  it('rejeita URL de banco com protocolo errado', () => {
    expect(() => loadConfig({ ...validEnv, DATABASE_URL: 'mysql://localhost/x' })).toThrow(ConfigError);
  });

  it('recusa AI_MODE diferente de mock enquanto o AI Gateway não existe', () => {
    expect(() => loadConfig({ ...validEnv, AI_MODE: 'api' })).toThrow(/AI_MODE=api ainda não está implementado/);
  });
});
