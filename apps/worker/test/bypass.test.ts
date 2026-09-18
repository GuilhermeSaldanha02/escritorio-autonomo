import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Critério 12 do M3: prova estrutural, não convenção — os módulos que
 * chamam `packages/agents` (Desenvolvedor/Revisor) não podem importar
 * `@escritorio/tools` (o Sandbox Manager cru) diretamente. A única
 * ferramenta que executa código deve chegar até eles envolvida pelo Tool
 * Gateway (`GovernedSandbox`, de `@escritorio/tool-gateway`) — só
 * `orchestrator-worker.ts` (a camada de wiring de infraestrutura, não de
 * lógica de agente) tem licença para construir o `SandboxManager` real.
 */
const HANDLER_FILES = ['../src/orchestrator/development-handler.ts', '../src/orchestrator/review-handler.ts'];

describe('bypass estrutural — agentes não acessam o Sandbox Manager direto', () => {
  it.each(HANDLER_FILES)('%s não importa @escritorio/tools', (relativePath) => {
    const source = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
    expect(source).not.toMatch(/@escritorio\/tools/);
  });

  it('development-handler.ts e review-handler.ts só recebem toolGateway, nunca sandboxManager', () => {
    for (const relativePath of HANDLER_FILES) {
      const source = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
      expect(source).toContain('toolGateway');
      expect(source).not.toMatch(/\bsandboxManager\b/);
    }
  });
});
