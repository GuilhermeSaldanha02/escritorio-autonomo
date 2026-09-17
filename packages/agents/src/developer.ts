import type { DeveloperTask, ImplementationReady } from './contracts.js';

/**
 * Desenvolvedor mock (§13.3, §19: "DESENVOLVEDOR MOCK/sandbox executa").
 *
 * Este é o mock explícito do M2 — não roda código real nem sandbox. Ele prova
 * o formato do contrato e o transporte do fluxo (Diretor → Task → Desenvolvedor
 * → Revisor), não a execução técnica em si. O Sandbox Manager (passo 4 do
 * `docs/M2-PLANO.md`) é quem substitui isto por execução real em container
 * descartável; até lá, `notes` deixa claro que o resultado é mock.
 */
export function runMockDeveloperTask(task: DeveloperTask): ImplementationReady {
  const totalCriteria = task.acceptance_criteria.length;
  return {
    changed_files: ['NOTES.md'],
    diff: `--- a/NOTES.md\n+++ b/NOTES.md\n@@ -0,0 +1 @@\n+Execução mock da tarefa: ${task.objective}\n`,
    tests: { total: totalCriteria, passed: totalCriteria, failed: 0 },
    build: true,
    elapsed_time: 0,
    cost: 0,
    dependencies_added: [],
    notes: `MOCK — sem sandbox real (chega no passo 4 do M2). Critérios assumidos satisfeitos: ${task.acceptance_criteria.join('; ')}`,
  };
}
