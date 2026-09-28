# M7-INTEGRATION — Plano técnico de implementação

> Para execução futura: usar `executing-plans` ou `subagent-driven-development`, após aprovação do owner. Os checkboxes abaixo são trabalho futuro, não implementação entregue.

**Objetivo:** conectar o Office aprovado a uma projeção read-only dos fatos persistidos, com snapshot, WebSocket, replay e reconexão, sem levar regras de domínio ao navegador.

**Arquitetura proposta:** serviço de projeção dentro da API existente, com leitura consistente do PostgreSQL e journal próprio persistido; contrato browser-safe; `LiveOfficeDataSource` ao lado da fixture. Sem novo processo, Kafka, fila concorrente ou serviço externo.

**Stack encontrada:** TypeScript, Fastify, PostgreSQL, Redis/BullMQ, Vitest; React/Vite/Phaser no Office. O transporte WebSocket ainda não está instalado na API.

**Estado:** AUDITORIA E PLANO; implementação NÃO iniciada. Data: 2026-09-22. Base auditada: `a28140f`, branch `feat/m7-office-ui`, pasta `C:/escritorio-autonomo`.

## 1. Estado auditado e limites da prova

- `main` e `staging`, locais e remotas: `f468625c975ad27b0c57012ba44595c63e3bd067`, confirmado por `git ls-remote origin` nesta sessão. A branch auditada está 11 commits à frente e zero atrás de `main`; merge-base `f468625`.
- `feat/m7-office-ui`: `a28140f`; commits finais visuais `f1d454d`, `03e8b1f`, fechamento `a28140f`. Nenhuma ref remota dessa feature retornou na consulta.
- `feat/m7-office-preparation` é referência local histórica, não incorporada. Seu contrato foi lido com `git show`, sem checkout/merge/rebase.
- Worktree limpo antes da documentação. Nenhuma alteração de implementação nesta etapa; apenas este plano e o handoff em `PROGRESS.md`.
- M7-UI está encerrado por aprovação do owner em `03e8b1f`. O handoff registra 49 arquivos/379 testes, typecheck, lint e build UI aprovados naquela rodada; isto não é prova de integração viva.
- Evidências existentes: `qa/evidencias/M7-REBUILD/` e `qa/evidencias/M7-POLISH/`. QA independente continua `ALEGADO`. Warning conhecido: chunk Phaser acima de 500 kB.
- Auditoria estática do código e das migrations, não inspeção do banco operacional. Não se afirma que a base instalada esteja migrada, populada ou saudável. Não foi executado API/Worker nem lido `.env`.
- `scripts/qa-obsoletos.mjs` não existe neste repositório; o registro atual não tem o formato integral do parser da skill. Sem inventar resultado desse check ou reformar o QA fora do escopo.

## 2. Arquitetura encontrada — fontes verificáveis

| Componente | Caminhos auditados | O que realmente existe |
| --- | --- | --- |
| API | `apps/api/src/server.ts`, `main.ts`, `routes/{health,diagnostics,simulations,emergency-stop}.ts` | Fastify; health, diagnósticos, simulações, timeline de oportunidade e Stop administrativo opcional. Não há `/office/*`, WebSocket ou autenticação geral do Office. |
| Worker/orquestrador | `apps/worker/src/main.ts`, `autonomy-runtime.ts`, `orchestrator/*` | Orquestrador está no Worker, não em `packages/orchestrator`. Consome BullMQ; discovery, decisão, desenvolvimento e revisão. |
| Agentes | `packages/agents/src/*`, `packages/shared/src/{agents,lifecycle}.ts`, `infrastructure/database/src/seed.ts` | Quatro papéis fundadores; estados/lifecycle persistidos; funções de execução não são fonte única de estado para leitura. |
| Event Bus | `packages/events/src/{bus,store,catalog,transitions}.ts` | Append de eventos, idempotência e transições transacionais; sem subscription de navegador. Catálogo inclui eventos planejados que nem sempre têm produtor. |
| Outbox | `packages/events/src/outbox.ts`, migration `0002` | Entrega jobs ao BullMQ com retry. Só eventos com dispatch têm outbox. Não é broadcast nem journal de todos os fatos. |
| Governança | `packages/governor/src/{governor,constitution}.ts` | Constituição carregada no processo, Governor determinístico; `AUTO_SPEND` é literalmente false no schema atual. |
| Autonomia | `packages/autonomy/src/{emergency-stop,circuit-breaker,circuit-breaker-store,autonomy-controller,lifecycle-service,paused-work,job-gate,scheduler,recovery}.ts` | Stop humano, breakers por escopo, pausas, scheduler, recovery e único escritor de lifecycle. Leitura não deve invocar autorização/admissão. |
| Finanças/orçamento | `packages/finance/src/{payment-service,revenue-posting,reconciliation}.ts`, `packages/budget/src/ledger.ts` | Ledger em centavos por escopo; `ledgerBalanceCents` já calcula caixa; reservas de orçamento não são caixa. Pagamento EXTERNAL_VERIFIED recusado até M8. |
| Memória | `packages/memory/src/{experience,experience-repository,memory-repository,memory-validator,agent-performance,performance-repository}.ts` | Experiência derivada de evidência, memória com escopo/trust, recomendações de performance. Nenhuma deve virar autoridade ou conteúdo bruto do Office. |
| Ferramentas | `packages/tools/src/{sandbox,sandbox-reaper}.ts`, `packages/tool-gateway/src/gateway.ts` | Execução governada em sandbox, auditoria, quiescência/PAUSED. Office não executa ferramentas nem lê stdout, prompts ou arquivos de sandbox. |
| Office | `apps/office/ui/src/data/*`, `hooks/useOfficeSnapshot.ts`, `main.tsx`, `components/*`, `office/scene-model.ts` | Fixture local; interface `getSnapshot/subscribe`; eventos locais de invalidação, não eventos de rede; modo tipado só DEMO. |

### Persistência relevante

- `0001_nucleo`: `agents`, `tasks`, `opportunities`, `events`, `model_calls`, `financial_ledger`. Não há `agents.state_since`, `tasks.started_at`, ponteiro de tarefa atual ou tabela de workstations.
- `0002`: outbox; `0003`: capabilities; `0004`: `events.occurred_at = clock_timestamp()`, ainda não ordem de commit.
- `0005`–`0008`: reservas e auditoria de modelo/ferramenta; idempotência de chamada de modelo.
- `0009`: identidade/proveniência de oportunidade, conteúdo externo não confiável.
- `0010`: `amount_cents bigint`, escopo REAL/SIMULATION obrigatório e `payment_evidence`; ledger append-only.
- `0011`–`0012`: experiências, memória/performance, escopo e trust de memória.
- `0013`: históricos de Stop/breaker/lifecycle com `seq`, scheduled executions e paused work; PAUSED em chamadas. Esses `seq` são locais a cada tabela, não cursor global de eventos.

## 3. Divergências e riscos encontrados antes de implementar

| Tipo / risco | Documentação ou expectativa | Realidade e tratamento proposto |
| --- | --- | --- |
| Drift / alto | M7-PREP promete cursor ordenado e replay sem perda | `events.id` e `outbox.id` são UUID; timestamp não ordena commits. Criar journal de projeção, não usar `MAX(occurred_at,id)` como watermark. |
| Drift / alto | Eventos bastariam para reconstituir tudo | `recordAgentStateChange` faz UPDATE e publish separados; pagamento atualiza ledger/status sem emitir `PAYMENT_CONFIRMED`. Reconciliar tabelas além de consumir eventos. |
| Lacuna / alto | Todos os agentes mostram atividade ao vivo | Escritores de `AGENT_STATE_CHANGED` encontrados em desenvolvimento/revisão, não em Caçador/Diretor. Não fabricar SEARCHING/THINKING a partir de demanda pendente. |
| Lacuna / médio | `stateSince`, `startedAt` sempre conhecidos | Campos obrigatórios na UI não existem como colunas. Atualização genérica não é início da atividade. Aceitar null e proveniência explícita. |
| Drift / alto | Task atribuída identifica quem revisa | `assigned_agent_id` continua no desenvolvedor durante revisão. Revisor é identificado no handler/eventos e fase IN_REVIEW. Não duplicar task ativa nos dois agentes. |
| Drift / médio | Breaker PLANNED e global | M6 implementa SOURCE/AGENT, com históricos próprios. Resumir sem esconder o escopo nem executar probes. |
| Drift / médio | PREP e UI usam mesmo contrato | PREP usa envelope snake_case, `taskId`, métricas extras e versão 1.0.0; UI usa camelCase, `id`, workstations e invalidação local. Reconciliar explicitamente; não copiar o PREP. |
| Compatibilidade / alto | Adicionar adapter sem tocar em React/Phaser | Interface permite injeção, mas App/Dashboard têm rótulos DEMO fixos; hook não trata rejeição; OfficeCanvas destrói/recria Game em cada snapshot. Necessários ajustes mínimos de apresentação/lifecycle, sem acoplamento ao backend. |
| Segurança / alto | Reutilizar `/events` e timeline existente | Retornam payloads de domínio. Office terá DTO allowlisted próprio; essas rotas não compõem seu datasource. |
| Evidência / médio | AUTONOMY_ENABLED prova Worker operando | API e Worker carregam Constituição separadamente. Projeta-se configuração da API, não saúde/atividade efetiva do Worker. |

Peça central ainda inexistente: projeção viva com sincronização confiável. Estratégia: integração incremental ao lado da fixture; não reconstrução visual. Correções de instrumentação do domínio ficam fora desta proposta inicial, sujeitas a decisão separada.

## 4. Arquitetura proposta e escopo negativo

```text
Tabelas do domínio + eventos persistidos + configuração pública selecionada
              ↓ leitura consistente / reconciliação periódica
apps/api/src/office — projection + journal PostgreSQL
              ↓ mesma revisão persistida
GET /office/snapshot      GET /office/stream (upgrade WebSocket)
              ↓                 ↓ replay + tail
LiveOfficeDataSource — cache, validação, cursor, reconexão
              ↓ OfficeDataSource (contrato de apresentação)
React / Phaser — nenhuma consulta SQL, regra financeira ou cliente concreto
```

**Escolha:** query/projection service com último snapshot persistido e journal durável. Query direta resolveria snapshot isolado, mas não replay/restart; Redis Pub/Sub perderia mensagens offline; reconstruir somente de eventos perderia mutações sem evento. A persistência específica resolve essas diferenças sem mudar M1–M6.

Local: `apps/api/src/office/`, pois a API é o único consumidor desse serviço. Um pacote pequeno `packages/office-contract` guarda apenas DTOs/schema seguros para browser; nenhum import de PostgreSQL, Redis, Governor, filesystem ou ambiente. Evitar criar um microsserviço ou reutilizar o barrel Node de `shared` no bundle cliente.

O projector roda em timer próprio da API, mesmo com autonomia desligada ou Emergency Stop. Ele só lê o domínio e grava tabelas `office_*`. Não agenda jobs de negócio; múltiplas APIs são serializadas pelo head da projeção. Não instalar consumidor concorrente na fila do orquestrador.

**Não tocar:** arte, paleta, planta, personagens, regras financeiras/Constitution, autoridade, máquinas de estado, Worker/orquestrador, ações de Stop, Agent Factory, M8, secrets ou `.env`. Sem merge, rebase, checkout, push ou migration aplicada nesta etapa. A implementação futura só começa com decisão do owner.

## 5. Fontes e regras da projeção

### 5.1 Agentes, tarefas e estações

| Campo | Fonte e regra determinística |
| --- | --- |
| Identidade/papel/responsabilidade | Existência/ID/papel vêm de `agents`, não de quatro agentes inventados pela fixture. Normalizar papel desconhecido para OUTRO. Nome/responsabilidade persistidos são a fonte de domínio, mas sua exposição inicial usa somente metadata pública aprovada por ID (§10), sem copiar texto livre. |
| Lifecycle | `agents.lifecycle_status`; histórico só fornece evidência. Não promover por performance; não chamar LifecycleService. ARCHIVED é suportado na leitura, embora M6 não o produza pelo serviço. |
| Estado operacional | `agents.state`, com fallback UNKNOWN. É **estado reportado**, não liveness. Não transformar Stop/circuito/pausa em FAILED. Não limpar SUCCESS/FAILED automaticamente por passagem de tempo. |
| Tempo do estado | `stateSince: null` na primeira integração: não há garantia de instante da transição. Expor opcionalmente `lastStateReportAt` quando há evento válido e coerente, sem chamá-lo de início exato. |
| Desenvolvedor: tarefa | Somente task atribuída a ele e IN_PROGRESS; exige candidato único. ASSIGNED é demanda, não execução. Zero candidatos → null; múltiplos → null + qualidade AMBIGUOUS, sem escolher arbitrariamente a mais recente. |
| Revisor: tarefa | Task IN_REVIEW com evidência REVIEW_STARTED ou AGENT_STATE_CHANGED aplicada, vinculada a task e ao revisor real. No V1, handler usa REVISOR-001; não atribuir automaticamente a qualquer agente do mesmo papel. Mesma regra de unicidade. |
| Caçador/Diretor: tarefa | null: o fluxo de oportunidade não é uma task atribuída a esses agentes. Timeline mostra progresso de oportunidade; não simular currentTask. |
| Pausa | Ler `paused_work` não retomado e vincular por job/entity ao candidato. Ocultar tarefa como execução atual durante pausa e marcar disponibilidade PAUSED na projeção; estado reportado fica intacto. Discovery não possui o mesmo registro de pausa retomável. |
| Tempos da task | `startedAt: null` quando não há evidência válida; evento TASK_STARTED/REVIEW_STARTED fornece `lastActivityReportedAt`, não garante cronologia exata de tentativas. Nunca usar created_at como início. |
| Workstation | Metadata de apresentação derivada do mapeamento aprovado em `assets/office/layout.json`. Não há localização física no domínio. Usar IDs estáveis, sem coordenadas na API; fundadores ausentes/ARCHIVED não ocupam mesa, SLEEP preserva atribuição. Outros agentes sem mapeamento ficam sem estação. |

Disponibilidade/qualidade são metadados de projeção (`REPORTED`, `PAUSED`, `AMBIGUOUS`, `UNAVAILABLE`), não novos estados do domínio. Fase IN_PROGRESS isolada ainda pode representar execução interrompida: a UI não pode chamá-la de prova de Worker vivo. Um snapshot representa fatos persistidos, não rastreamento instantâneo de CPU.

O adapter recebe atribuições completas das estações, inclusive vazias, e o scene model não pode ressuscitar ocupação estática para agente ausente. Registrar mapeamento de IDs como apresentação compartilhada e teste de aderência ao layout; não replicar geometria ou gerar migrations de móveis.

### 5.2 REAL/SIMULATION

Já existe `ledgerBalanceCents` em `packages/finance/src/payment-service.ts`:

`cash = SUM(REVENUE + FOUNDER_SUBSIDY - OPERATING_COST)`, filtrado por `ledger_scope`.

- Reutilizar a função; ela aceita `Pool`, embora só use query. Propor generalização estritamente tipada para `Queryable`, sem mudar SQL/regra, para ler na mesma transação da projeção. Esse pequeno ajuste de infraestrutura de leitura requer aprovação junto do plano.
- `reserveCents`, `operationsCents`, `expansionCents` são somas das respectivas ALLOCATION no mesmo escopo. São **alocações acumuladas**, não saldo disponível de cada bolso; não há alocação de débitos por bolso no schema atual.
- Não somar ALLOCATION ao caixa. Não subtrair novamente reservas, tokens, model_calls ou tool_calls. Não inferir receita do status PAID ou reward_amount de oportunidade.
- Banco vazio com leitura bem-sucedida → zero; erro de banco → indisponível/stale, nunca zero fabricado. Caixa negativo é permitido pela projeção se constar do ledger; não truncar.
- Calcular agregados exatos no PostgreSQL/bigint; validar safe integer antes de converter para os números do contrato atual. Overflow → seção indisponível e diagnóstico interno, nunca arredondamento silencioso.
- Pagamentos externos seguem recusados por `confirmPayment`; M7 não habilita REAL nem pagamentos. REAL somente reflete linhas efetivamente existentes.
- Custos de IA, tokens, métricas de pipeline e performance previstas no PREP não são necessários aos cards aprovados; ficam fora desta entrega.

### 5.3 Governança

- Autonomia: booleano da Constituição carregada na API, `autonomia.AUTONOMY_ENABLED`; auto-spend: `permissoes.AUTO_SPEND`. Injetar só esses valores, nunca objeto de configuração completo. Rotular como configuração, sem afirmar Worker ativo.
- Emergency Stop: latest `emergency_stop_events.seq`, sem registro = CLEAR; erro = UNVERIFIABLE. Reutilizar leitura pura, não engage/release/releaseAndResume.
- Breaker: fold puro dos históricos por `(scope_type, scope_key)`, ordenados por `seq`. Reutilizar `foldBreaker`; **não** `admit` ou `AutonomyController.authorize`, que podem abrir probe/mutar estado.
- Resumo para o card: algum OPEN → OPEN; senão algum HALF_OPEN → HALF_OPEN; senão CLOSED, desde que a consulta tenha sucesso. Sem PLANNED no live. DTO inclui escopos allowlisted para não fingir um breaker global.
- Cooldown vencido não é automaticamente HALF_OPEN. Recomendação de Stop não é Stop engajado. Falha de leitura não vira false/CLOSED.
- API/Worker podem ter configurações carregadas em momentos diferentes. Primeira entrega não prova equivalência nem liveness; exibir origem API e registrar esse limite. Instrumentação compartilhada/fingerprint do Worker é decisão separada, não requisito escondido.

## 6. Eventos existentes e eventos do Office

Allowlist inicial de eventos fonte: `OPPORTUNITY_FOUND`, `OPPORTUNITY_VERIFYING`, `OPPORTUNITY_VERIFIED`, `OPPORTUNITY_EVALUATING`, `OPPORTUNITY_APPROVED`, `OPPORTUNITY_REJECTED`, `TASK_CREATED`, `TASK_ASSIGNED`, `TASK_STARTED`, `TASK_WAITING_SLOT`, `TASK_COMPLETED`, `TASK_BLOCKED`, `AGENT_STATE_CHANGED`, `IMPLEMENTATION_READY`, `REVIEW_STARTED`, `REVIEW_FAILED`, `REVIEW_PASSED`, `ACTION_BLOCKED`, `CIRCUIT_OPENED`, `CIRCUIT_HALF_OPEN`, `CIRCUIT_CLOSED`, `EMERGENCY_STOP_ENGAGED`, `EMERGENCY_STOP_RELEASED`, `EMERGENCY_STOP_RECOMMENDED`, `EMERGENCY_QUIESCENCE_EXCEEDED`, `WORK_PAUSED`, `WORK_RESUMED`, `AGENT_ACTIVATED`, `AGENT_WOKE`, `AGENT_SLEEP`, `RECOVERY_ACTION_TAKEN`, `RECONCILIATION_REPORTED`.

Cada tipo tem mapper explícito: IDs validados, tipo/data e resumo de template local. Não espalhar `payload`; resolver vínculos conforme produtor real: há `agentId` no payload sem `agent_id` na linha; alguns eventos de pausa só têm job/entity. Campo sem evidência fica ausente. `AGENT_STATE_CHANGED` traz `newState/applied`, não `previous_state`.

`AI_CALL_RECORDED`, `TOOL_CALL_RECORDED` e ticks não entram na timeline inicial; podem gerar volume e payload sensível sem benefício necessário. `PAYMENT_CONFIRMED`, criação/arquivamento e outros nomes do catálogo não provam produtor implementado; atualização financeira vem da reconciliação do ledger.

Não criar novos eventos **de domínio** para esta versão. Criar mensagem **de projeção** `OFFICE_UPDATED`, com substituições de seções alteradas (`agents`, `workstations`, `financial`, `governance`, `timeline`), nunca deltas monetários para somar no browser. A timeline mantém IDs de evento fonte e janela de 50 itens. Ordem de apresentação por `(occurredAt,id)` não deve ser confundida com ordem do cursor.

Snapshot periódico pode perder estados intermediários muito rápidos; o journal preserva revisões projetadas, não promete capturar toda microtransição sem instrumentação. Eventos fonte admissíveis são processados mesmo quando não alteram o estado final; a timeline é limitada, não ferramenta de auditoria histórica completa.

## 7. Contrato, snapshot e WebSocket

Contrato de transporte proposto `2.0.0`, reconciliado explicitamente com o PREP 1.0.0 não implementado. Manter forma camelCase de apresentação da UI dentro do envelope; não anunciar compatibilidade falsa com o documento antigo.

`GET /office/snapshot` segue o padrão atual de rotas por recurso. Retorna `{ contractVersion, streamCursor, revision, snapshot }`, header `X-Office-Contract-Version`, `Cache-Control: no-store`. `revision` decimal em string; snapshot LIVE contém metadata de qualidade/última observação. Ambos os escopos financeiros sempre presentes; sem parâmetros de filtros no primeiro release para não multiplicar cursores.

Tipos a reconciliar: `mode: DEMO | LIVE`, datas sem evidência nullable, qualidade de cada seção e conexão; valores de governança indisponíveis não podem ser convertidos para falso. Fixtures continuam válidas por defaults explícitos de modo DEMO/qualidade conhecida. Envelopes e mensagens WS são distintos do `OfficeEvent` local.

`GET /office/stream` com upgrade WebSocket na API Fastify é compatível com a topologia; exige plugin compatível com a versão instalada, validado antes da instalação. Não selecionar versão por memória. Nenhuma infraestrutura nova.

Protocolo:

1. Cliente obtém snapshot S com cursor C, instala ambos atomicamente no cache.
2. Abre WS e envia `SUBSCRIBE { clientVersion, afterCursor: C }`, único comando permitido.
3. Servidor valida versão/cursor e captura head H do journal, envia `SYNC_START { throughCursor: H }`.
4. Envia revisões `(C,H]` em ordem, cada `OFFICE_UPDATED { baseCursor, cursor, revision, changes }`.
5. Envia `SYNC_COMPLETE { cursor: H }`, continua buscando journal após último enviado. Não alternar replay→Pub/Sub não durável.
6. Cliente valida/aplica replacement e cursor numa só operação, então notifica assinantes locais. `getSnapshot()` devolve cache, não novo GET por evento.

Heartbeat de transporte a cada 15 s, timeout de 45 s, não avança cursor nem simula atualização de domínio. Inclui idade da última projeção para detectar API viva com projector parado. Valores são proposta inicial configurável.

## 8. Cursor, consistência e recuperação sem gap

Não há identidade/ordenação global existente adequada: UUID v4 não ordena commit; `occurred_at` é instante de insert; `outbox.available_at` é agendamento e SKIP LOCKED permite outra ordem. `seq` de Stop/breaker não cobre tasks/ledger. Adicionar somente `BIGSERIAL` em events também não resolve transação que recebe número menor e commita depois.

### Migration proposta: `0014_office_projection` (não criada/aplicada agora)

Três tabelas próprias, sem alterar tabelas de negócio:

- `office_projection_head`: singleton, epoch UUID persistente, revision bigint, snapshot JSONB sanitizado, observed_at, mínimo cursor ainda recuperável, versão do contrato.
- `office_stream_entries`: PK `(epoch, revision)`, payload sanitizado, created_at. Revisões monotônicas atribuídas dentro do lock do head, não por sequência independente.
- `office_event_receipts`: PK `source_event_id`, identificando eventos fonte já considerados. Recibos e journal entram na mesma transação; recibos não somem ao expirar replay.

Algoritmo de cada tick (proposta: 1 s, sem overlap):

1. Abrir transação REPEATABLE READ; bloquear head `FOR UPDATE` **antes de qualquer leitura de domínio**. O helper atual `infrastructure/database/src/transaction.ts` usa BEGIN simples: configurar isolamento no início do callback, antes da primeira query, sem mudar o padrão global. Conflito de serialização → rollback completo e retry limitado; nunca aproveitar leituras da tentativa anterior.
2. Ler entidades/ledger/governança e eventos elegíveis ainda sem recibo (`NOT EXISTS` por ID). Não limitar seleção com timestamp máximo processado. Batch de eventos 200, seguido de outro tick se houver backlog.
3. Projetar por allowlist, calcular alterações de seções; eventos desconhecidos não são transformados em instruções nem erro fatal.
4. Se mudou: incrementar revisão do head, gravar journal + snapshot + recibos no mesmo commit. Se nada mudou: atualizar observed_at/recibos sem revisão artificial. Snapshot response usa observed_at do mesmo head para informar frescor.
5. Locks ordenam os commits do journal entre APIs; `epoch` só muda numa reconstrução explícita, não em restart normal. Rollback não publica revisão.

Bootstrap lê snapshot consistente e janela recente; registra recibos dos eventos elegíveis visíveis nessa mesma transação. Evento que ainda não commitou não recebe recibo e será encontrado depois, mesmo com data antiga. Dimensionar bootstrap e anti-join por EXPLAIN em dados de teste; não prometer custo constante em histórico ilimitado.

O snapshot inicial é servido do **head persistido**, nunca de queries novas com cursor de outra transação. Se houve update entre GET e WS, ele está no journal após C. Enquanto uma conexão existe, replay e tail usam a mesma fonte durável; polling do journal não depende de notificação volátil.

Cursor opaco codifica versão/epoch/revisão; validação estrita de tamanho e formato no servidor. Não é token de autenticação. O cliente usa revisão numérica exata (BigInt internamente) e epoch validados; não ordena strings de cursor.

| Situação | Comportamento |
| --- | --- |
| Duplicata com mesma epoch e revisão já aplicada | Ignorar; não duplicar timeline nem saldo. |
| baseCursor diferente do último aplicado, revisão nova | Interromper aplicação e exigir snapshot; não aplicar fora de ordem. |
| Evento fonte desconhecido | Ignorar na projeção e contar diagnóstico seguro, sem repassar payload. |
| Mensagem WS desconhecida/malformada que pode mudar estado | Marcar incompatível e resync; se repetir, encerrar retries agressivos e pedir cliente atualizado. Não avançar cursor. |
| Estado de agente desconhecido em DTO válido | UNKNOWN; não quebrar a página nem inferir IDLE. |
| Versão major incompatível | Erro explícito; não loop infinito de snapshot. |
| Cursor futuro, outra epoch, expirado ou cadeia incompleta | `FULL_RESYNC_REQUIRED` com motivo enumerado, novo snapshot. |
| WS cai / servidor reinicia | Último cache visível como desatualizado; reconectar com último cursor aplicado. Epoch persiste; replay evita perda de revisões retidas. |
| Frontend reinicia | Novo snapshot; não persistir cursor sozinho em localStorage sem cache correspondente. |
| Banco falha / projeção envelhece | Não publicar zeros ou governança segura fictícia. Snapshot inicial 503 se nunca houve leitura válida; cache existente marcado stale. |
| Cliente lento | Limitar buffer (proposta 1 MiB/200 mensagens), sinalizar resync e fechar; não acumular memória indefinidamente. |

Retenção inicial proposta: até 24 h e no máximo 10.000 revisões (vale o limite que expirar primeiro), removendo apenas prefixo contíguo e atualizando o mínimo recuperável sob lock. Replay pinado por conexão não bloqueia limpeza: conferir lacunas e pedir resync. Recibos fonte persistem; uma futura política de arquivamento exige desenho próprio.

Garantias precisas: aplicação idempotente e sem lacuna dentro do journal retido; convergência de estado por reconciliação; não prometer exactly-once de rede, reconstrução de toda história do domínio ou atomicidade que os produtores existentes não oferecem.

## 9. LiveOfficeDataSource e preservação da UI

- Preservar `OfficeDataSource.getSnapshot(): Promise<OfficeSnapshot>` e `subscribe(handler): Unsubscribe`; `OfficeEvent` continua invalidação local. Transporte não chega aos componentes.
- Uma instância por provider; bootstrap single-flight; um socket e cache imutável compartilhados entre Dashboard, Inspector, Timeline e Canvas. Assinatura tardia recebe atualização/cache atual. Cleanup refcount, timers e reconnect cancelados ao desmontar; testar StrictMode.
- Atualização de qualidade/conexão também notifica a UI. Antes do primeiro snapshot, falha precisa de estado de erro neutro do hook/provider, não fixture ou snapshot de zeros. Depois dele, manter último cache com rótulo stale.
- Reconexão: backoff 1/2/4/8/16/30 s com jitter injetável, reiniciado após sincronização completa. Clock, fetch e WebSocket injetados nos testes. Não abrir um socket por chamada de getSnapshot.
- Modo explícito de build: `VITE_OFFICE_MODE=fixture|live`, fixture como padrão, valor inválido falha cedo. Base `/office` same-origin; proxy Vite somente para as duas rotas de leitura locais. Não expor variável de segredo ou URL de banco como VITE_*.
- Live offline não cai silenciosamente para DEMO. Reconexão nunca chama endpoint administrativo ou simulação.
- Ajustes mínimos necessários a aprovar: tipos/erro no hook, rótulos de modo/configuração/alocações/stale em App/Dashboard, disponibilidade no Inspector; atualização incremental da cena existente sem recriar Game, reiniciar animações PROBATION, perder seleção/pan/zoom ou alterar arte.
- O requisito viável é **React/Phaser não conhecerem backend concreto**, não literalmente zero linhas alteradas neles. Se o owner exigir zero mudança nesses arquivos, há bloqueio real: não há como comunicar indisponibilidade e preservar lifecycle contínuo com o código atual.

## 10. Segurança e allowlists

Office HTTP: somente GET snapshot e upgrade stream. WS: somente SUBSCRIBE, sem comando de agente/governança/financeiro. Requests para `/admin/*`, `/events`, `/diagnostics/*`, `/simulations/*`, `/opportunities/*/timeline` não integram o adapter nem o proxy Office.

Dados permitidos: IDs validados, papel/lifecycle/estado, nomes/responsabilidades de cadastro tratados como texto, tempos conhecidos, resumo de tarefa restrito, IDs de estação, agregados financeiros por escopo, configuração booleana selecionada, Stop/breaker sanitizados, timeline de templates. Campos extras rejeitados ou descartados por schema, sem spread de row/payload.

**Proposta conservadora para secrets:** no primeiro live, objetivo da task é um resumo local baseado em ID/fase, não o título externo bruto. Nomes/responsabilidades dos quatro fundadores usam metadados públicos aprovados por ID; desconhecidos usam ID/papel. Campo `untrustedExternal` fica ausente no live. Isso evita prometer que regex identifica todo segredo eventualmente colado num texto livre. Se o owner quiser títulos externos, precisa aprovar campo de texto público com limite, política de redaction e o risco residual; nenhuma regex garante ausência universal de credenciais.

Nunca expor `process.env`, config inteira, secrets de Stop, prompts/respostas LLM, headers HTTP, credenciais, URLs com query/token, stdout/stderr, stack traces, sandbox files, payloads externos brutos ou memória textual. Reasons da governança viram códigos/templates allowlisted, não mensagem de exceção.

UNTRUSTED_EXTERNAL continua não executável em fixture e em qualquer extensão futura: React text nodes/textContent; sem HTML/Markdown ativo, eval, URLs automáticas ou assets remotos. Testar `<img onerror>`, `<script>`, `javascript:`, texto de prompt injection e conteúdo longo como texto, nunca ação. Escapar HTML não remove secrets: são duas garantias diferentes.

Exposição proposta para M7: **loopback apenas** (padrão já é 127.0.0.1), validar Host/Origin por allowlist exata inclusive no upgrade; não confiar em bind isoladamente ou aceitar Origin curinga. Development usa proxy Vite /office; produção same-origin exige política de servir a UI/proxy definida antes de publicar. Não reutilizar FOUNDER_ADMIN_SECRET no browser. Acesso LAN/internet requer autenticação read-only e TLS aprovados separadamente; não fica implicitamente autorizado.

Limites sugeridos: snapshot 256 KiB, mensagem WS 256 KiB, SUBSCRIBE 2 KiB/5 s, máximo 8 conexões por cliente local e 64 totais. Textos públicos limitados; erro/oversize fecha com código genérico, sem payload em log. Permissões DB do projector: SELECT nas fontes e escrita somente nas tabelas office, nunca DML de domínio.

## 11. Arquivos previstos — só na execução aprovada

| Caminhos | Responsabilidade |
| --- | --- |
| `packages/office-contract/{package.json,tsconfig.build.json,src/index.ts,src/schema.ts}` | DTO/schemas, versão, envelopes e cursor, sem Node no cliente. |
| `apps/api/src/office/{queries,projection,timeline,workstations,journal,projector,stream}.ts` | Queries consistentes; mappers puros; mapping de apresentação; journal, timer e replay. |
| `apps/api/src/routes/office.ts` | Rotas read-only, validação de acesso/limites e protocolo. |
| `apps/api/src/{server,main,shutdown}.ts`, `apps/api/package.json` | Injeção, startup/shutdown limpos, dependência WS aprovada. |
| `infrastructure/database/migrations/0014_office_projection.{up,down}.sql` | Três tabelas de projeção/journal/recibos, índices e rollback isolado. Confirmar número livre na execução. |
| `packages/finance/src/payment-service.ts` | Somente tipo Pool → Queryable de ledgerBalanceCents; nenhuma mudança da regra, se aprovado. |
| `apps/office/ui/src/data/{LiveOfficeDataSource,createOfficeDataSource}.ts`, `types.ts`, `main.tsx` | Adapter, factory explícita, tipos compatíveis e injeção. |
| `apps/office/ui/src/hooks/useOfficeSnapshot.ts`, `context/OfficeDataContext.tsx` | Falha/stale/cleanup, sem detalhes de transporte. |
| `apps/office/ui/src/{App.tsx,components/Dashboard.tsx,components/Inspector.tsx,components/OfficeCanvas.tsx,util/OfficeSceneFactory.ts,office/scene-model.ts}` | Apenas rótulos corretos, qualidade e atualização da cena; arte/planta preservadas. |
| `apps/office/ui/{package.json,vite.config.ts}`, `pnpm-lock.yaml`, `tsconfig.json` se necessário | Dependência browser-safe, proxy restrito, integração de tipos. Workspace já inclui packages/*; não mudar sem necessidade. |
| `apps/api/test/office-projection.test.ts`, `packages/office-contract/test/schema.test.ts`, `tests/integration/office-{projection,stream,security}.test.ts` | Projeção pura, contrato, transações/replay e segurança. |
| `apps/office/ui/src/data/__tests__/LiveOfficeDataSource.test.ts`, testes existentes de componentes/cena | Adapter, modo fixture e regressão da UI. |
| `docs/M7-OFFICE-CONTRACT.md`, `docs/M7-INTEGRATION-HANDOFF.md`, `PROGRESS.md`, `QA.md` | Reconciliar contrato e registrar evidências reais, sem apagar histórico aprovado. |

## 12. Testes determinísticos e critérios de aceite

Mocks bastam para mappers/adapter, mas não provam isolamento/commit order. PostgreSQL real descartável é obrigatório para journal; testes de runtime completos usam Redis local já existente, sem chamadas externas pagas.

| ID | Cenário / assertiva obrigatória |
| --- | --- |
| I01 | Seed dos quatro agentes → IDs/papéis/lifecycle/estado reais; agente ausente não reaparece por fixture; UNKNOWN seguro. |
| I02 | Tasks ASSIGNED/IN_PROGRESS/IN_REVIEW/terminal/pausada → associação correta, sem duplicar revisor/desenvolvedor; múltiplos candidatos resultam AMBIGUOUS. |
| I03 | Datas ausentes permanecem null; Caçador/Diretor IDLE não viram ativos por demanda; SLEEP/ARCHIVED obedecem apresentação documentada. |
| I04 | Ledger: REVENUE 10000 + ALLOCATION 5000/3000/2000 → caixa 10000, não 20000; custo 1000 → 9000; subsídio +500 → 9500; REAL e SIMULATION separados; negativo/overflow/erro/zero distintos. |
| I05 | Stop engage/release e UNVERIFIABLE; breakers SOURCE/AGENT CLOSED/OPEN/HALF_OPEN; consulta não acrescenta eventos nem consome probe; AUTO_SPEND permanece false. |
| I06 | Update entre GET e SUBSCRIBE chega via replay; replacement aplicado uma vez; current snapshot/cursor correspondem à mesma revisão. |
| I07 | Duas conexões DB: A insere evento e espera; B commita outro antes; projector lê B; A commita depois → A também processado. Timestamp/UUID anterior não causa perda. Usar barriers, não sleeps arbitrários. |
| I08 | Dois projectors concorrentes + rollback/crash antes/depois do commit → revisões commitadas ordenadas, sem snapshot órfão; retry de serialização reabre transação. |
| I09 | Atualização de agents/ledger sem evento → reconciliação converge; evento duplicado → recibo/timeline únicos; payload malformado não vaza. |
| I10 | Disconnect, afterCursor, replay, restart API (epoch mantida), restart frontend (novo snapshot), cursor expirado/futuro/outra epoch e gap → caminhos distintos corretos. |
| I11 | Desconhecidos: evento fonte ignorado; mensagem WS desconhecida não aplicada; major incompatível não entra em retry infinito; AgentState novo → UNKNOWN. |
| I12 | Fake clock/fetch/socket: backoff, heartbeat perdido, stale, single-flight, unsubscribe, StrictMode; todos os componentes compartilham uma conexão. |
| I13 | Canários sintéticos em payload, errors, URLs, stdout/prompts → nenhum no snapshot, stream ou log; objetivos externos omitidos; schemas rejeitam campos fora da allowlist. Não usar secrets reais no teste. |
| I14 | XSS/prompt injection como texto na fixture; sem execução/rede externa; Host/Origin não permitido e mensagens de escrita recusados; Stop admin inacessível pelo adapter. |
| I15 | FixtureOfficeDataSource conserva testes; LIVE offline não retorna DEMO; React/Phaser não importam db/redis/backend/LiveOfficeDataSource concreto. |
| I16 | 100 atualizações de snapshot → um Game, seleção/pan/zoom preservados, entrada PROBATION não reinicia; Inspectors dos quatro agentes e viewports desktop/mobile comparados ao visual aprovado. |
| I17 | Retenção durante replay, slow client e limite de payload → resync ou rejeição explícita, sem consumo ilimitado; bootstrap e anti-join avaliados em histórico grande sintético. |
| I18 | Migração up/down isolada não altera dados/schema M1–M6; SELECTs Office não escrevem domínio; regressão completa existente permanece verde. |

**Execução futura:** unit `pnpm run test:unit`; tipos `pnpm run typecheck`; lint `pnpm run lint` e `pnpm --filter ui run lint`; build `pnpm run build`; teste focado `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/office-projection.test.ts tests/integration/office-stream.test.ts tests/integration/office-security.test.ts`; regressão `pnpm run test:integration`.

**Atenção ao ambiente:** o suporte atual de integração chama `loadEnvFile()` e `resetDatabase()` reverte migrations. Não executá-lo contra ambiente do dono nem contornar a proibição do `.env`. Na futura execução, usar checkout/ambiente de testes isolado sem `.env` real, com endpoints de teste explicitamente fornecidos e banco terminando `_test`; confirmar alvo antes do reset. Alternativamente, bootstrap específico aprovado que recebe conexões injetadas sem importar support.ts. Nenhuma migration operacional nesta auditoria.

Aceite exige I01–I18 com evidência executada, gates M1–M6, quatro Inspectors corretos e comparação visual sem mudança de arte. Guardar prints, console e rede em `qa/evidencias/M7-INTEGRATION/`, sem dados sensíveis. Prova do implementador entra como ALEGADO; revisão externa decide PASSOU. Warning Phaser permanece documentado, não motivação para refatoração extra.

## 13. Ordem de implementação — após aprovação

As etapas abaixo especificam entregáveis, teste vermelho/verde e checkpoints; não contêm patch de implementação nesta entrega, conforme pedido do owner.

### Etapa 0 — decisões e baseline [HITL]

- [ ] Aprovar escolhas da seção 14; definir branch/worktree de integração sem mover a pasta do outro agente.
- [ ] Confirmar novo HEAD/base e nenhum trabalho alheio pendente; executar gates existentes e capturar baseline visual antes de código.
- [ ] Preparar banco descartável sem ler `.env` real; provar guarda de `_test` e isolamento. Sem isso, não executar reset/migrations.

### Etapa 1 — contrato e mappers puros [HITL]

- [ ] Criar testes `packages/office-contract/test/schema.test.ts` e `apps/api/test/office-projection.test.ts` cobrindo I01–I05/I13; rodar unit e confirmar falha pelas funcionalidades ausentes.
- [ ] Definir DTO 2.0.0/qualidade/nullable, mappers e metadata de estações nos caminhos da seção 11; reconciliar `docs/M7-OFFICE-CONTRACT.md` antes do transporte.
- [ ] Executar os mesmos testes até verde, comparando resultados financeiros com `ledgerBalanceCents`; revisar allowlist campo a campo.
- [ ] Checkpoint: `feat(m7): Defina contrato e projeção de leitura`, trailer `Agente: codex` (ou autor real), hooks habilitados.

### Etapa 2 — persistência e ordenação [HITL]

- [ ] Escrever `tests/integration/office-projection.test.ts` com barriers de I06–I09/I17/I18; demonstrar que watermark de timestamp falharia no caso de commit tardio.
- [ ] Criar migration própria, queries transacionais e journal conforme seção 8; generalizar apenas assinatura de leitura financeira aprovada.
- [ ] Rodar teste focado até verde; testar reversibilidade somente no banco descartável e validar planos de consulta.
- [ ] Checkpoint: `feat(m7): Persista projeção e journal ordenado`, trailer de autor e hooks.

### Etapa 3 — REST/WS [HITL]

- [ ] Escrever testes `office-stream.test.ts` e `office-security.test.ts`: replay, reconnect, restart, limites, Host/Origin, nenhuma escrita de domínio; confirmar falhas antes da implementação.
- [ ] Instalar plugin WS compatível, ligar projector/lifecycle à API, criar duas rotas e protocolo exato da seção 7.
- [ ] Rodar I06–I14/I17 e regressão da API; interromper banco/projeção em teste e confirmar stale/503, sem segurança fictícia.
- [ ] Checkpoint: `feat(m7): Exponha snapshot e stream read-only`, trailer e hooks.

### Etapa 4 — adapter e modo explícito [HITL]

- [ ] Escrever `LiveOfficeDataSource.test.ts` com clock/socket/fetch falsos para I10–I15; executar unit focado e observar falhas esperadas.
- [ ] Implementar cache único, bootstrap, validação, replay/resync/backoff e factory; injetar em main, preservar FixtureOfficeDataSource.
- [ ] Executar testes de adapter e fixture, verificar zero acesso a endpoint fora da allowlist e zero credencial no bundle.
- [ ] Checkpoint: `feat(m7): Adicione fonte viva ao Office`, trailer e hooks.

### Etapa 5 — ligação visual sem redesign [HITL]

- [ ] Escrever regressões de I16 e estado offline; demonstrar teste falhando com recriação atual de Game.
- [ ] Aplicar somente ajustes mínimos listados na seção 9, sem editar pixel-art, art-tokens ou layout.
- [ ] Validar quatro agentes, seleção, zoom/pan, PROBATION, pausa, desconhecido e falha de conexão; comparar screenshots com `03e8b1f`.
- [ ] Checkpoint: `feat(m7): Preserve a cena durante atualizações vivas`, trailer e hooks.

### Etapa 6 — evidência e handoff [HITL]

- [ ] Executar todos os comandos da seção 12 no ambiente isolado e ler saídas; registrar falhas reais sem promover por alegação.
- [ ] Criar `docs/M7-INTEGRATION-HANDOFF.md`, atualizar PROGRESS/QA com SHAs e evidências sanitizadas; documentar limites remanescentes e warning Phaser.
- [ ] Revisão independente; checkpoint documental com trailer. Apresentar git status e pedir decisão de integração; nenhum merge automático.

## 14. Riscos e decisões para o owner

| Decisão | Recomendação | Limite / alternativa |
| --- | --- | --- |
| Projeção persistida e migration própria | Aprovar head+journal+recibos na API/Postgres | Sem persistência, abandonar garantia de replay/restart e sempre ressincronizar; não é a preferência pedida. |
| Honestidade de atividade | Mostrar estado reportado; aceitar ausência de telemetria precisa de Caçador/Diretor e de liveness | Exigir estados instantâneos dos quatro pede instrumentação separada de Worker/domínio, fora desta etapa. |
| Compatibilidade UI | Autorizar mínimos ajustes de labels/qualidade/lifecycle da cena, mantendo visual | Zero alteração literal em React/Phaser bloqueia apresentação live confiável. |
| Finanças | Reusar ledgerBalanceCents com Queryable; denominar alocações acumuladas | Não inventar saldo disponível por bolso nem regra financeira nova. |
| Conteúdo externo | Omitir texto livre externo no live inicial | Mostrar títulos requer política pública/redaction e aceite de risco residual de segredo embutido. |
| Acesso | Loopback/same-origin apenas no M7 | LAN/internet exige autenticação read-only, TLS e implantação explícita. |
| Contrato e carga | 2.0.0; tick 1 s; replay 24 h/10k; limites definidos acima | Calibrar com testes, sem prometer latência exata; anti-join/recibos crescem com histórico. |
| Branch de implementação | Definir após revisão deste plano | Não criar branch, incorporar PREP ou fazer merge automaticamente. |

Riscos adicionais: polling pode não capturar estado transitório; writers atuais não são globalmente atômicos; configuração carregada não comprova worker saudável; journal contém dados de operação mesmo sanitizados e precisa proteção no host; mudanças de contrato exigem snapshot novo; fila de eventos grande pode atrasar timeline sem tornar snapshot de entidades incorreto. Todos devem constar no handoff, não ser escondidos por animação ou fixture.

## 15. Cobertura das perguntas do owner

Q1–2: §5.1; Q3: §5.2; Q4: §5.3; Q5–6: §6; Q7–8: §4/8; Q9–10: §7; Q11–17: §7/8; Q18–19: §9; Q20–22: §10; Q23: §12/13. Decisões pendentes estão em §14. Este documento não autoriza sua própria execução.
