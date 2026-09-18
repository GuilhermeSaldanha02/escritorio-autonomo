import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Garantias ESTRUTURAIS do M6 (docs/M6-PLANO.md, esclarecimentos 3 e 7): varrem o
 * código-fonte de produção. Um teste de comportamento prova que algo funciona; estes
 * provam que ninguém abriu um caminho novo para contornar a regra.
 */
const ROOT = join(import.meta.dirname, '..', '..');
const SOURCE_ROOTS = ['apps', 'packages', 'infrastructure'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'test', 'tests', '.vitest']);

function listSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) found.push(...listSources(path));
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) found.push(path);
  }
  return found;
}

const SOURCES = SOURCE_ROOTS.flatMap((root) => listSources(join(ROOT, root))).map((path) => ({
  path: relative(ROOT, path).replaceAll('\\', '/'),
  text: readFileSync(path, 'utf8'),
}));

function filesMatching(pattern: RegExp): string[] {
  return SOURCES.filter((file) => pattern.test(file.text)).map((file) => file.path);
}

describe('fronteiras estruturais do M6', () => {
  it('só o Revisor escreve tasks.retry_count (retry funcional nunca é alimentado por pausa, espera ou falha técnica)', () => {
    expect(filesMatching(/SET\s+retry_count\s*=/i)).toEqual(['apps/worker/src/orchestrator/review-handler.ts']);
  });

  it('só a CLI e a API do fundador (e o próprio serviço) tocam o EmergencyStopService', () => {
    const allowed = new Set(['packages/autonomy/src/emergency-stop.ts', 'packages/autonomy/src/index.ts']);
    const users = filesMatching(/\bEmergencyStopService\b/).filter((path) => !allowed.has(path));
    for (const path of users) {
      expect(
        path.startsWith('apps/cli/') || path === 'apps/api/src/routes/emergency-stop.ts',
        `${path} não pode acionar ou liberar o Emergency Stop`,
      ).toBe(true);
    }
  });

  it('nenhum componente automático chama engage ou release do Stop (só recomenda)', () => {
    const automatic = SOURCES.filter(
      (file) =>
        /packages\/autonomy\/src\/(scheduler|job-gate|circuit-breaker|circuit-breaker-store|autonomy-controller|paused-work|recovery|lifecycle)/.test(file.path) ||
        file.path.startsWith('apps/worker/src/'),
    );
    for (const file of automatic) {
      expect(/\.(engage|release)\(\s*['"]FOUNDER/.test(file.text), `${file.path} acionaria o Stop como fundador`).toBe(false);
    }
  });

  it('só o LifecycleService escreve agents.lifecycle_status', () => {
    const writers = filesMatching(/UPDATE\s+agents[\s\S]{0,120}lifecycle_status/i);
    expect(writers.filter((path) => path !== 'packages/autonomy/src/lifecycle-service.ts')).toEqual([]);
  });

  it('a decisão de autonomia é chamada só pelos pontos de estrangulamento (e o scheduler), nunca por handlers', () => {
    const allowed = new Set([
      'packages/autonomy/src/job-gate.ts',
      'packages/autonomy/src/scheduler.ts',
      'packages/autonomy/src/autonomy-controller.ts',
      'packages/autonomy/src/recovery.ts',
      'packages/autonomy/src/lifecycle-service.ts',
      'packages/tool-gateway/src/gateway.ts',
      'packages/ai/src/gateway.ts',
    ]);
    const callers = filesMatching(/\b(?:controller|autonomy)\??\.authorize\(/);
    expect(callers.filter((path) => !allowed.has(path))).toEqual([]);
    expect(callers.length).toBeGreaterThan(0);
  });

  it('o M6 não arquiva agente nem cria agente: nenhum código de produção faz esses lançamentos', () => {
    expect(filesMatching(/to_status\s*=\s*'ARCHIVED'|lifecycle_status\s*=\s*'ARCHIVED'/i)).toEqual([]);
    expect(filesMatching(/type:\s*'AGENT_ARCHIVED'|type:\s*'AGENT_CREATED'|type:\s*'AGENT_CREATION_REQUESTED'/)).toEqual([]);
  });
});
