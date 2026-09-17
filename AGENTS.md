# AGENTS.md — protocolo de trabalho

Vale para qualquer agente neste repositório (Claude, Codex, Antigravity…). Responda em **pt-BR**.

## 1. Fonte de verdade

- Produto, arquitetura, escopo e regras: [`docs/especificacao-v1.docx`](docs/especificacao-v1.docx).
- Git: diretriz v9 (`GuilhermeSaldanha02/diretriz`), adaptada abaixo.
- Estado do trabalho: bloco **ESTADO ATUAL** (§4) e [`docs/M1-FUNDACAO.md`](docs/M1-FUNDACAO.md).

Não altere a arquitetura em silêncio. Se uma decisão da especificação for inviável, documente o problema antes de substituí-la (§20 da especificação).

## 2. Abertura de sessão

1. `git status --short` — **working tree sujo: PARE e pergunte ao dono.** Pode ser trabalho de outro agente.
2. `git log --oneline -10` e `git log --grep="Agente: "` para ver quem fez o quê.
3. Leia o bloco ESTADO ATUAL.

## 3. Git

- **Fluxo:** `main` ← `staging` ← `feat/…` · `fix/…` · `chore/…` · `refactor/…`. Nunca commitar direto em `main` ou `staging`; integração por PR/merge revisado pelo dono.
- **Conventional Commits em pt-BR:** `<tipo>: <Descrição imperativa com inicial maiúscula>`, sem ponto final, ≤ 72 caracteres.
- **Trailer em todo commit:** `Agente: <claude|antigravity|codex>`.
- **Uma mudança lógica por commit.** Refatoração e feature nunca no mesmo commit.
- **Pré-commit bloqueante:** `.githooks/pre-commit` (lint, typecheck, testes unitários). Nunca `--no-verify`.
- **Antes do PR:** `pnpm test` (com Docker), `pnpm build`, `git diff --check`.
- **Nunca** force-push em branch compartilhada. **Nunca** versionar `.env` ou segredo.
- **Windows, restaurar binário:** `git checkout <SHA> -- caminho`, nunca `git show > arquivo`.

## 4. ESTADO ATUAL

> Sobrescrever a cada sessão; o histórico é o `git log`.

- **Última sessão:** 2026-09-17 · agente: claude · branch: `feat/m1-fundacao`
- **Em andamento:** Milestone 1 implementado; aguardando revisão do dono
- **Não commitado:** nada
- **Bloqueado / a decidir:** merge `feat/m1-fundacao` → `staging` → `main` depende da revisão do dono; repositório só local (sem remoto)
- **Próximo passo:** dono revisa o relatório em `docs/M1-FUNDACAO.md`. **Não iniciar o M2 sem autorização.**
- **Para o outro agente saber:** testes de integração exigem `pnpm services:up`; a máquina de desenvolvimento tem 8 GB de RAM — não subir serviços além de PostgreSQL e Redis sem necessidade.

## 5. Portões que não se pulam

- **Alegação não é prova.** Rodar o comando e ler a saída. "Deve funcionar" não fecha tarefa.
- **Ambiente limpo:** quando o resultado importa, apague `dist/` e rode de novo.
- **Governor e constituição não são editados por agente em execução.** Mudança neles é código revisado pelo dono.
- **Nenhum serviço pago** sem aprovação explícita do dono (política Free-First).
