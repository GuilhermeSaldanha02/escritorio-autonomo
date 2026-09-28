import { defineConfig } from 'vitest/config';
// Permite verificar a fatia antes de o integrador registrar a dependência workspace.
export default defineConfig({
  resolve: { alias: {
    '@escritorio/office-contract': new URL('./src/index.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'),
    zod: new URL('../../apps/api/node_modules/zod/index.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'),
  } },
  test: { include: ['packages/office-contract/test/**/*.test.ts', 'apps/api/test/office-projection.test.ts'] },
});
