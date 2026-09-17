# Relatório — Milestone 2: Primeiro Ciclo

- **Data:** 2026-09-17 · **Agente:** Claude (Sonnet 5) · **Branch:** `feat/m2-primeiro-ciclo` (saindo de `staging`)
- **Estado:** concluído e validado localmente. **Aguardando revisão externa (ChatGPT) e autorização do dono. Nada integrado em `staging`/`main`. M3 não iniciado.**
- **Autorização de início:** dono, 2026-09-17, após aprovação do M1 na revisão externa.
- **Consulta intermediária (ChatGPT, antes do passo 5):** orientação recebida e registrada em `docs/M2-PLANO.md` (transições atômicas, um job por transição pesada, `MAX_PARALLEL_TASKS` como garantia V1-single-worker, terminologia snapshot+hash, e a barra de seis propriedades usada abaixo).
- **Repositório:** só local em `C:\escritorio-autonomo`, sem remoto.

---

## 0. Como ler este relatório

O M1 tinha um formato fixo de 20 itens porque a especificação pedia esse formato para o **primeiro** relatório. O M2 não tem esse molde — este relatório está organizado pelos 11 critérios de aceite do M2 (`docs/M2-PLANO.md`) e, por cima deles, pelas **seis propriedades** que a própria revisão externa definiu como a barra real de fechamento: `CRASH`, `REDIS DOWN`, `DUPLICATE DELIVERY`, `RETRY`, `REVIEW FAILED`, `FORBIDDEN ACTION` — nenhuma pode duplicar trabalho, pular estado, contornar o Governor, autoaprovar, exceder retries ou deixar a task em estado desconhecido.

Uma delas — `CRASH` — **não tem teste**. Isso está dito explicitamente na seção 4, não escondido atrás de um ✅.

## 1. O que foi construído no M2

| Passo | Peça | Onde |
|---|---|---|
| 1 | Transactional Outbox + dispatcher | `packages/events` (`EventBus`, `OutboxDispatcher`), migration `0002_outbox` |
| 2 | Máquinas de estado (oportunidade/tarefa) | `packages/shared/src/lifecycle.ts` |
| 3 | Contratos §13 + agentes mock (Diretor/Desenvolvedor/Revisor) | `packages/agents` |
| 4 | Sandbox Manager (container descartável) | `packages/tools/src/sandbox.ts` |
| 5 | Orquestrador (handlers + worker BullMQ) | `apps/worker/src/orchestrator/*`, `packages/events/src/transitions.ts`, migration `0003_orquestrador` |
| 6 | API de simulação + linha do tempo | `apps/api/src/routes/simulations.ts`, migration `0004_occurred_at_clock_real` |

Fluxo alvo completo, ponta a ponta, com Postgres/Redis/Docker reais:

```
OPORTUNIDADE FALSA (Caçador simulado → OPPORTUNITY_FOUND)
 → verificação determinística → OPPORTUNITY_VERIFIED → EVALUATING
 → DIRETOR MOCK → DIRECTOR_DECISION(EXECUTE) → Governor autoriza → APPROVED
 → TASK_CREATED → TASK_ASSIGNED (DESENVOLVEDOR-001)
 → DESENVOLVEDOR roda em sandbox real → IMPLEMENTATION_READY (snapshot + hash SHA-256)
 → REVISOR roda em sandbox nova e independente, decide pelo que observa → REVIEW_PASSED
 → TASK COMPLETED / oportunidade SUBMITTED → todos os eventos persistidos em ordem causal
```

## 2. Commits (branch `feat/m2-primeiro-ciclo`, de `152f1b7` até `7217d3c`)

```
7217d3c feat(api): Adiciona API de simulação e timeline — passo 6 do M2
e74faf0 test(worker): Prova que a sandbox do Revisor decide pelo que observa
422b1d8 feat(worker): Adiciona o Orquestrador — passo 5 do M2
01dca54 docs: Registra emenda do dono à política Free-First (§16)
b0cfbf9 feat(events): Adiciona TransitionService — transição atômica no banco
a835663 docs: Registra orientação da revisão externa para o passo 5
4ffee8d fix(tools): fecha o gap de prova de CPU no Sandbox Manager
f326d7d docs: Registra passo 4 concluído e limitações de ambiente descobertas
6f1b034 feat: Adiciona Sandbox Manager com container descartável via dockerode
ad607f6 docs: Registra passo 3 concluído e aponta o Sandbox Manager como próximo
844d27b feat: Adiciona contratos dos agentes e Diretor/Desenvolvedor/Revisor mock
47976be docs: Confirma revalidação completa após religar o Docker
830c6fb docs: Registra progresso do passo 2 e o gap de transição atômica
e61a909 feat: Adiciona máquinas de estado de oportunidade e tarefa
e10885c docs: Registra o outbox concluído no plano do M2
db60797 fix: Limita lote e prazo do dispatcher do outbox no Worker
e2a8dc5 feat: Adiciona Transactional Outbox com dispatcher no Worker
152f1b7 docs: Adiciona plano e critérios de aceite do Milestone 2
```

Um commit fora dessa lista de código, deliberadamente separado: `01dca54` — emenda do dono à §16 (política Free-First), documentação apenas, sem impacto no comportamento do M2 (ver §7).

## 3. Critérios de aceite (`docs/M2-PLANO.md`)

| # | Critério | Prova |
|---|---|---|
| 1 | Evento e job atômicos: Redis fora → outbox segura, publica quando volta | ✅ `outbox.test.ts` (fila `system`; mesma via na fila `orchestrator`, sem teste dedicado nela — ver §4) |
| 2 | Reentrega do outbox não duplica job nem evento | ✅ `outbox.test.ts` |
| 3 | Transições inválidas recusadas por código; nenhum agente declara `PAID` | ✅ `lifecycle.test.ts` (18 casos, em memória) + `transitions.test.ts` (8 testes, garantia real no banco, mutação confirmada) |
| 4 | Cenário feliz completo até `COMPLETED`, eventos em ordem | ✅ `orchestrator.test.ts` |
| 5 | Revisor valida em sandbox independente (snapshot + hash) | ✅ `orchestrator.test.ts` + `reviewer.test.ts` (hash divergente recusa sem tocar Docker, mutação confirmada) |
| 6 | Revisão reprovada volta ao Desenvolvedor; retries esgotados → `BLOCKED` | ✅ `orchestrator.test.ts` (inclui reprovação real de sandbox, não só o atalho do hash) |
| 7 | Capacidade proibida → `ACTION_BLOCKED`, sem task | ✅ `orchestrator.test.ts` |
| 8 | Sandbox sem rede/capabilities/root, teto de memória/CPU/pids/disco/tempo | ✅ `sandbox.test.ts` (16 testes, mutação confirmada em rede/não-root; CPU verificado via `inspect().HostConfig.NanoCpus`) |
| 9 | Paralelismo respeita `MAX_PARALLEL_TASKS` | ✅ `orchestrator.test.ts` — garantia V1 single-worker (gap latente documentado, §5) |
| 10 | `AGENT_STATE_CHANGED` durante o ciclo | ✅ `orchestrator.test.ts` |
| 11 | typecheck/lint/test/build limpos; R$0 | ✅ typecheck, lint, 89 unitários + 57 integração (146 total), build limpo de `dist/` zerado |

## 4. As seis propriedades (barra da revisão externa)

| Propriedade | Prova | Nota |
|---|---|---|
| `REDIS DOWN` | `outbox.test.ts` (fila `system`) | mesma via de publicação (`EventBus`→outbox→`OutboxDispatcher`) na fila `orchestrator`; nenhum caminho novo de publicação foi introduzido, mas não há teste específico nessa fila |
| `DUPLICATE DELIVERY` | `outbox.test.ts` + `transitions.test.ts` (`ALREADY_APPLIED`, concorrência real) | duas camadas: nível de job e nível de transição de estado |
| `RETRY` | `orchestrator.test.ts` | retry_count incrementa, volta a `IN_PROGRESS`, esgota em `BLOCKED` |
| `REVIEW FAILED` | `orchestrator.test.ts` (`mode: 'real-failure'`) | prova que a decisão vem do que o Revisor observou na própria sandbox, não do que o Desenvolvedor autodeclarou — evento forjado mente sobre sucesso e é ignorado |
| `FORBIDDEN ACTION` | `orchestrator.test.ts` | capacidade `TRADING` → `ACTION_BLOCKED`, `REJECTED`, nenhuma task criada |
| Autoaprovação | estrutural (`decideReview` nunca recebe quem implementou) + `orchestrator.test.ts` (`developer_sandbox_id ≠ review_sandbox_id`) | |
| **`CRASH`** | **nenhum teste** | **ver abaixo** |

**Sobre `CRASH`, com honestidade:** os handlers do Orquestrador são idempotentes por releitura de estado — cada um relê o status atual no banco a cada execução, em vez de assumir de onde o payload do job diz que partiu — e o desenho foi raciocinado deliberadamente para resumir depois de uma queda em qualquer ponto do ciclo. Isso é argumentado, não demonstrado: nenhum teste matou um processo Worker no meio de uma transição. A evidência mais próxima é indireta — os testes de `DUPLICATE DELIVERY` provam que uma reentrega do BullMQ depois de uma falha parcial (`ALREADY_APPLIED`) não duplica o efeito, propriedade que sustentaria a recuperação de um crash real, mas continua sendo inferência, não prova direta. Decisão: não construir esse teste agora (mataria um processo real sob a restrição de 8GB de RAM da máquina, com risco desproporcional ao benefício nesta fase) — registrado como gap conhecido, não como ✅.

## 5. Gaps latentes conhecidos (não bloqueiam o M2, registrados para depois)

- **Critério 9 / múltiplos Workers:** uma task barrada pelo Governor em `TASK_START` esgota as tentativas do job (`MAX_TASK_RETRIES + 1`, backoff exponencial) e fica parada em `ASSIGNED` sem job nem evento — o sistema perde de vista o motivo. Inofensivo com um único Worker (a concorrência do BullMQ já é `MAX_PARALLEL_TASKS`, o Governor nunca chega a negar na prática — por isso o teste do critério 9 precisou inserir manualmente duas tasks "ocupantes" para forçar o caso). Com mais de um processo Worker, precisa de reenfileiramento com atraso ou um evento explícito (`TASK_WAITING_SLOT`).
- **Diretor `BACKLOG`/`INVESTIGATE`:** a oportunidade fica parada em `EVALUATING` sem reavaliação futura — fora do escopo do §19 (provar o fluxo feliz e os bloqueios, não o backlog).
- **`repository`/`branch` sintéticos** (`mock://local`) no contrato do Desenvolvedor — não existem no schema de `tasks` porque não há repositório real até o M4.
- **`CRASH`** — ver §4.

## 6. Bug real encontrado e corrigido durante o M2 (não um teste flaky ignorado)

O teste do ciclo completo via API (`simulations.test.ts`) falhava de forma intermitente com a ordem dos eventos trocada (`REVIEW_PASSED` antes de `IMPLEMENTATION_READY` na consulta, apesar da ordem causal real estar correta). Causa provável: `events.occurred_at` usava `now()` como `DEFAULT` — em PostgreSQL, `now()` é o instante em que a *transação* começou, não o do `INSERT`; sob carga, isso pode inverter a ordem observada mesmo quando a ordem real de escrita está correta. Mesma classe de bug já corrigida no outbox no M1. Ressalva honesta: para este caso específico (transações separadas, ~900ms de distância no relógio de parede), início-de-transação sozinho não deveria bastar para inverter a ordem — algo manteve uma transação aberta por essa janela, ou houve entrega duplicada; a causa exata não foi isolada. De qualquer forma `clock_timestamp()` é estritamente mais correto que `now()` para esta coluna, então a correção vale independente disso.

Corrigido pela migration `0004_occurred_at_clock_real`. Confirmado aplicado no banco de testes (`SELECT column_default ... → clock_timestamp()`, verificado via `docker exec`/`psql` nesta sessão) e confirmado determinístico com 3 reexecuções limpas do teste antes flaky, depois da correção.

## 7. Emenda à especificação (dono, 2026-09-17)

`docs/ESPECIFICACAO-ALTERACOES.md` registra a mudança da §16 (política Free-First): de "não comprar se alternativa gratuita existir" para "priorizar gratuito/open-source/local; pago só sem alternativa adequada ou com benefício mensurável, sempre dentro do orçamento/permissões/limites do Governor". O dono foi explícito: **isso não libera gastos autônomos na V1** — `AUTO_SPEND=false`, custo externo de desenvolvimento continua R$0, bootstrap experimental continua limitado pela Constituição, nenhum agente ganha acesso irrestrito a credencial financeira, o Governor continua sendo a autoridade, a Constituição não pode ser alterada por agentes. **Impacto no código do M2: nenhum** — é clarificação de política para orientar decisões futuras (M4+), commitada separadamente (`01dca54`) do trabalho de código para manter a natureza doc-only auditável.

## 8. Dependências adicionadas no M2 e por quê

| Pacote | Onde | Por quê |
|---|---|---|
| `dockerode` | `packages/tools` | Sandbox Manager — cliente Docker sem depender de shell out |
| `bullmq` (já existia, uso estendido) | `apps/worker` | fila dedicada `orchestrator`, um job por transição pesada |
| `@escritorio/agents`, `@escritorio/tools`, `zod` | `apps/worker` (novas deps do package.json) | Orquestrador consome os agentes e a sandbox diretamente |

Nenhuma dependência paga; nenhuma chave de API real; `AI_MODE=mock` mantido em todo o M2.

## 9. Comandos para rodar/validar

```bash
pnpm install
pnpm run typecheck && pnpm run lint
pnpm run test:unit
pnpm run test:integration   # requer Docker/Postgres/Redis de dev ligados (docker compose up -d)
pnpm run build
```

## 10. Confirmação — nenhum serviço pago foi necessário

Todo o M2 rodou com `AI_MODE=mock`, sem chamadas a APIs de IA pagas, sem cartão, sem credencial financeira real. Custo externo total: R$0.

## 11. Situação e próximo passo

M2 implementado e validado localmente — todos os 6 passos e os 11 critérios de aceite têm evidência reexecutável; as seis propriedades da barra de fechamento têm prova direta, exceto `CRASH` (argumentado, não demonstrado — gap declarado, não escondido).

**Nada foi integrado em `staging`/`main`. Nenhum trabalho de M3 foi iniciado.** Este relatório, junto com o ZIP do commit atual (`git archive`, sem `.env`/`node_modules`/`dist`), vai para a mesma conversa do ChatGPT usada na definição da especificação e na revisão do M1/passo-5 do M2, para revisão externa antes de qualquer merge ou autorização de avançar ao M3.
