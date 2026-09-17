# Relatório — Milestone 1: Fundação

- **Data:** 2026-09-17 · **Agente:** Claude (Opus 5) · **Branch:** `feat/m1-fundacao` (saindo de `staging`, que sai de `main`)
- **Estado:** concluído e validado localmente. **Aguardando revisão do dono. M2 não iniciado.**
- **Repositório:** só local em `C:\escritorio-autonomo`, sem remoto (decisão do dono).

---

## 1. O que foi implementado

| Peça | Onde | Resumo |
|---|---|---|
| Monorepo | raiz | pnpm workspaces, TypeScript 6 estrito, ESLint, Vitest, hook de pré-commit |
| Configuração | `packages/shared` | `.env` validado com zod; falha cedo listando todos os problemas; recusa `AI_MODE≠mock` |
| Logs | `packages/shared` | pino JSON com `service`/`pid`, mascara URLs de conexão |
| Constituição | `config/constitution.yaml` | Free-First, 8 proibições, limites de retry e paralelismo |
| Governor | `packages/governor` | Determinístico; capacidades proibidas, gasto, retries, concorrência; nega por padrão |
| Banco | `infrastructure/database` | Migrador reversível (up/down, checksum, advisory lock), seed idempotente, CLI |
| Migration | `0001_nucleo` | 6 tabelas + pgvector; `events` e `financial_ledger` append-only por trigger |
| Event Bus | `packages/events` | Catálogo de 25 eventos, EventStore idempotente, EventBus (persiste → enfileira) |
| Fila | `packages/events` | BullMQ fila `system`, job `diagnostic`, tentativas = 1 + `MAX_TASK_RETRIES` |
| Worker | `apps/worker` | Processo independente; concorrência = `MAX_PARALLEL_TASKS`; Governor antes de agir |
| API | `apps/api` | Fastify: `GET /health`, `POST /diagnostics/test-jobs`, `GET /events` |
| Infra | `docker-compose.yml` | `pgvector/pgvector:pg17` (teto 384 MB) + `redis:7.4-alpine` (teto 128 MB), portas só em 127.0.0.1 |
| Testes | `*/test`, `tests/integration` | 32 unitários + 12 de integração com serviços reais |

## 2. Árvore de arquivos

```
.
├── .env.example
├── .gitattributes
├── .githooks/pre-commit
├── .gitignore
├── AGENTS.md
├── README.md
├── apps/
│   ├── api/
│   │   ├── package.json · tsconfig.build.json
│   │   ├── src/{index,main,server}.ts
│   │   ├── src/routes/{diagnostics,health}.ts
│   │   └── test/health.test.ts
│   ├── office/README.md               (reservado para o M7)
│   └── worker/
│       ├── package.json · tsconfig.build.json
│       └── src/{diagnostic-processor,index,main,system-worker}.ts
├── config/constitution.yaml
├── docker-compose.yml
├── docs/
│   ├── M1-FUNDACAO.md
│   └── especificacao-v1.docx
├── eslint.config.js
├── infrastructure/
│   ├── database/
│   │   ├── migrations/0001_nucleo.{up,down}.sql
│   │   ├── package.json · tsconfig.build.json
│   │   ├── src/{cli,index,migrator,pool,seed}.ts
│   │   └── test/migrations-files.test.ts
│   └── docker/postgres/init/01-create-test-database.sql
├── package.json · pnpm-lock.yaml · pnpm-workspace.yaml
├── packages/
│   ├── events/   src/{bus,catalog,diagnostic,index,queues,store}.ts
│   ├── governor/ src/{constitution,governor,index}.ts · test/{constitution,governor}.test.ts
│   └── shared/   src/{agents,config,index,logger,timeout}.ts · test/config.test.ts
├── tests/integration/{database,pipeline}.test.ts · support.ts
├── tsconfig.base.json · tsconfig.json
└── vitest.{unit,integration}.config.ts
```

~2.000 linhas de TypeScript (incluindo 700 de teste), 1 migration SQL.

## 3. Branch

`main` ← `staging` ← **`feat/m1-fundacao`**. `main` e `staging` estão no commit inicial; nada foi integrado.

## 4. Commits

Todos em pt-BR, Conventional Commits, com trailer `Agente: claude`. Cada um passou pelo hook (lint + typecheck + unitários).

```
docs: Adiciona relatório do Milestone 1 e protocolo entre agentes
docs: Adiciona instruções de instalação e execução local
test: Adiciona testes de integração do Milestone 1
fix: Fixa fastify 5.12.4 respeitando idade mínima de release
feat: Adiciona API com endpoint /health e rotas de diagnóstico
feat: Adiciona Worker BullMQ com job de diagnóstico governado
feat: Adiciona prazo máximo para checagens de dependência
feat: Adiciona Event Bus com persistência idempotente e fila BullMQ
feat: Adiciona migration inicial, migrador reversível e seed
feat: Adiciona PostgreSQL com pgvector e Redis no Docker Compose
feat: Adiciona constituição e Governor determinístico
feat: Adiciona configuração validada e logger estruturado
chore: Estrutura monorepo pnpm com TypeScript, ESLint e Vitest
chore: Inicializa repositório com especificação V1          (main)
```

## 5. Executar localmente

```bash
corepack enable
pnpm install
cp .env.example .env
pnpm services:up
pnpm db:migrate
pnpm db:seed
pnpm dev                  # API + Worker juntos (ou dev:api / dev:worker)
curl http://127.0.0.1:3000/health
```

Validação: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`. Detalhes no README.

## 6. Variáveis de ambiente

| Variável | Obrigatória | Padrão | Uso |
|---|---|---|---|
| `DATABASE_URL` | sim | — | PostgreSQL de desenvolvimento |
| `REDIS_URL` | sim | — | Redis (fila e health) |
| `NODE_ENV` | não | `development` | |
| `LOG_LEVEL` | não | `info` | nível do pino |
| `AI_MODE` | não | `mock` | só `mock` é aceito no M1 |
| `API_HOST` / `API_PORT` | não | `127.0.0.1` / `3000` | |
| `QUEUE_PREFIX` | não | `escritorio` | prefixo das chaves BullMQ |
| `CONSTITUTION_PATH` | não | `config/constitution.yaml` | |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | sim (compose) | — | container local |
| `POSTGRES_PORT` / `REDIS_PORT` | não | `5432` / `6379` | portas no host |
| `TEST_DATABASE_URL` / `TEST_REDIS_URL` | só testes | — | banco `*_test` e índice Redis 1 |

Nenhuma chave de IA, token ou credencial de serviço externo.

## 7. Migrations

`0001_nucleo` (up + down):

| Tabela | Destaques |
|---|---|
| `agents` | id persistente `^[A-Z]+-[0-9]{3}$` separado de `display_name`; papel, ciclo de vida e estado com CHECK |
| `opportunities` | contrato §13.1; 15 estados do §11; `UNIQUE(source, source_url)` para deduplicação |
| `tasks` | contrato §13.3; `retry_count`, `max_cost_brl`, `allowed_tools` |
| `events` | append-only (trigger); `idempotency_key UNIQUE`; `correlation_id`; tipo validado na aplicação |
| `model_calls` | modo `mock/local/api`; tokens, custo, duração; **mock não pode ter custo** (CHECK) |
| `financial_ledger` | append-only (trigger); sem campo de saldo; **receita exige oportunidade + comprovante externo** |

Também: extensões `pgcrypto` e `vector`, e `schema_migrations` (id + sha256) mantida pelo migrador.

## 8–11. Testes, typecheck, build

Executado a partir de estado limpo (`dist/` apagado), com containers de pé:

| Comando | Resultado |
|---|---|
| `pnpm typecheck` | exit 0, sem erros |
| `pnpm lint` | exit 0, sem avisos |
| `pnpm test:unit` | **5 arquivos, 32 testes, todos passando** |
| `pnpm test:integration` | **2 arquivos, 12 testes, todos passando** |
| `pnpm build` | exit 0; 6 pacotes em ordem: governor, shared → database → events → worker, api |

**Testes unitários (sem Docker):** configuração (4) · constituição (5) · Governor (13: cada uma das 7 capacidades proibidas, capacidade desconhecida, gasto zero, AUTO_SPEND, teto R$0, teto R$5 acumulado, valores inválidos, retries, concorrência) · arquivos de migration (4) · contrato do `/health` (3: 200, 503 sem vazar mensagem interna, timeout do Redis).

**Testes de integração (PostgreSQL + Redis reais):** 6 tabelas + pgvector · migrations reversíveis e reaplicáveis · seed com 4 agentes e idempotente · seed não sobrescreve estado · `events` recusa UPDATE/DELETE · ledger recusa receita sem comprovante e UPDATE · mock com custo recusado · `/health` 200 real · job API → fila → Worker → evento · Governor bloqueia TRADING no Worker · capacidade fora do catálogo → 400 · reprocessar o mesmo job não duplica evento.

**Prova de que os testes mordem:** desativei de propósito a checagem de proibição no Governor. Resultado: 8 unitários e 1 de integração falharam (`Tempo esgotado esperando ACTION_BLOCKED`). Código restaurado com `git checkout`.

## 12. `/health`

Com processos compilados reais (`node apps/api/dist/main.js`):

```
GET /health → HTTP 200
{"status":"ok","api":"up","database":{"status":"connected","latencyMs":3},
 "redis":{"status":"connected","latencyMs":3},"aiMode":"mock","uptimeSeconds":2,
 "checkedAt":"2026-09-17T05:34:10.472Z"}
```

Com `docker compose stop redis`:

```
HTTP 503
{"status":"degraded","api":"up","database":{"status":"connected","latencyMs":16},
 "redis":{"status":"disconnected","latencyMs":0,"error":"Error"},...}
```

Após `docker compose start redis`: voltou a **HTTP 200** sozinho, sem reiniciar a API.

## 13. Worker processou o job

```
POST /diagnostics/test-jobs {"message":"fundacao M1 - processos reais"} → 202
{"jobId":"9e80872c-…","requestEventId":"9e80872c-…","correlationId":"51e3e025-…"}
```

Log do Worker (processo separado, pid 2080):

```json
{"service":"worker","pid":2080,"msg":"PostgreSQL e Redis conectados"}
{"service":"worker","pid":2080,"aiMode":"mock","concurrency":2,"queue":"system","msg":"Worker pronto e consumindo a fila"}
{"service":"worker","pid":2080,"jobId":"9e80872c-…","eventId":"77986f9f-…","created":true,"msg":"job de diagnóstico processado"}
```

O mesmo Worker **sobreviveu à queda do Redis** e processou um job novo depois que ele voltou (`TEST_JOB_COMPLETED`, `workerPid: 2080`). `pnpm dev` (tsx watch) também foi exercitado: API e Worker subiram e o `/health` respondeu 200.

## 14. Evento persistido

Consulta direta no PostgreSQL (`psql`), sem passar pela API:

```
        type        |            correlation_id            |     rule
--------------------+--------------------------------------+---------------
 TEST_JOB_REQUESTED | 51e3e025-91ed-43ed-99f5-c625304e792b |
 TEST_JOB_COMPLETED | 51e3e025-91ed-43ed-99f5-c625304e792b |
 TEST_JOB_REQUESTED | 90807c6f-22b6-49ba-86af-66b96fad5465 |
 ACTION_BLOCKED     | 90807c6f-22b6-49ba-86af-66b96fad5465 | ALLOW_TRADING
```

`TEST_JOB_COMPLETED` carrega `idempotencyKey: "TEST_JOB_COMPLETED:9e80872c-…"`, `attempt: 1`, `workerPid: 2080`.

## 15. Governor bloqueou ação proibida

```
POST /diagnostics/test-jobs {"requestedCapability":"TRADING"} → 202
GET /events?correlationId=90807c6f-… →
  ACTION_BLOCKED {"rule":"ALLOW_TRADING",
                  "reason":"Ação proibida pela Constituição: operar trading (ALLOW_TRADING=false).",
                  "action":{"kind":"CAPABILITY","capability":"TRADING"},
                  "source":{"queue":"system","jobId":"7cbb2ee7-…"}}
```

Sem `TEST_JOB_COMPLETED` para esse job: a ação foi registrada, pulada e o Worker seguiu (§10). Provado também por teste automatizado unitário e de integração.

## 16. Dependências adicionadas

| Pacote | Versão | Motivo |
|---|---|---|
| `typescript` | ~6.0.3 | Linguagem. **Não** a 7.0: o typescript-eslint só suporta até 6.0 |
| `@types/node` | ^24 | Tipos do runtime |
| `tsx` | ^4.23 | Rodar TS em dev e na CLI do banco sem build |
| `vitest` | ^5.0 | Testes unitários e de integração |
| `eslint`, `@eslint/js`, `typescript-eslint` | ^10 / ^8.70 | `lint` exigido pela spec; aplica "sem any", "sem catch vazio" por máquina |
| `zod` | ^4.6 | Validação de env, constituição, payloads de evento e de HTTP |
| `pino` | ^10.3 | Logs estruturados (o Fastify já usa pino) |
| `yaml` | ^2.9 | Ler `constitution.yaml` |
| `pg` + `@types/pg` | ^8.23 | Driver PostgreSQL |
| `bullmq` | ^6.3 | Fila (stack aprovada) |
| `ioredis` | 5.11.1 | Cliente Redis exigido pelo BullMQ; fixado na versão que o BullMQ 6 testa. Usado também no health — sem segundo cliente Redis |
| `fastify` | ~5.12.4 | Servidor HTTP com logger pino embutido |

Não adicionados de propósito: ORM, `node-pg-migrate`, `dotenv` (Node 24 tem `process.loadEnvFile`), `pino-pretty`, `husky` (hook via `core.hooksPath`), `redis`.

Política do pnpm 11 registrada em `pnpm-workspace.yaml`: `esbuild` pode rodar script de instalação; `msgpackr-extract` (acelerador nativo opcional) não.

## 17. Pendências conhecidas

1. **Evento sem job se o Redis cair entre persistir e enfileirar.** O `EventBus` grava primeiro e enfileira depois; nessa janela o erro sobe para a API (500) e o evento `TEST_JOB_REQUESTED` fica sem job. Correção natural é um outbox reconciliado pelo Orquestrador (M2/M6).
2. **`/health` com Redis fora mostra `"error":"Error"`.** O ioredis não entrega código nesse caso. É proposital não expor a mensagem; o log tem o erro real. Dá para mapear para algo como `UNAVAILABLE`.
3. **Encerramento gracioso (SIGINT/SIGTERM) não foi exercitado.** No Windows os processos foram encerrados à força; o código de `worker.close()` → `quit()` → `pool.end()` existe mas não tem prova.
4. **Sem CI.** O gate hoje é o hook local. A diretriz prevê `.github/workflows/ci.yml` quando houver remoto.
5. **Sem remoto no GitHub** e nada integrado em `staging`/`main` — decisão do dono.
6. **`.env` criado em disco** (fora do Git, confirmado por `git check-ignore`) com a senha placeholder `troque-esta-senha-local`. É a credencial do container local em uso; trocar é decisão do dono (exige recriar o volume).
7. **Containers deixados de pé** (~35 MB somados) para a revisão. `pnpm services:down` os derruba.
8. Transições de estado de `opportunities`/`tasks` existem só como CHECK de valores válidos; a máquina de transições (§11) é do Orquestrador (M2).

## 18. Decisões técnicas fora do documento

1. **pnpm** em vez de npm (a spec aceita os dois): mais leve em disco/RAM nesta máquina.
2. **`database` em `infrastructure/database`**, como pacote de workspace, seguindo a árvore do §5 em vez de criar `packages/database`.
3. **Só `shared`, `events` e `governor` criados.** O §18 pede esses três; `agents` (M2), `ai`/`tools` (M3), `memory`/`finance` (M5) entram no milestone deles. Pacote vazio entraria no build sem provar nada.
4. **Migrador próprio (~170 linhas)** em vez de `node-pg-migrate`: SQL puro, par up/down obrigatório, checksum que detecta migration editada depois de aplicada, advisory lock.
5. **Proibições como `z.literal(false)`:** mudar `ALLOW_TRADING` para `true` no YAML impede o sistema de subir. Relaxar exige mudança de código revisada.
6. **Gasto com aprovação do fundador:** `AUTO_SPEND=false` bloqueia gasto automático, mas um gasto com `approvedByFounder: true` ainda respeita os tetos (R$0 desenvolvimento, R$5 bootstrap acumulado).
7. **`MAX_TASK_RETRIES=3` → 4 tentativas no BullMQ** (1 original + 3 retries).
8. **Append-only garantido também no banco** (trigger), não só na aplicação como o §9 pede.
9. **Agentes fundadores nascem `ACTIVE`/`IDLE`,** não `PROBATION`: o §14 aplica PROBATION a agentes criados depois; os quatro são a empresa original.
10. **Eventos `TEST_JOB_REQUESTED`/`TEST_JOB_COMPLETED`** adicionados ao catálogo para o diagnóstico do M1; e `TASK_BLOCKED`, citado no §13.4.
11. **Tipo de evento validado na aplicação, não por CHECK no banco,** para eventos futuros não exigirem migration (o banco só exige formato `MAIUSCULO_COM_UNDERSCORE`).
12. **Rotas `/diagnostics/test-jobs` e `/events`** não estão no documento; são o meio de provar o fluxo ponta a ponta.
13. **API sobe com dependências fora; Worker não.** A API reporta o problema no `/health` (503); o Worker falha em até 10 s se PostgreSQL ou Redis não respondem na partida, e depois espera o Redis voltar.
14. **Fastify fixado em 5.12.4:** o pnpm 11 recusou a 5.12.5 (publicada há menos de 1 dia) e tentou criar exceção sozinho; mantive a proteção contra supply chain.
15. **Gitflow:** a diretriz v9 não tem `staging`; criada por decisão do dono. Commits em pt-BR seguindo a diretriz (o prompt tinha exemplos em inglês).
16. **Diretriz não instalada inteira.** O `install.mjs` criaria 22 arquivos (PRD, DESIGN, BRIEFING-VISUAL…) com portões de entrevista que competem com o documento-mestre. Trouxe só o protocolo Git e o bloco de handoff para o `AGENTS.md`.
17. **Especificação versionada** em `docs/especificacao-v1.docx` (45 KB, binário) para auditoria e continuidade (§22).
18. **Tetos de memória nos containers** (PostgreSQL 384 MB com `shared_buffers=64MB`, Redis 128 MB `noeviction`), por causa da máquina de 8 GB.
19. **Logger mascara** `DATABASE_URL`, `REDIS_URL` e chaves `password/token/apiKey/secret`.

## 19. Critérios de aceite (§18.1)

| Critério | Status | Prova |
|---|---|---|
| Instalação local não exige serviço pago | ✅ | Só npm registry, Docker Hub público e software local |
| `docker compose up` inicia PostgreSQL e Redis | ✅ | Ambos `healthy` via `docker compose up -d --wait` |
| API inicia sem IA externa | ✅ | `AI_MODE=mock`; log "API pronta" |
| Worker inicia sem IA externa | ✅ | Log "Worker pronto e consumindo a fila" |
| `GET /health` retorna status geral + PostgreSQL/Redis | ✅ | 200 real; 503 com Redis parado; volta a 200 |
| As seis tabelas existem via migration | ✅ | `\dt` + teste de integração |
| Os quatro agentes iniciais existem no banco | ✅ | `SELECT` + teste de integração |
| Job de teste processado pelo Worker gera evento persistido | ✅ | `TEST_JOB_COMPLETED` no `psql` + teste |
| Governor bloqueia ação proibida em teste automatizado | ✅ | 13 testes unitários + 1 de integração; mutação detectada |
| `typecheck`, `test` e `build` passam | ✅ | Todos exit 0 a partir de estado limpo |
| README permite rodar do zero | ✅ | Passo a passo testado nesta sessão (instalar → subir → migrar → seed → dev) |

**Definição de pronto (§18.2)**

```
PostgreSQL  OK
Redis       OK
API         OK
Worker      OK
Health      200
Migration   OK
Seed        OK
Queue       OK
Event       persisted
Governor    blocking prohibited action
Tests       PASS  (32 unit + 12 integration)
External paid services: R$0
```

## 20. Serviços pagos

**Nenhum.** Nenhuma API de IA, nenhuma chave, nenhum free tier com cartão, nenhum serviço de nuvem. Custo externo do M1: **R$0**.
