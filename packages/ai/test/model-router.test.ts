import { describe, expect, it } from 'vitest';
import { ApiAdapter } from '../src/adapters/api-adapter.js';
import { LocalAdapter } from '../src/adapters/local-adapter.js';
import { MockAdapter } from '../src/adapters/mock-adapter.js';
import { ModelRouter } from '../src/model-router.js';

describe('ModelRouter', () => {
  it('seleciona deterministicamente o adapter por AI_MODE', () => {
    expect(new ModelRouter({ mode: 'mock' }).resolve()).toBeInstanceOf(MockAdapter);
    expect(new ModelRouter({ mode: 'local' }).resolve()).toBeInstanceOf(LocalAdapter);
    expect(new ModelRouter({ mode: 'api' }).resolve()).toBeInstanceOf(ApiAdapter);
  });

  it('expõe o modo atual', () => {
    expect(new ModelRouter({ mode: 'mock' }).mode).toBe('mock');
    expect(new ModelRouter({ mode: 'local' }).mode).toBe('local');
  });
});
