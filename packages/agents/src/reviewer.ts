import type { SandboxManager } from '@escritorio/tools';
import { hashFileSnapshot, type TaskStatus } from '@escritorio/shared';
import type { DeveloperTask, ImplementationReady, ReviewCompleted } from './contracts.js';
import { MOCK_SOLUTION_COMMAND, parseMockTestOutput } from './mock-solution.js';

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
 * Reconstrói o estado candidato numa sandbox nova e independente da do
 * Desenvolvedor (critério 5 do M2) e revisa com base no que essa sandbox
 * observou, não no que o Desenvolvedor autodeclarou em `implementation`.
 *
 * Dois portões antes de aceitar o resultado do Desenvolvedor como entrada
 * confiável: (1) o hash do snapshot recebido precisa bater com o que o
 * Desenvolvedor assinou — se não bater, reprova sem sequer rodar (a sandbox
 * do Revisor teria testado outra coisa); (2) o build/testes que valem para a
 * decisão são os que a PRÓPRIA sandbox do Revisor observou, não os que
 * `implementation.build`/`implementation.tests` afirmam — impede que uma
 * sandbox do Desenvolvedor comprometida ou com bug minta sobre o resultado.
 */
export async function reviewInSandbox(
  // Ver nota equivalente em developer.ts: Pick<..., 'run'> aceita qualquer
  // executor com a mesma forma (GovernedSandbox do Tool Gateway, M3).
  sandboxManager: Pick<SandboxManager, 'run'>,
  task: DeveloperTask,
  implementation: ImplementationReady,
): Promise<{ review: ReviewCompleted; sandboxId: string | undefined }> {
  const recomputedHash = hashFileSnapshot(implementation.resulting_files);
  if (recomputedHash !== implementation.resulting_snapshot_hash) {
    const review = decideReview(
      task,
      { ...implementation, build: false, tests: { total: 1, passed: 0, failed: 1 } },
      ['SNAPSHOT_HASH_MISMATCH'],
    );
    return {
      review: { ...review, reason: 'Hash do snapshot não confere com o que o Desenvolvedor declarou — recusado sem executar.' },
      sandboxId: undefined,
    };
  }

  const result = await sandboxManager.run({
    command: MOCK_SOLUTION_COMMAND,
    files: implementation.resulting_files,
    limits: { memoryBytes: 32 * 1024 * 1024, timeoutMs: 10_000 },
  });
  const observedTests = parseMockTestOutput(result.stdout);
  const observedBuild = result.exitCode === 0 && !result.oomKilled && !result.timedOut;
  const securityFlags = [
    ...(result.oomKilled ? ['SANDBOX_OOM'] : []),
    ...(result.timedOut ? ['SANDBOX_TIMEOUT'] : []),
  ];

  const review = decideReview(task, { ...implementation, build: observedBuild, tests: observedTests }, securityFlags);
  return { review, sandboxId: result.sandboxId };
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
