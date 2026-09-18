import { defineConfig } from 'vitest/config';

/**
 * Testes que dependem de uma fonte real na internet (M4, recomendação da
 * revisão externa depois do fechamento) — separados da suíte de integração
 * determinística (vitest.integration.config.ts) de propósito: uma
 * indisponibilidade do GitHub, DNS local ou rate limiting é um resultado
 * esperado dessa categoria de teste, não uma regressão de código. Rodar
 * manualmente ou como smoke test, nunca como gate obrigatório de CI.
 */
export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    include: ['tests/integration-external/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
