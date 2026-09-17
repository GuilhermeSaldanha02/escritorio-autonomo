import { defineConfig } from 'vitest/config';

// Testes de integração: exigem `pnpm services:up` (PostgreSQL + Redis locais).
// Rodam em série porque compartilham o banco e a instância Redis de teste.
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
