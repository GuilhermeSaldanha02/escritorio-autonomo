# AGENTS.md — protocolo de trabalho

Vale para qualquer agente neste repositório (Claude, Codex, Antigravity…). Responda em **pt-BR**.

## 1. Fonte de verdade

- Produto, arquitetura, escopo e regras: [`docs/especificacao-v1.docx`](docs/especificacao-v1.docx) + [`docs/ESPECIFICACAO-ALTERACOES.md`](docs/ESPECIFICACAO-ALTERACOES.md) (emendas do dono depois da leitura inicial — prevalece sobre o `.docx` quando divergir; o `.docx` fica intocado como registro do V1 original).
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

- **Última sessão:** 2026-09-17 (manhã) · agente: claude · branch: `feat/m2-primeiro-ciclo`
- **Em andamento:** M2 passos 1 (outbox), 2 (máquinas de estado), 3 (contratos + agentes mock), 4 (Sandbox Manager) e 5 (Orquestrador, `apps/worker/src/orchestrator`) concluídos e commitados. Plano e critérios em `docs/M2-PLANO.md`. M1 aprovado e integrado em `staging` e `main` (tag `m1-fundacao`). Todos os 11 critérios de aceite do M2 têm prova (✅) na tabela do plano — falta só o passo 6 (API de simulação/timeline) e a validação final de fechamento.
- **Não commitado:** nada
- **Bloqueado / a decidir:** nada pendente de infraestrutura. Validação completa (typecheck, lint, 89 unitários, 52 integração, build limpo de `dist/` zerado) passou depois do passo 5. Limitações de ambiente do passo 4 (`pidsLimit` baixo trava; teste de rede por hostname é flaky) seguem documentadas em `docs/M2-PLANO.md`.
- **Próximo passo:** M2 passo 6 — API de simulação e consulta da linha do tempo (último passo do M2). Depois disso: parar, relatório + ZIP, revisão externa (mesmo chat do ChatGPT usado para M1 e para a revisão intermediária do passo 5), autorização do dono antes do M3.
- **Para o outro agente saber:** antes de provar algo com a fila, confirme que não há outro Worker consumindo; no Windows um SIGTERM vindo de outro processo mata na hora, então prove sinais em Linux; testes de integração exigem `pnpm services:up`; a máquina tem 8 GB de RAM — confira a RAM livre antes de subir containers de sandbox (o cenário feliz do Orquestrador sobe até 2 containers, sequenciais). `docs/M2-PLANO.md` tem uma seção "Revisão externa antes do passo 5" com as decisões de design que valem para o resto do M2 (transição atômica, um job por passo pesado, terminologia do critério 5, MAX_PARALLEL_TASKS como garantia V1 single-worker).

## 5. Portões que não se pulam

- **Alegação não é prova.** Rodar o comando e ler a saída. "Deve funcionar" não fecha tarefa.
- **Ambiente limpo:** quando o resultado importa, apague `dist/` e rode de novo.
- **Governor e constituição não são editados por agente em execução.** Mudança neles é código revisado pelo dono.
- **Nenhum serviço pago** sem aprovação explícita do dono (política Free-First).
