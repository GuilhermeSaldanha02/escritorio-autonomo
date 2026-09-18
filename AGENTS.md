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

- **Última sessão:** 2026-09-17 (noite) · agente: claude · branch: `feat/m3-inteligencia` (de `staging`)
- **Em andamento:** M2 completo, aprovado e integrado em `staging`/`main` (tag `m2-primeiro-ciclo`); repositório publicado no GitHub (`GuilhermeSaldanha02/escritorio-autonomo`, privado). **M3 (Inteligência Governada) implementado por completo** — os 7 passos e os 16 critérios de aceite têm prova reexecutável em `docs/M3-PLANO.md`/`docs/M3-INTELIGENCIA-GOVERNADA.md`. Quatro pacotes novos: `@escritorio/budget` (reserva atômica de orçamento), `@escritorio/ai` (AI Gateway + Model Router, `AI_MODE=mock` operacional, `local`/`api` `NOT_CONFIGURED` de propósito), `@escritorio/tool-gateway` (Tool Gateway, `GovernedSandbox`). Desenvolvedor/Revisor/Diretor do M2 foram religados para passar pelos Gateways — toda a suíte do M2 continua passando sem alteração.
- **Não commitado:** nada
- **Bloqueado / a decidir:** nada — falta levar o relatório de fechamento (`docs/M3-INTELIGENCIA-GOVERNADA.md`) + ZIP à revisão externa, e depois aguardar autorização do dono para o merge em `staging`/`main` e para iniciar o M4.
- **Próximo passo:** revisão externa (ChatGPT) do M3 → autorização do dono para merge → M4 (Caçador) só com nova autorização explícita.
- **Para o outro agente saber:** decisão explícita, respeitada em todo o M3: **nenhum LLM local nem API paga real** — `local`/`api` são adapters reais testados contra servidor fake em localhost, mas ficam `NOT_CONFIGURED` em operação. Limitação conhecida e registrada (não crítica): a chamada do Diretor ao AI Gateway (`opportunity-handler.ts`) não é atômica com a transição de estado — uma reentrega tardia do BullMQ pode duplicar a linha de auditoria em `model_calls` (não o gasto, que é protegido por `idempotencyKey` na reserva de orçamento). `packages/agents/src/developer.ts`/`reviewer.ts` agora aceitam `Pick<SandboxManager, 'run'>` em vez da classe concreta — é só o tipo, a lógica é a mesma; isso foi necessário porque `SandboxManager` tem campos privados e não aceita duck typing estrutural. Confira RAM livre antes de testes de integração pesados (a máquina já chegou a ~245MB livres no M2; ficou entre 400MB-1.2GB durante o M3, sem incidente).

## 5. Portões que não se pulam

- **Alegação não é prova.** Rodar o comando e ler a saída. "Deve funcionar" não fecha tarefa.
- **Ambiente limpo:** quando o resultado importa, apague `dist/` e rode de novo.
- **Governor e constituição não são editados por agente em execução.** Mudança neles é código revisado pelo dono.
- **Nenhum serviço pago** sem aprovação explícita do dono (política Free-First).
