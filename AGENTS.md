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

- **Última sessão:** 2026-09-18 (madrugada) · agente: claude · branch: `feat/m4-cacador-real` (de `staging`), sozinho enquanto o dono dormia (autorizado a continuar e a consultar a revisão externa em pontos de decisão, sem mergear sem autorização)
- **Em andamento:** M2 e M3 completos, aprovados e **integrados em `staging`/`main`** (tags `m2-primeiro-ciclo`, `m3-inteligencia-governada`). **M4 (Caçador Real) implementado e validado localmente — relatório de fechamento escrito (`docs/M4-CACADOR-REAL.md`), aguardando revisão externa e depois autorização do dono. Nada mergeado ainda.** Loop fechado de ponta a ponta: `SafeHttpClient` → `GitHubConnector` (fonte real, com `SourcePolicy`/retry-backoff) → `Normalizer` → `Deduplicator` → `Verifier` → `Promotion Policy` → `discover-opportunities` publica `OPPORTUNITY_FOUND` real → `decide-opportunity` (M2/M3, inalterado) → Diretor avalia, provado contra Postgres+Redis+BullMQ reais (`tests/integration/discovery-cycle-orchestrator.test.ts`). 197 testes unitários, 88 de integração, todos verdes.
- **Não commitado:** nada — cada unidade completa foi commitada e pushada em `feat/m4-cacador-real`.
- **Bloqueado / a decidir:** nada tecnicamente bloqueado; merge para `staging`/`main` continua exigindo autorização explícita do dono quando ele acordar (nenhum merge foi feito sem essa autorização, mesmo trabalhando sozinho a noite toda).
- **Duas decisões estruturais inesperadas durante o M4, registradas em `docs/M4-PLANO.md` e `docs/M4-CACADOR-REAL.md`:** (1) a Algora não tem API pública de listagem de bounties funcional (verificado no código-fonte real `algora-io/algora`, confirmado em produção — o endpoint é um stub que sempre devolve vazio); levado à revisão externa, decisão: GitHub vira a fonte real, Algora vira `AlgoraEvidenceEnricher` (não implementado ainda, registrado como limitação honesta). (2) `ai_allowed`/`automation_allowed` (colunas legadas que `decide()` do Diretor lê de verdade) não estavam sendo preenchidas pelo `runDiscoveryCycle` — ficavam `NULL` e a oportunidade virava `INVALID` antes do Diretor ver; corrigido antes do teste que fecha o loop.
- **Próximo passo:** submeter `docs/M4-CACADOR-REAL.md` à revisão externa (ChatGPT); se aprovado, levar ao dono para autorização de merge. Se o dono quiser continuar implementando antes disso: `AlgoraEvidenceEnricher` (evidência não-bloqueante) e a fixture `CONFLICTING` do E2E completo ficam registrados como próximo trabalho natural, nenhum dos 19 critérios exige isso para fechar o M4.
- **Para o outro agente saber:** decisão explícita, respeitada em todo o M3: **nenhum LLM local nem API paga real** — `local`/`api` são adapters reais testados contra servidor fake em localhost, mas ficam `NOT_CONFIGURED` em operação. A limitação de `model_calls` duplicando auditoria numa reentrega do BullMQ (aceita como não-bloqueante pela revisão externa) **já foi corrigida** a pedido do dono, depois da aprovação: migration `0008_model_calls_idempotent` (`logical_call_id UNIQUE`) + checagem no topo de `AiGateway.complete()` + `ON CONFLICT DO NOTHING` como defesa em segunda camada — mutação confirmou que as duas camadas são necessárias (removendo só uma, o teste ainda passava; removendo as duas, quebrou com erro de constraint). `packages/agents/src/developer.ts`/`reviewer.ts` aceitam `Pick<SandboxManager, 'run'>` em vez da classe concreta — é só o tipo, a lógica é a mesma; isso foi necessário porque `SandboxManager` tem campos privados e não aceita duck typing estrutural. Confira RAM livre antes de testes de integração pesados (a máquina já chegou a ~245MB livres no M2; ficou entre 400MB-1.2GB durante o M3, sem incidente).

## 5. Portões que não se pulam

- **Alegação não é prova.** Rodar o comando e ler a saída. "Deve funcionar" não fecha tarefa.
- **Ambiente limpo:** quando o resultado importa, apague `dist/` e rode de novo.
- **Governor e constituição não são editados por agente em execução.** Mudança neles é código revisado pelo dono.
- **Nenhum serviço pago** sem aprovação explícita do dono (política Free-First).
