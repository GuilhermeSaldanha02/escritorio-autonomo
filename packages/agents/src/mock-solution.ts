import type { DeveloperTask } from './contracts.js';

/**
 * "Programa" fixo e determinístico que o Desenvolvedor mock produz e o
 * Revisor reexecuta de forma independente. O número de critérios de aceite
 * é o único dado da tarefa que entra no programa — o resto é fixo — porque
 * o M2 prova a esteira de execução (Desenvolvedor → sandbox → Revisor →
 * sandbox independente), não inteligência de geração de código (§19).
 *
 * Compartilhado entre `developer.ts` e `reviewer.ts` porque as duas sandboxes
 * (Desenvolvedor e Revisor) precisam rodar exatamente o mesmo comando sobre
 * o mesmo snapshot para o resultado ser comparável.
 */
export function buildMockSolutionFiles(task: DeveloperTask): Record<string, string> {
  const expected = task.acceptance_criteria.length;
  return {
    'solution.js': `module.exports = function contarCriteriosDeAceite() {\n  return ${expected};\n};\n`,
    'solution.test.js': [
      "const contarCriteriosDeAceite = require('./solution.js');",
      `const esperado = ${expected};`,
      'const obtido = contarCriteriosDeAceite();',
      'if (obtido === esperado) {',
      "  console.log('TESTES:1:1:0');",
      '  process.exit(0);',
      '}',
      'console.log(`TESTES:1:0:1 esperado=${esperado} obtido=${obtido}`);',
      'process.exit(1);',
    ].join('\n'),
  };
}

export const MOCK_SOLUTION_COMMAND = ['node', 'solution.test.js'] as const;

export interface MockTestCounts {
  total: number;
  passed: number;
  failed: number;
}

/** Formato fixo `TESTES:total:passed:failed` que `solution.test.js` imprime. */
export function parseMockTestOutput(stdout: string): MockTestCounts {
  const match = /TESTES:(\d+):(\d+):(\d+)/.exec(stdout);
  if (!match) return { total: 1, passed: 0, failed: 1 };
  return { total: Number(match[1]), passed: Number(match[2]), failed: Number(match[3]) };
}
