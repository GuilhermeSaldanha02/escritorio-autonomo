import type { SandboxManager } from '@escritorio/tools';
import { hashFileSnapshot } from '@escritorio/shared';
import type { DeveloperTask, ImplementationReady } from './contracts.js';
import { buildMockSolutionFiles, MOCK_SOLUTION_COMMAND, parseMockTestOutput } from './mock-solution.js';

/**
 * Desenvolvedor mock, versão pura/síncrona (§13.3). Não toca Docker — usada
 * pelos testes unitários de `decideReview`/`nextTaskStatusAfterReview`, que
 * precisam de um `ImplementationReady` válido sem pagar o custo de um
 * container por teste. `runDeveloperTaskInSandbox` (abaixo) é quem o
 * Orquestrador usa de verdade, com execução real em container descartável.
 */
export function runMockDeveloperTask(task: DeveloperTask): ImplementationReady {
  const totalCriteria = task.acceptance_criteria.length;
  const files = { 'NOTES.md': `Execução mock da tarefa: ${task.objective}\n` };
  return {
    changed_files: ['NOTES.md'],
    diff: `--- a/NOTES.md\n+++ b/NOTES.md\n@@ -0,0 +1 @@\n+Execução mock da tarefa: ${task.objective}\n`,
    tests: { total: totalCriteria, passed: totalCriteria, failed: 0 },
    build: true,
    elapsed_time: 0,
    cost: 0,
    dependencies_added: [],
    notes: `MOCK — sem sandbox real. Critérios assumidos satisfeitos: ${task.acceptance_criteria.join('; ')}`,
    resulting_files: files,
    resulting_snapshot_hash: hashFileSnapshot(files),
  };
}

/**
 * Desenvolvedor mock, versão real (§13.3, §19: "DESENVOLVEDOR MOCK/sandbox
 * executa"). O "mock" está na inteligência — o programa é fixo, determinístico
 * e independente do conteúdo real da tarefa (§19: provar o fluxo, não a
 * inteligência) — não na execução: o container, o build e os testes são reais.
 *
 * O snapshot resultante (`resulting_files` + hash) é o que o Orquestrador leva
 * até o Revisor para reconstrução em sandbox independente (critério 5).
 */
export async function runDeveloperTaskInSandbox(
  // `Pick<..., 'run'>`, não a classe inteira: aceita qualquer executor com a
  // mesma forma (ex.: GovernedSandbox do Tool Gateway, M3) — SandboxManager
  // tem campos privados, então só a classe exata satisfaria o tipo completo.
  sandboxManager: Pick<SandboxManager, 'run'>,
  task: DeveloperTask,
): Promise<ImplementationReady & { sandboxId: string }> {
  const files = buildMockSolutionFiles(task);
  const result = await sandboxManager.run({
    command: MOCK_SOLUTION_COMMAND,
    files,
    limits: { memoryBytes: 32 * 1024 * 1024, timeoutMs: 10_000 },
  });
  const tests = parseMockTestOutput(result.stdout);
  const build = result.exitCode === 0 && !result.oomKilled && !result.timedOut;
  return {
    changed_files: Object.keys(files),
    diff: `Mock determinístico: ${Object.keys(files).length} arquivo(s) a partir de ${task.acceptance_criteria.length} critério(s) de aceite. Auditoria apenas — o Revisor reconstrói a partir de resulting_files, não deste diff.`,
    tests,
    build,
    elapsed_time: result.durationMs,
    cost: 0,
    dependencies_added: [],
    notes: `MOCK determinístico executado em sandbox real (${result.sandboxId}) — prova a esteira de execução, não inteligência (§19).`,
    resulting_files: files,
    resulting_snapshot_hash: hashFileSnapshot(files),
    sandboxId: result.sandboxId,
  };
}
