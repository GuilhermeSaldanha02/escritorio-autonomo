// Ativa os hooks versionados em .githooks. Roda no `prepare` do pnpm install.
// Fora de um repositório git (container, pacote extraído) não há hook para
// ativar — e isso não pode quebrar a instalação das dependências.
import { execFileSync } from 'node:child_process';
import process from 'node:process';

try {
  execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
} catch {
  process.stdout.write('hooks do git não ativados: git ausente ou fora de um repositório\n');
  process.exit(0);
}

execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'inherit' });
