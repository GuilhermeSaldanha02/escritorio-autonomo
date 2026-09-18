# Relatório — Milestone 4: Caçador Real

- **Data:** 2026-09-18 · **Agente:** Claude (Sonnet 5) · **Branch:** `feat/m4-cacador-real` (saindo de `staging`)
- **Estado:** implementado, validado localmente, **aguardando revisão externa e depois autorização do dono para o merge**. Nada integrado em `staging`/`main`.
- **Autorização de início:** dono, 2026-09-18 ("pode seguir"), depois de aprovar o `M4-PLANO.md` revisado (4 ajustes incorporados). Sessão conduzida de forma autônoma enquanto o dono dormia, com autorização explícita para consultar a revisão externa em pontos de decisão estrutural e para **não** mergear sem autorização.
- **Consulta prévia (ChatGPT):** duas rodadas antes do código (`docs/M4-PLANO.md`) e **duas consultas adicionais durante a implementação**, por decisões estruturais inesperadas — ver seção 5. Nenhum merge foi proposto ou executado sem essa cadeia de aprovação.
- **Repositório:** `GuilhermeSaldanha02/escritorio-autonomo` (privado, GitHub).

---

## 0. Como ler este relatório

Organizado pelos 19 critérios de aceite definidos com a revisão externa antes de começar (`docs/M4-PLANO.md`). Duas decisões estruturais inesperadas surgiram durante a implementação — a mais importante muda a fonte real do M4 de Algora para GitHub — e foram levadas à revisão externa antes de qualquer código depender delas, exatamente como o processo do M2/M3 previa. A seção 5 documenta as duas do início ao fim: o que foi encontrado, a decisão, e por quê.

## 1. Objetivo do M4

> Descobrir e verificar uma oportunidade real — não resolvê-la nem submetê-la ainda. Pela primeira vez o sistema busca dado de fora (internet real), não mais só simular.

Decisão explícita, mantida do plano: nenhuma execução automática decorre de uma descoberta. `VERIFIED` nunca é apresentado como garantia de pagamento. `AI_MODE` continua `mock`; custo externo total: **R$0**.

## 2. O que foi construído (ordem real de implementação)

| Peça | Onde | Responsabilidade |
|---|---|---|
| `SafeHttpClient` | `packages/http-safe` | Bloqueio de SSRF (loopback/privado/link-local), revalidado a cada hop de redirect; agora com suporte a headers de requisição |
| `SourceConnector` / `RawCandidate` / `FakeSourceConnector` | `packages/cacador` | Contrato genérico — o Caçador nunca depende de uma fonte específica |
| `Normalizer` | `packages/cacador` | Separa `raw_external_content` (evidência) de `normalized_content`; limites de tamanho, `SOURCE_PAYLOAD_TOO_LARGE` |
| Migração `0009_opportunities_m4_identity` | `infrastructure/database/migrations` | Identidade em camadas + `reward_status`, aditiva — zero regressão M1-M3 |
| `Deduplicator` | `packages/cacador` | `pg_advisory_xact_lock` por identidade + índice único como backstop |
| `Verifier` + `Promotion Policy` | `packages/cacador` | `reward_status` determinístico; `UNKNOWN` nunca vira permissão |
| `GitHubConnector` | `packages/cacador` | Fonte real (substituiu Algora — seção 5) |
| `extractGitHubEvidence` | `packages/cacador` | Evidência determinística por padrão de texto, nunca IA |
| `runDiscoveryCycle` | `packages/cacador` | Liga Connector → Normalizer → Deduplicator → Verifier → Promotion Policy |
| `discover-opportunities` (job) | `apps/worker/src/orchestrator` | Publica `OPPORTUNITY_FOUND` real; o mesmo `decide-opportunity` do M2/M3 processa, sem alteração |
| `withSourcePolicy` | `packages/cacador` | Retry/backoff com teto explícito, respeitando `Retry-After` |

Fluxo alvo, como ficou implementado:

```
INTERNET (UNTRUSTED)
 → SafeHttpClient (SSRF, revalidado por hop de redirect)
 → GitHubConnector (Source Connector real, com retry/backoff via SourcePolicy)
 → RawCandidate (trust_level=UNTRUSTED_EXTERNAL, limite de tamanho)
 → Normalizer (raw/normalized separados)
 → Deduplicator (identidade em camadas, concorrência segura)
 → extractGitHubEvidence + Verifier (reward_status determinístico)
 → Promotion Policy (decide o que pode virar OPPORTUNITY_FOUND)
 → discover-opportunities publica OPPORTUNITY_FOUND (idempotente por opportunityId)
 → decide-opportunity (M2/M3, sem alteração) → Diretor avalia
```

## 3. Commits (branch `feat/m4-cacador-real`, de `c62f20d` até `b141215`)

```
b141215 feat(m4): adiciona retry/backoff explícito ao SourceConnector (critério 16)
5abdf6f feat(m4): liga o Caçador ao Orquestrador -- OPPORTUNITY_FOUND real chega ao Diretor
c73c877 feat(m4): liga o ciclo completo do Caçador e prova o E2E (critério 19)
09bd4f9 docs: atualiza ESTADO ATUAL com o progresso do M4
d519f1e feat(m4): adiciona GitHubConnector, fonte real do Caçador
5696f7f feat(m4): troca Algora por GitHub como fonte real do Caçador
5a1d9fa feat(m4): adiciona Verifier e Promotion Policy
ae7c761 feat(m4): adiciona Deduplicator com identidade em camadas
07cff55 feat(m4): adiciona identidade em camadas e reward_status a opportunities
cc851d7 feat(m4): adiciona Normalizer com limites de tamanho e sanitização
32e9fd1 feat(m4): adiciona contrato SourceConnector e RawCandidate
bc523cb feat(m4): adiciona SafeHttpClient com proteção contra SSRF
8003b30 docs: Incorpora os 4 ajustes da revisão externa ao plano do M4
c62f20d docs: Adiciona plano do Milestone 4 (Caçador Real)
```

## 4. Critérios de aceite

| # | Critério | Prova |
|---|---|---|
| 1 | Existe `SourceConnector` genérico; o Caçador não depende diretamente do GitHub | ✅ `packages/cacador/src/source-connector.ts` — interface pura; `GitHubConnector` é uma implementação entre outras possíveis |
| 2 | Pelo menos uma fonte real permitida (GitHub) é consultada pela internet, sem navegador/input manual | ✅ `tests/integration/github-connector-real.test.ts` — chamada real à API pública do GitHub, sem mock |
| 3 | Connector usa API/documentação oficial, sem scraping frágil | ✅ `GET /search/issues`, API REST documentada do GitHub |
| 4 | Dado externo entra como `UNTRUSTED_EXTERNAL` | ✅ `RawCandidate.trustLevel`, propagado até `opportunities.trust_level` |
| 5 | Conteúdo externo não altera Governor/Constitution/tools/budget/prompts/segredos | ✅ `extractGitHubEvidence` só faz correspondência de padrão de texto determinística — nunca interpreta o corpo como instrução; provado com fixture de prompt-injection em `discovery-cycle-e2e.test.ts` |
| 6 | Limites de payload, redirects, protocolo/host, SSRF testados | ✅ `packages/http-safe/test/safe-http-client.test.ts` (31 testes), mutação confirmada |
| 7 | Identidade estável por `source + external_id`, URL canônica e fingerprint auxiliares | ✅ `Deduplicator`, índice único parcial `(source, external_id)` |
| 8 | Reprocessar a mesma oportunidade não cria duplicata | ✅ `deduplicator.test.ts`, `discovery-cycle-e2e.test.ts` |
| 9 | Atualização revisiona o registro existente, não cria oportunidade nova | ✅ idem — outcome `REVISED` |
| 10 | Concorrência de duas descobertas iguais não cria duas oportunidades | ✅ `pg_advisory_xact_lock` + índice único como backstop; ver nota de mutação honesta na seção 6 |
| 11 | Recompensa com evidência rastreável e classificação em 4 níveis | ✅ `verifyReward()`, `Verifier.test.ts` |
| 12 | `VERIFIED` nunca é garantia de pagamento | ✅ documentado no código e no plano; nenhuma lógica trata `VERIFIED` como confirmação de pagamento |
| 13 | Elegibilidade/pagamento/deadline/política de IA armazenados separadamente; ausência fica `UNKNOWN`, nunca presumida | ✅ `promotion-policy.ts`, mutação confirmada (`UNKNOWN` forçado a nunca equivaler a `ALLOWED`/`ELIGIBLE`) |
| 14 | Oportunidade incompatível não chega silenciosamente a `EXECUTE` | ✅ `canPromoteToOpportunityFound()` — mutação confirmada em `discovery-cycle-e2e.test.ts` (travar `kind` em `PROMOTED` quebra 2 testes de verdade) |
| 15 | Bug bounty/security fora do fluxo autônomo, exige humano | ✅ nenhuma mudança no M4 toca essa regra da Constituição (M1) |
| 16 | Rate limit, timeout, retry/backoff, tratamento explícito de `429`, sem busy-loop | ✅ `withSourcePolicy()` — teto de `maxRetries`, respeita `Retry-After`/`x-ratelimit-reset`; mutação confirmada no teto |
| 17 | Indisponibilidade/schema drift produz estado conhecido, não corrompe dado existente | ✅ `SOURCE_SCHEMA_DRIFT`/`SOURCE_UNAVAILABLE`/`SOURCE_RATE_LIMITED` interrompem o ciclo sem escrever nada — `discovery-cycle-e2e.test.ts` |
| 18 | **Real Source Connectivity** — consulta real à API do GitHub, zero resultados é válido | ✅ `tests/integration/github-connector-real.test.ts`, roda contra a internet de verdade |
| 19 | **Deterministic Discovery E2E** — servidor fake → Connector real → ... → `OPPORTUNITY_FOUND` → Diretor | ✅ `discovery-cycle-e2e.test.ts` (8 estados) + `discovery-cycle-orchestrator.test.ts` (fecha até o Diretor de verdade, com Postgres+Redis+BullMQ reais) — ver limitação da seção 6 sobre `CONFLICTING` |

## 5. Duas decisões estruturais inesperadas, ambas levadas à revisão externa antes do código depender delas

### 5.1 Algora não tem API pública de listagem funcional — GitHub vira a fonte real

Antes de escrever o `AlgoraConnector` previsto no plano aprovado, fui direto no código-fonte real da Algora (`algora-io/algora`, GitHub) em vez de confiar em documentação de terceiros. Achado: `lib/algora_web/controllers/api/bounty_controller.ex` tem toda a lógica de filtro comentada, e a função `index/2` sempre devolve `bounties: []`. Confirmado em produção: `GET https://algora.io/api/trpc/bounty.list` devolve `{"items":[],"next_cursor":null}` sempre — não é ausência momentânea de bounty, o endpoint nunca retorna dado nenhum, por construção.

Levado à revisão externa antes de escrever qualquer connector (registrado por completo em `docs/M4-PLANO.md`). Decisão: **GitHub REST/Search vira a fonte real principal do Caçador; Algora vira `AlgoraEvidenceEnricher`** (não implementado neste milestone — seção 6). `SourceConnector`/`RawCandidate`/`Deduplicator`/`Verifier`/`Promotion Policy` (já implementados antes deste achado) não precisaram mudar — só o connector concreto, confirmando o objetivo arquitetural original do plano.

### 5.2 `ai_allowed`/`automation_allowed` (contrato legado) não estavam sendo preenchidos

Ao escrever o teste que fecha o loop até o Diretor (`discovery-cycle-orchestrator.test.ts`), descobri que `runDiscoveryCycle` nunca preenchia `opportunities.ai_allowed`/`automation_allowed` — as colunas que `decide()` do Diretor lê de verdade (diferentes de `automation_policy_status`, que é só a modelagem rica do M4). Ficavam `NULL`, e `opportunity-handler.ts` (M2/M3, inalterado) trata `NULL` como `INVALID` antes do Diretor sequer ver a oportunidade — silenciosamente, sem erro. Corrigido antes de escrever o teste que teria falhado de forma confusa: `aiAllowed`/`automationAllowed` derivados de `automationPolicyStatus === 'ALLOWED'`, mesma regra de "ausência nunca é permissão".

## 6. Limitações conhecidas, registradas com honestidade

- **`AlgoraEvidenceEnricher` não foi implementado.** A decisão de 5.1 previa Algora como enriquecedor de evidência não-bloqueante; isso ficou fora do escopo desta rodada de implementação. Nenhum dos 19 critérios exige explicitamente essa peça — todos os critérios estão providos só com o GitHub como fonte. Registrado como próximo passo natural do M4 (ou início do M5), não um item silenciosamente esquecido.
- **`CONFLICTING` não tem fixture no E2E completo.** `verifyReward()`/`hasConflictingEvidence` são provados no nível de unidade (`verifier.test.ts`, `github-evidence.test.ts`) com mutação confirmada, mas produzir uma contradição de verdade através do pipeline completo exige uma segunda fonte de evidência discordando da primeira — exatamente o `AlgoraEvidenceEnricher` acima. Documentado no próprio `discovery-cycle-e2e.test.ts` em vez de fabricar uma fixture artificial que não reflete o pipeline real.
- **Mutation testing da corrida de deduplicação (critério 10) teve resultado diferente do esperado, documentado no teste:** ao contrário da corrida de orçamento do M3 (sem nenhuma constraint de banco impedindo duplicatas), aqui existe um índice único `(source, external_id)` como backstop real. Desligar só o `pg_advisory_xact_lock` não reproduziu duplicata nem erro cru mesmo em N=100 tentativas concorrentes testadas manualmente — o índice único (mais uma segunda camada de defesa que captura `23505` e recupera graciosamente) já segura a garantia de correção sozinho. O advisory lock continua como defesa primária, pela mesma disciplina arquitetural do M3, mas a honestidade sobre o que foi (e não foi) reproduzido localmente está registrada no teste, não escondida.
- **`SourcePolicy` (retry/backoff) foi adicionado depois da primeira versão do `GitHubConnector`**, ao perceber que o connector só constatava `SOURCE_RATE_LIMITED` sem nunca tentar de novo — uma lacuna real contra o critério 16, corrigida antes do fechamento, não deixada pra depois.

## 7. Dependências adicionadas no M4 e por quê

Nenhuma dependência de terceiros nova. `packages/cacador` usa só `@escritorio/database` e `@escritorio/http-safe`, ambos internos; `SafeHttpClient` usa `fetch`/`dns/promises` nativos do Node. Custo de infraestrutura: R$0 (GitHub REST API pública, sem token).

## 8. Comandos para rodar/validar

```bash
pnpm install
pnpm run typecheck && pnpm run lint
pnpm run test:unit          # 197 testes
pnpm run test:integration   # 88 testes — requer Docker/Postgres/Redis de dev (pnpm services:up) e acesso à internet (GitHub real)
pnpm run build
```

## 9. Confirmação — nenhum serviço pago foi necessário

Toda a suíte roda com `AI_MODE=mock`. O único acesso externo real é à API pública do GitHub (sem token, sem custo, bem abaixo do limite de 10/min do Search). Custo externo total: **R$0**.

## 10. Situação e próximo passo

M4 implementado e validado localmente: 19 critérios de aceite com prova reexecutável, mutação confirmada em cada ponto que o plano marcou como prioritário (DEDUP RACE, UNKNOWN AI POLICY, SSRF, RATE LIMIT/429, conteúdo com tentativa de prompt-injection, SOURCE SCHEMA DRIFT), e o loop fechado de ponta a ponta pela primeira vez: um candidato real (ou fixture determinística) atravessa `SafeHttpClient → GitHubConnector → Normalizer → Deduplicator → Verifier → Promotion Policy → OPPORTUNITY_FOUND → decide-opportunity (M2/M3, inalterado) → Diretor`, com Postgres, Redis e BullMQ reais.

Duas decisões estruturais inesperadas (Algora→GitHub, `ai_allowed`/`automation_allowed`) foram levadas à revisão externa ou corrigidas antes de qualquer código depender delas, seguindo o mesmo processo do M2/M3. `AlgoraEvidenceEnricher` e a fixture `CONFLICTING` do E2E completo ficam registrados como próximo passo, não escondidos.

**Nada foi integrado em `staging`/`main`. Pendente: revisão externa e depois autorização explícita do dono para o merge** — nenhum merge foi executado ou proposto durante a sessão autônoma, mesmo com autorização para continuar sem pausar.
