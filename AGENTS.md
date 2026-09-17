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

- **Última sessão:** 2026-09-17 (tarde) · agente: claude · branch: `feat/m3-inteligencia` (de `staging`)
- **Em andamento:** M2 completo, aprovado e integrado em `staging`/`main` (tag `m2-primeiro-ciclo`); repositório publicado no GitHub (`GuilhermeSaldanha02/escritorio-autonomo`, privado). **Dono autorizou explicitamente iniciar o M3** ("Inteligência Governada" — AI Gateway, Model Router, Tool Gateway, custos, budgets, Governor completo). Plano e 16 critérios de aceite em `docs/M3-PLANO.md`, definidos com consulta prévia à revisão externa (a especificação só tem uma linha de roadmap pro M3, sem detalhe como o M1 teve). Nenhum código do M3 foi escrito ainda — só o plano.
- **Não commitado:** nada
- **Bloqueado / a decidir:** nada — plano aprovado no design com a revisão externa; falta começar a implementação (passo 1: Cost/Budget domain).
- **Próximo passo:** implementar o M3 passo a passo, pausando após cada passo para reportar evidência (mesmo padrão do M2). Ordem: (1) Cost/Budget domain com reserva atômica, (2) AI Gateway, (3) Model Router, (4) Tool Gateway, (5) extensão do Governor, (6) integração com o Orquestrador, (7) auditoria + E2E.
- **Para o outro agente saber:** decisão explícita e registrada em `docs/M3-PLANO.md`: **não ligar LLM local nem API paga real neste milestone** — por causa da RAM da máquina (8GB, já fragilizada no M2) e porque não é isso que o M3 precisa provar. `local`/`api` ficam `NOT_CONFIGURED`, testados só contra servidor fake. `model_calls`/`tool_calls` são auditoria técnica, não viram automaticamente linha do `financial_ledger` — só via uma camada de Cost Accounting explícita. A reserva de orçamento (critério 5, a mais delicada) precisa ser atômica no banco (`AVAILABLE → RESERVED → SETTLED/RELEASED`), não um `if` em memória — mesmo padrão de `UPDATE ... WHERE` condicional do `TransitionService` do M2. Agentes nunca importam adapters/providers direto, só falam com os Gateways — isso precisa de teste estrutural/arquitetural (critério 12), não só convenção. `model_calls` (migration 0001) já existe no schema; `tool_calls` e a tabela/mecanismo de reserva de orçamento ainda não — precisam de migration nova. Confira RAM livre antes de rodar testes de integração pesados (a máquina já chegou a ~245MB livres no M2).

## 5. Portões que não se pulam

- **Alegação não é prova.** Rodar o comando e ler a saída. "Deve funcionar" não fecha tarefa.
- **Ambiente limpo:** quando o resultado importa, apague `dist/` e rode de novo.
- **Governor e constituição não são editados por agente em execução.** Mudança neles é código revisado pelo dono.
- **Nenhum serviço pago** sem aprovação explícita do dono (política Free-First).
