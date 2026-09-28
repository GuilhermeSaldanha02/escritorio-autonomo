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

- **Última sessão:** 2026-09-28 · agente: codex · fechamento documental do M7-INTEGRATION.
- **Em andamento:** **M2 a M7 completos e integrados em `staging`/`main`**. O M7-INTEGRATION teve QA independente final aprovado no candidato `5ebed003`; I06/I11 foram retestados independentemente, e o aceite visual I16 do owner está registrado em separado. A migration `0014_office_projection` é de leitura/projeção do Office. Detalhes e limites em `docs/M7-INTEGRATION-HANDOFF.md` e `PROGRESS.md`. O histórico e as lacunas aceitas do M6 permanecem em `docs/M6-AUTONOMIA.md`.
- **Não commitado:** nada após o fechamento documental.
- **Bloqueado / a decidir:** **M8 não começa automaticamente**; exige decisão própria do owner. Nenhum M8 foi iniciado neste merge.
- **Para o outro agente saber (M6):** M6 integrado; provas e lacunas em `docs/M6-AUTONOMIA.md`. Regras que valem daqui para frente: `AUTONOMY_ENABLED=false` é o padrão e ligá-lo nunca dá autoridade nova (única via a "permitido" é `governor.evaluate`); pausa, circuito e Emergency Stop **não são falha** (status `PAUSED`, o job retorna normalmente, nenhuma tentativa é gasta); só um humano aciona ou libera o Emergency Stop, pela CLI (`apps/cli`, `stop status|engage|release`) ou pela rota `/admin/emergency-stop` (segredo `FOUNDER_ADMIN_SECRET` só do ambiente da API); só o `LifecycleService` escreve `agents.lifecycle_status`; `jobId` de BullMQ não pode conter `:` (o outbox recusa); as migrations de domínio M6 vão até `0013`; a `0014` do M7 adiciona apenas projeção/journal do Office. Dívidas aceitas: provas de worker para espera de slot e reentrega (13), motivo do circuito no tick (23a), regra de disparo da recomendação de Stop (9) e limitação de taxa da rota HTTP do Stop. **M5 (continua valendo):** `PAID` só via `PaymentEvidence` `SIMULATED` (nenhum lançamento `REAL` até o M8); todo lançamento tem `ledger_scope` e `SIMULATION` nunca soma em caixa real; `Experience` vem só de evidência persistida, nunca de IA; a busca vetorial é exata e não devolve `UNTRUSTED_EXTERNAL` por padrão; `AgentPerformance` só recomenda; a reconciliação só detecta. O embedding determinístico é infraestrutura vetorial, não memória semântica. O checksum de migration ignora CRLF.
- **Para o outro agente saber (dois agentes):** cada agente trabalha na sua própria pasta via `git worktree`: Claude em `C:/escritorio-autonomo-m5`, Antigravity em `C:/escritorio-autonomo`. Nunca trocar de branch na pasta do outro. Donos por caminho: o Antigravity só mexe em `apps/office`, `assets/office` e `docs/M7-*`; backend, migrations, orquestrador e arquivos da raiz (`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig`) são do Claude enquanto houver trabalho paralelo. O contrato do Office é do Antigravity; o Claude só revisa a aderência ao backend. Um handoff por branch, e este `AGENTS.md` só muda em integração controlada. A suíte de integração exige Postgres e Redis (`docker compose up -d --wait postgres redis`). Depois de cada merge de milestone, o Antigravity faz rebase da sua branch na `main`.
- **Para o outro agente saber:** duas decisões estruturais do M4, registradas em `docs/M4-PLANO.md` e `docs/M4-CACADOR-REAL.md`: (1) a Algora não tem API pública de listagem de bounties funcional (endpoint stub, confirmado em produção) — GitHub é a fonte real do Caçador; Algora fica registrada como `AlgoraEvidenceEnricher` a implementar (não bloqueante, no backlog, sem decisão ainda se entra no M5 ou num M4.x de hardening). (2) `ai_allowed`/`automation_allowed` (colunas legadas que `decide()` do Diretor lê) são derivadas de `automationPolicyStatus === 'ALLOWED'` em `runDiscoveryCycle` — nunca deixar `NULL`, ou `opportunity-handler.ts` descarta a oportunidade como `INVALID` antes do Diretor ver. `CONFLICTING` só tem prova de unidade, não E2E completo (precisa do enricher acima para uma segunda fonte de evidência discordante).
- **Para o outro agente saber:** decisão explícita, respeitada em todo o M3: **nenhum LLM local nem API paga real** — `local`/`api` são adapters reais testados contra servidor fake em localhost, mas ficam `NOT_CONFIGURED` em operação. A limitação de `model_calls` duplicando auditoria numa reentrega do BullMQ (aceita como não-bloqueante pela revisão externa) **já foi corrigida** a pedido do dono, depois da aprovação: migration `0008_model_calls_idempotent` (`logical_call_id UNIQUE`) + checagem no topo de `AiGateway.complete()` + `ON CONFLICT DO NOTHING` como defesa em segunda camada — mutação confirmou que as duas camadas são necessárias (removendo só uma, o teste ainda passava; removendo as duas, quebrou com erro de constraint). `packages/agents/src/developer.ts`/`reviewer.ts` aceitam `Pick<SandboxManager, 'run'>` em vez da classe concreta — é só o tipo, a lógica é a mesma; isso foi necessário porque `SandboxManager` tem campos privados e não aceita duck typing estrutural. Confira RAM livre antes de testes de integração pesados (a máquina já chegou a ~245MB livres no M2; ficou entre 400MB-1.2GB durante o M3, sem incidente).

## 5. Portões que não se pulam

- **Alegação não é prova.** Rodar o comando e ler a saída. "Deve funcionar" não fecha tarefa.
- **Ambiente limpo:** quando o resultado importa, apague `dist/` e rode de novo.
- **Governor e constituição não são editados por agente em execução.** Mudança neles é código revisado pelo dono.
- **Nenhum serviço pago** sem aprovação explícita do dono (política Free-First).
