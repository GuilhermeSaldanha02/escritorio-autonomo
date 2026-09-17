# Escritório Autônomo

Empresa digital composta por agentes autônomos que começa com R$0, procura oportunidades públicas legítimas, executa e revisa trabalho técnico, e registra custo e aprendizado. A prova econômica final é o primeiro R$1 externo realmente recebido.

**Fonte de verdade:** [`docs/especificacao-v1.docx`](docs/especificacao-v1.docx). Este repositório está no **Milestone 1 — Fundação**: infraestrutura sobre a qual os agentes serão construídos. Ainda não há IA, conectores reais nem Office 2D.

## Pré-requisitos

Tudo gratuito e local — nenhuma conta, chave de API ou serviço pago.

| Ferramenta | Versão testada |
|---|---|
| Node.js | 22.12+ (testado em 24.16) |
| pnpm | 11.2.2 (`corepack enable` instala a versão do `packageManager`) |
| Docker + Docker Compose | Docker 28 / Compose 2.40 |

> **Máquina com pouca RAM:** os containers têm teto (PostgreSQL 384 MB, Redis 128 MB). No Windows, o Docker Desktop roda numa VM WSL2 que por padrão pega até metade da RAM; para limitar, crie `%UserProfile%\.wslconfig` com `[wsl2]` e `memory=3GB`.

## Rodando do zero

```bash
# 1. Dependências
corepack enable
pnpm install

# 2. Configuração local (edite a senha se quiser — é só do seu container)
cp .env.example .env

# 3. PostgreSQL + pgvector e Redis
pnpm services:up

# 4. Banco: tabelas e agentes iniciais
pnpm db:migrate
pnpm db:seed

# 5. API e Worker (dois terminais, ou `pnpm dev` para os dois juntos)
pnpm dev:api
pnpm dev:worker
```

Conferir:

```bash
curl http://127.0.0.1:3000/health
```

Resposta esperada (`200`; vira `503` se PostgreSQL ou Redis cair):

```json
{ "status": "ok", "api": "up", "database": { "status": "connected", "latencyMs": 3 },
  "redis": { "status": "connected", "latencyMs": 1 }, "aiMode": "mock", "uptimeSeconds": 12, "checkedAt": "…" }
```

### Provar o fluxo API → fila → Worker → banco

```bash
# Job de teste: o Worker processa e grava TEST_JOB_COMPLETED
curl -X POST http://127.0.0.1:3000/diagnostics/test-jobs -H 'content-type: application/json' -d '{"message":"ping"}'

# Ação proibida: o Governor bloqueia e grava ACTION_BLOCKED
curl -X POST http://127.0.0.1:3000/diagnostics/test-jobs -H 'content-type: application/json' -d '{"requestedCapability":"TRADING"}'

# Eventos persistidos (use o correlationId devolvido acima)
curl 'http://127.0.0.1:3000/events?correlationId=<correlationId>'
```

## Comandos

| Comando | O que faz | Precisa de Docker |
|---|---|---|
| `pnpm typecheck` | TypeScript no monorepo inteiro, sem build prévio | não |
| `pnpm lint` | ESLint (proíbe `any` explícito, `catch` vazio, `console`) | não |
| `pnpm test:unit` | Governor, constituição, configuração, migrations, contrato do `/health` | não |
| `pnpm test:integration` | Migrations reversíveis, seed, integridade, `/health` real, job ponta a ponta | **sim** |
| `pnpm test` | Unitários + integração | **sim** |
| `pnpm build` | Compila todos os pacotes para `dist/` em ordem de dependência | não |
| `pnpm start:api` / `pnpm start:worker` | Roda o build compilado | sim |
| `pnpm db:migrate` / `db:rollback [n]` / `db:seed` | Banco de desenvolvimento | sim |
| `pnpm services:up` / `services:down` | Sobe/derruba PostgreSQL e Redis | — |

Os testes de integração usam o banco `escritorio_test` (criado automaticamente na primeira subida do container) e um prefixo de fila único por execução — nunca tocam o banco de desenvolvimento. Se o volume do PostgreSQL já existia antes desse script, crie o banco manualmente: `docker compose exec postgres psql -U escritorio -c 'CREATE DATABASE escritorio_test'`.

## Estrutura

```
apps/
  api/            Fastify: GET /health, POST /diagnostics/test-jobs, GET /events
  worker/         Consumidor BullMQ da fila `system`, independente da interface
  office/         Reservado para o Office 2D (M7) — sem código no M1
packages/
  shared/         Configuração validada (zod), logger JSON (pino), catálogo de agentes
  governor/       Constituição + Governor determinístico (não é IA)
  events/         Catálogo de eventos, EventStore append-only, EventBus, filas
infrastructure/
  database/       Pool, migrador reversível, seed e CLI (@escritorio/database)
    migrations/   Pares NNNN_nome.up.sql / .down.sql
  docker/         Scripts de inicialização dos containers
config/
  constitution.yaml   Proibições, limites e política Free-First
docs/                 Especificação V1 e relatório do M1
tests/integration/    Testes contra PostgreSQL e Redis reais
```

Pacotes planejados na especificação e ainda não criados (entram quando o milestone deles chegar): `agents` (M2), `ai` e `tools` (M3), `memory` e `finance` (M5).

## Regras que o código garante

- **Governor por código, não por prompt.** `config/constitution.yaml` é validado na carga; qualquer proibição da V1 (`ALLOW_TRADING`, `DIRECT_OUTREACH`, …) marcada como `true` impede o sistema de subir. A constituição carregada é congelada em memória.
- **Free-First.** `AI_MODE` diferente de `mock` é recusado até o AI Gateway existir (M3). Chamadas mock não podem ter custo (constraint no banco).
- **Auditoria.** `events` e `financial_ledger` são append-only por trigger. Receita exige oportunidade e comprovante externo. Saldo nunca é armazenado.
- **Retry sem duplicidade.** Eventos gravados por jobs usam chave de idempotência derivada do `jobId`.
- **Segredos.** Somente `.env.example` é versionado; o logger mascara URLs de conexão.

## Git

Fluxo: `main` ← `staging` ← `feat/…`. Commits em pt-BR (Conventional Commits) com trailer `Agente: <claude|antigravity>`. O hook de pré-commit (`.githooks/pre-commit`, ativado por `pnpm install`) roda lint, typecheck e testes unitários. Detalhes em [`AGENTS.md`](AGENTS.md).
