import { defineConfig } from 'vitest/config';

// Testes unitários: não exigem PostgreSQL nem Redis.
export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    include: ['apps/*/test/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'infrastructure/database/test/**/*.test.ts'],
    environment: 'node',
  },
});
