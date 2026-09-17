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

- **Última sessão:** 2026-09-17 (tarde) · agente: claude · branch: `feat/m2-primeiro-ciclo`
- **Em andamento:** M2 completo, corrigido e **aprovado pela revisão externa** ("M2 — APROVADO PARA FECHAMENTO ✅", ChatGPT, 2026-09-17). Todos os 6 passos, os 11 critérios de aceite e as seis propriedades de fechamento (`REDIS DOWN`, `DUPLICATE DELIVERY`, `RETRY`, `REVIEW FAILED`, `FORBIDDEN ACTION`, `CRASH RECOVERY`) têm prova reexecutável em `docs/M2-PLANO.md`/`docs/M2-PRIMEIRO-CICLO.md`. M1 já está em `staging`/`main` (tag `m1-fundacao`). **M2 ainda não integrado em `staging`/`main` — falta só a autorização explícita do dono para o merge.** M3 continua não iniciado.
- **Não commitado:** nada
- **Bloqueado / a decidir:** só falta a autorização do dono para mergear `feat/m2-primeiro-ciclo`. Validação completa (typecheck, lint, 89 unitários, 58 integração, build limpo de `dist/` zerado) passa de estado limpo.
- **Próximo passo:** aguardar o dono autorizar o merge de `feat/m2-primeiro-ciclo` em `staging`; depois disso, aguardar autorização separada para iniciar o M3 (regra explícita da especificação: não avançar automaticamente entre milestones).
- **Para o outro agente saber:** a revisão de fechamento do M2 pediu duas correções depois da primeira versão do relatório — `TASK_WAITING_SLOT` (falta de slot no Governor agora é espera operacional, não falha, não consome `MAX_TASK_RETRIES`) e uma prova de `CRASH RECOVERY` via `worker.close(true)` + stalled-job do BullMQ (decisão explícita da revisão: sem SIGKILL de processo real do SO, por restrição de RAM da máquina de 8GB — ressalva registrada nos dois documentos, não escondida). Ambas em `docs/M2-PLANO.md` §7 e `docs/M2-PRIMEIRO-CICLO.md` §4a, com testes e mutação confirmada. Antes de provar algo com a fila, confirme que não há outro Worker consumindo; no Windows um SIGTERM vindo de outro processo mata na hora, então prove sinais em Linux; testes de integração exigem `pnpm services:up`; confira a RAM livre antes de subir containers de sandbox ou Workers extras — esta sessão chegou a ~245MB livres e precisou pausar duas vezes. `docs/M2-PLANO.md` tem uma seção "Revisão externa antes do passo 5" com decisões de design que valem para o M2 inteiro. `events.occurred_at` usa `clock_timestamp()`, não `now()` (migration 0004) — mesma lição do outbox: `now()` é o início da transação, não o instante da escrita; se algo mais no projeto depender de ordem temporal precisa dessa mesma checagem.

## 5. Portões que não se pulam

- **Alegação não é prova.** Rodar o comando e ler a saída. "Deve funcionar" não fecha tarefa.
- **Ambiente limpo:** quando o resultado importa, apague `dist/` e rode de novo.
- **Governor e constituição não são editados por agente em execução.** Mudança neles é código revisado pelo dono.
- **Nenhum serviço pago** sem aprovação explícita do dono (política Free-First).
