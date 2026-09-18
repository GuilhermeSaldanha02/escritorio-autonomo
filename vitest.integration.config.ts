import { defineConfig } from 'vitest/config';

// Testes de integração: exigem `pnpm services:up` (PostgreSQL + Redis locais).
// Rodam em série porque compartilham o banco e a instância Redis de teste.
//
// Não inclui tests/integration-external/ (M4, recomendação da revisão
// externa): testes que dependem de uma fonte real na internet (ex.: a API
// pública do GitHub) rodam à parte — uma indisponibilidade do GitHub, DNS
// local ou rate limiting não deve virar build vermelho da suíte
// determinística. Ver vitest.integration-external.config.ts.
export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
