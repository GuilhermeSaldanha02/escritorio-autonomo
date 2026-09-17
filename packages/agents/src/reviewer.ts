import type { TaskStatus } from '@escritorio/shared';
import type { DeveloperTask, ImplementationReady, ReviewCompleted } from './contracts.js';

/**
 * Revisor (§13.4). Decisão determinística sobre um resultado já produzido —
 * "não declara pagamento e não aprova o próprio trabalho" (§6): por isso esta
 * função nunca recebe quem construiu o resultado, só o resultado em si.
 *
 * `securityFlags` é passado por quem chama (o Sandbox Manager, passo 4), nunca
 * inventado aqui — dado de segurança real não nasce de heurística de texto.
 */
export function decideReview(
  task: DeveloperTask,
  implementation: ImplementationReady,
  securityFlags: readonly string[] = [],
): ReviewCompleted {
  const testsOk = implementation.tests.total > 0 && implementation.tests.failed === 0;
  const passed = implementation.build && testsOk && securityFlags.length === 0;

  const requirements = task.acceptance_criteria.map((description) => ({ description, met: passed }));

  const reasonParts: string[] = [];
  if (!implementation.build) reasonParts.push('build falhou');
  if (!testsOk) reasonParts.push(`testes: ${implementation.tests.passed}/${implementation.tests.total} (falhas: ${implementation.tests.failed})`);
  if (securityFlags.length > 0) reasonParts.push(`alertas de segurança: ${securityFlags.join(', ')}`);

  return {
    decision: passed ? 'PASSED' : 'FAILED',
    build: implementation.build,
    tests: implementation.tests,
    requirements,
    security_flags: [...securityFlags],
    reason: passed ? 'Build e testes passaram; sem alertas de segurança.' : reasonParts.join('; '),
  };
}

/**
 * Próximo estado da tarefa após a revisão (§13.4: "Falha de revisão volta ao
 * Desenvolvedor até o limite de retries. Depois, TASK_BLOCKED."). Pura —
 * quem persiste a transição e emite o evento é o Orquestrador (passo 5).
 */
export function nextTaskStatusAfterReview(
  review: ReviewCompleted,
  retryCount: number,
  maxRetries: number,
): TaskStatus {
  if (review.decision === 'PASSED') return 'COMPLETED';
  return retryCount < maxRetries ? 'IN_PROGRESS' : 'BLOCKED';
}
