import { defineConfig } from 'vitest/config';

// Testes de domínio permanecem em Node. Testes React do Office declaram
// `@vitest-environment jsdom` no arquivo para não alterar o ambiente do M6.
export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    include: [
      'apps/*/test/**/*.test.ts',
      'apps/office/ui/src/**/*.test.{ts,tsx}',
      'packages/*/test/**/*.test.ts',
      'infrastructure/database/test/**/*.test.ts',
      'tests/architecture/**/*.test.ts',
    ],
    environment: 'node',
    globals: true,
  },
});
