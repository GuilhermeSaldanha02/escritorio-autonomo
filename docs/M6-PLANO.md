# Milestone 6 — Autonomia · plano

- **Consulta prévia (ChatGPT, 2026-09-18):** a especificação trata o M6 numa única linha do roadmap ("Scheduler, retries, circuit breaker, recovery, Emergency Stop") e não define o Emergency Stop em nenhum outro lugar. Reabri a especificação, mapeei o que M1-M5 já cobrem (abaixo) e levei ao revisor cinco frentes com minhas inclinações e cinco perguntas. Respostas incorporadas neste documento: (A) o escopo ganha uma **sexta frente, a política de autonomia**; (B) **só humano** aciona e libera o Emergency Stop, e o circuit breaker nunca o aciona; (C) **não se cria um novo motor de retry**, só se formaliza e classifica o que existe; (D) o lifecycle automático inclui `SLEEP → ACTIVE` (reversível), sempre sob amostra mínima, histerese, cooldown e autorização do Governor; (E) o teste de composição entra **como critério desde o início**. O revisor autorizou escrever este plano, ainda sem código.
- **Este plano ainda não foi implementado nem revisado.** Próximo passo: revisão dos critérios pelo ChatGPT, depois autorização explícita do dono para começar o código, no mesmo processo do M2 a M5.

## Objetivo

> M6 prova que o Escritório consegue continuar operando, pausar com segurança, conter falhas, se recuperar e mudar o estado de seus agentes **sem ampliar nenhuma autoridade**.

O M6 muda **quando** o sistema age sozinho, nunca **o que** ele tem permissão de fazer. Isso separa o M6 do M5 (memória e economia), do M7 (a tela) e do M8 (dinheiro externo real).

## O que M1-M5 já cobrem (não duplicar)

| Peça | Estado atual |
|---|---|
| Retry de task | O Revisor devolve ao Desenvolvedor até `MAX_TASK_RETRIES`, depois `TASK_BLOCKED` (M2). É uma decisão **funcional**. |
| Retry técnico | `attempts` do BullMQ nos jobs do orquestrador, mais reentrega pelo outbox transacional (M2). |
| Espera de capacidade | `TASK_WAITING_SLOT` reagenda a task sem consumir retry (M2). |
| Recuperação de job travado | `lockDuration`/`stalledInterval` no worker e teste de crash recovery (M2). |
| Governor | Ações `CAPABILITY`, `SPEND`, `TASK_RETRY`, `TASK_START`, `TOOL_CALL` (M1-M3). Determinístico, nunca editado por agente. |
| Caçador | Job `discover-opportunities` com `SourceConnector` e `withSourcePolicy` (retry com backoff da fonte) (M4). **Nada o agenda.** |
| Performance de agente | `AgentPerformance` com `recommended_action` (M5). **Nada a agenda nem a aplica.** |
| Reconciliação | `reconcileFromDatabase` (M5). **Nada a chama.** |
| Eventos | `CIRCUIT_OPENED`, `BUDGET_EXHAUSTED`, `AGENT_SLEEP`, `AGENT_ARCHIVED` existem só no catálogo, **sem emissor**. |
| `agents.lifecycle_status` | Só recebe `ACTIVE` no seed. **Nenhuma transição existe.** |
| Scheduler, circuit breaker, Emergency Stop | **Não existem.** |

## Escopo: seis frentes

Scheduler, Emergency Stop, Circuit Breaker, Recovery, Lifecycle governado e Política de autonomia. Três conceitos que **não podem virar sinônimos**:

```
Emergency Stop  -> a empresa inteira para ações autônomas
Circuit Breaker -> uma fonte, um agente (escopo local)
Pausa / espera  -> não é falha
```

Um erro no conector do GitHub não dorme o Desenvolvedor nem para a empresa.

### 1. Política de autonomia (o controlador que decide se uma ação programada pode começar)

Todo tick do Scheduler, todo job de ação com efeito e toda transição automática passam por **um único ponto de decisão**, nesta ordem, e o primeiro que negar encerra:

```
1. Emergency Stop engajado, ou impossível de verificar?  -> NEGA  (fail-safe)
2. AUTONOMY_ENABLED = false?                              -> NEGA
3. Circuit breaker do escopo aberto?                      -> NEGA
4. Governor (a decisão que já existe) nega?               -> NEGA
5. caso contrário                                         -> PERMITE
```

`AUTONOMY_ENABLED` é **independente** de `AUTO_SPEND`: `AUTONOMY_ENABLED=true` com `AUTO_SPEND=false` é um estado válido (a empresa trabalha sozinha gastando R$0, sem autorização de gasto).

**Invariante 1 — autonomia não aumenta autoridade.** O controlador só acrescenta portões; nunca concede. Uma ação proibida em modo manual continua proibida em modo autônomo. `AUTONOMY_ENABLED=true` nunca amplia capacidades, orçamento, permissão de gasto, permissões do Tool Gateway nem autoridade financeira. Isso é uma propriedade testável: para toda ação governada, *decisão autônoma permitida implica decisão manual permitida*.

**Invariante 2 — pausa não é falha.** Emergency Stop, circuito aberto, capacidade indisponível e Scheduler desligado **não degradam `AgentPerformance`**, não consomem retry e não contam como falha de circuito. Sem isso nasce um ciclo: circuito aberto, agente não trabalha, performance piora, agente vai para `SLEEP` sem ter errado de novo.

### 2. Scheduler

- Jobs repetíveis do BullMQ, com **identidade lógica idempotente por execução agendada** persistida no Postgres (`schedule` + janela de tempo, `UNIQUE`). O contrato é a identidade persistida, não um formato de `jobId`: reentrega, dois schedulers ou ticks concorrentes produzem **um efeito só**.
- Agenda: descoberta de oportunidades, reconciliação (só detecta), janelas de `AgentPerformance`, varredura de recovery e avaliação de lifecycle.
- Frequências na Constituição, nunca no código. **Desligado por padrão** (`AUTONOMY_ENABLED=false`).
- Todo tick passa pela política de autonomia. Tick negado grava o motivo (`DISABLED`, `EMERGENCY_STOP`, `STOP_UNVERIFIABLE`, `CIRCUIT_OPEN`, `GOVERNOR_DENIED`) e **não é falha**.
- Relógio injetável: os testes chamam o tick diretamente com um `now` controlado, sem esperar tempo real.

### 3. Emergency Stop

- Estado **persistido no Postgres**, append-only (`ENGAGED`/`RELEASED` com ator, motivo e instante). O estado atual é a última linha. Funciona com o Redis fora do ar.
- **Só autoridade humana** aciona e libera. Nenhum agente, scheduler, breaker ou handler tem caminho para isso. Componentes determinísticos podem apenas **recomendar** (`EMERGENCY_STOP_RECOMMENDED`, com motivo e evidência); no M6 nada dispara o Stop sozinho.
- **Fail-safe:** se o estado não puder ser lido, nenhuma ação mutável começa. Health, diagnóstico e leitura continuam funcionando, justamente para recuperar o sistema.
- **O que `ENGAGED` bloqueia:** nova descoberta, `TASK_START`, `TASK_RETRY`, execução no Tool Gateway, novas chamadas de IA, automação de lifecycle e os próprios ticks do Scheduler. **O que não bloqueia:** observabilidade, health, leitura, e a infraestrutura continua de pé.
- **Quiescência, sem matar de forma abrupta:** um job em andamento termina seu passo atômico atual; os passos seguintes ficam **adiados** (`EMERGENCY_PAUSE`), não falhos e sem consumir retry. `RELEASE` retoma tudo sem duplicar nada.
- **Decisão em aberto para a revisão:** como o humano se autentica. Proposta: um comando de CLI que escreve direto no Postgres (sem superfície de rede) e, opcionalmente, uma rota da API protegida por segredo do fundador vindo do ambiente e desligada se o segredo não existir.

### 4. Circuit Breaker

- Estado persistido por **escopo** (`SOURCE`, `AGENT`), `CLOSED → OPEN → HALF_OPEN → CLOSED`, sobrevive a restart. Limiares na Constituição. Relógio injetável.
- **`SOURCE`:** alimentado só por falhas **técnicas** da fonte (indisponível, rate limit esgotado, drift de schema).
- **`AGENT`:** alimentado por desfechos terminais de task que vêm das `Experience` (evidência do M5), nunca por pausa ou espera.
- Aberto, bloqueia **só o seu escopo**, emite `CIRCUIT_OPENED`. `HALF_OPEN` permite uma única sonda.
- **Nunca aciona o Emergency Stop.**

### 5. Retries (formalizar, não reconstruir)

Três fenômenos diferentes hoje se parecem: retry de task (decisão do Revisor), retry do BullMQ (falha técnica) e espera de slot. O M6 os **classifica** e impede que se misturem:

```
BUSINESS_RETRY   -> falha funcional (Revisor)      -> CONSOME MAX_TASK_RETRIES
TECHNICAL_RETRY  -> falha de transporte/infra      -> não consome
CAPACITY_WAIT    -> sem slot (TASK_WAITING_SLOT)   -> não consome
CIRCUIT_BLOCK    -> circuito aberto no escopo      -> não consome
EMERGENCY_PAUSE  -> Emergency Stop                 -> não consome
```

Trabalho novo é só: política explícita de backoff técnico com jitter e limites, classificação retryable/não-retryable, alimentar o circuit breaker com falhas técnicas relevantes, e **provar** cada classe que não consome retry.

### 6. Recovery

- Varredura **idempotente**, no boot e periódica, **só de estado técnico**: task sem job vivo é re-despachada de forma idempotente; reserva `RESERVED` velha é liberada; sandbox vazado é removido.
- **Nunca toca em fato econômico** (ledger, pagamento, oportunidade `PAID`), coerente com a reconciliação do M5 que só detecta.
- Repetir a varredura, ou rodá-la em paralelo, não muda o resultado.

### 7. Lifecycle governado

- O M6 implementa o **serviço de transição** autorizado pelo Governor, com histórico append-only (evidência: ids das avaliações de performance) e eventos.
- Automático: `PROBATION → ACTIVE`, `ACTIVE → SLEEP` e `SLEEP → ACTIVE`, **sempre** sob amostra mínima, histerese, cooldown, evidência de `AgentPerformance` e autorização do Governor. Uma avaliação ruim isolada resulta em `KEEP`; só desempenho ruim persistente leva a `SLEEP`.
- **Amostra insuficiente nunca conta como desempenho ruim.** Hoje o M5 devolve `INVESTIGATE` tanto para amostra pequena quanto para desempenho ruim; o controlador precisa distinguir os dois (a amostra já vem em `sampleSize`), senão uma janela sem atividade dormiria o agente.
- **Janelas que se sobrepõem a uma pausa** (Emergency Stop ou circuito aberto do agente) não são elegíveis para transição negativa (invariante 2).
- **Sair de `SLEEP` não pode depender só de novo desempenho**, porque um agente dormindo não gera `Experience`. A condição de despertar é definida no plano de implementação (cooldown vencido mais demanda para o papel dele), ou o humano acorda. Nenhum agente sai de operação de forma permanente sem intervenção humana.
- **Fora do M6:** `SLEEP → ARCHIVED`, criação de agente (Agent Factory) e remoção.

## Fora do M6 (fronteira)

Agent Factory, `ARCHIVED` automático, dinheiro real, auto-spend, Office Projection e WebSocket (M7), embedding real, Cost Accounting. `AlgoraEvidenceEnricher` e `CONFLICTING` seguem como backlog do M4 sem milestone atribuído. `AI_MODE` continua `mock` e o custo externo R$0.

## Critérios de aceite do M6

| # | Critério |
|---|---|
| 1 | Existem agendas para descoberta, reconciliação (só detecta), janela de performance, varredura de recovery e avaliação de lifecycle, com frequências vindas da Constituição. **Nenhuma roda com `AUTONOMY_ENABLED=false`**, que é o padrão. |
| 2 | Cada execução agendada tem identidade lógica idempotente persistida; reentrega, dois schedulers e ticks concorrentes produzem um único efeito. |
| 3 | Todo tick passa pela política de autonomia; tick negado grava o motivo e **não é tratado como falha**. |
| 4 | O tempo do Scheduler é injetável: os testes são determinísticos, sem espera real. |
| 5 | Emergency Stop é persistido, append-only, com ator e motivo. **Só humano** aciona e libera; nenhum agente, scheduler, breaker ou handler tem esse caminho. O mecanismo de autenticação está especificado. |
| 6 | Com o Stop engajado, nada do que ele bloqueia começa: descoberta, `TASK_START`, `TASK_RETRY`, Tool Gateway, chamadas de IA, lifecycle automático e ticks. Health, diagnóstico e leitura continuam. |
| 7 | **Fail-safe:** se o estado do Stop não pode ser lido, nenhuma ação mutável começa. O Stop funciona com o Redis fora do ar. |
| 8 | Quiescência: job em andamento termina o passo atômico atual; os seguintes ficam adiados (`EMERGENCY_PAUSE`), sem falhar, sem consumir retry e sem matar sandbox de forma abrupta. `RELEASE` retoma sem duplicar. |
| 9 | Componentes determinísticos só podem **recomendar** o Stop (`EMERGENCY_STOP_RECOMMENDED`); nada o aciona sozinho, e o circuit breaker nunca o aciona. |
| 10 | Circuit breaker persistido por escopo (`SOURCE`, `AGENT`), `CLOSED/OPEN/HALF_OPEN`, limiares constitucionais, relógio injetável, sobrevive a restart. |
| 11 | Circuito aberto bloqueia **só o seu escopo** e emite `CIRCUIT_OPENED`. Fonte aberta não para o Desenvolvedor nem a empresa. `HALF_OPEN` permite uma única sonda. |
| 12 | O breaker é alimentado só por falhas técnicas (fonte) e por desfechos terminais vindos das `Experience` (agente). Pausa, espera de capacidade e Emergency Stop **nunca** contam como falha. |
| 13 | Retries classificados (`BUSINESS_RETRY`, `TECHNICAL_RETRY`, `CAPACITY_WAIT`, `CIRCUIT_BLOCK`, `EMERGENCY_PAUSE`); **só o primeiro** consome `MAX_TASK_RETRIES`, com prova para cada classe que não consome (espera de slot, reentrega do BullMQ, Stop, circuito aberto). |
| 14 | Política de backoff técnico formalizada (backoff, jitter, limites, retryable/não-retryable), sem criar outro motor de retry. |
| 15 | Recovery no boot e periódico, só de estado técnico: task sem job vivo re-despachada, reserva `RESERVED` velha liberada, sandbox vazado removido. Nunca toca ledger, pagamento nem oportunidade `PAID`. Repetir ou paralelizar não muda o resultado. |
| 16 | Prova de crash: derrubar o processo no meio do ciclo e, depois do recovery, o ciclo termina **sem** evento, job, `Experience` ou lançamento duplicado. |
| 17 | O controlador de lifecycle só faz `PROBATION → ACTIVE`, `ACTIVE → SLEEP` e `SLEEP → ACTIVE` sob amostra mínima, histerese, cooldown, evidência de `AgentPerformance` e autorização do Governor; o histórico é append-only, com a evidência e evento. |
| 18 | Amostra insuficiente nunca conta como desempenho ruim, e janela sobreposta a uma pausa não vale para transição negativa: **não existe o ciclo** "circuito aberto → agente parado → performance cai → `SLEEP`". |
| 19 | Sair de `SLEEP` não depende só de novo desempenho, e nenhum agente sai de operação de forma permanente sem intervenção humana. |
| 20 | `SLEEP → ARCHIVED`, criação e remoção de agente **não existem** no código do M6. |
| 21 | **Autonomia não aumenta autoridade:** propriedade testada de que, para toda ação governada, decisão autônoma permitida implica decisão manual permitida. `AUTONOMY_ENABLED=true` não muda capacidades, orçamento, gasto nem permissões do Tool Gateway; `AUTO_SPEND` continua independente. |
| 22 | Custo externo R$0, `AI_MODE=mock`, nenhum pagamento real. |
| 23 | **Teste de composição de autonomia**, determinístico, sobre o ciclo real (Postgres, Redis, BullMQ e Docker): `AUTONOMY_ENABLED` → tick → descoberta → orquestrador → task → `Experience`; e, com condições controladas, (a) falha técnica repetida abre o circuito e bloqueia só aquele escopo, com o tick registrando o motivo, depois `HALF_OPEN` e `CLOSED`; (b) Stop engajado no meio do ciclo pausa sem falhar e, liberado, completa sem duplicar; (c) recovery depois de um crash simulado. Não precisa ser um único cenário gigante, mas ao menos uma prova atravessa Scheduler, controles de autonomia e orquestrador. |
| 24 | Regressão M1-M5 verde. |

## Prioridade de mutation testing

- **`EMERGENCY STOP BYPASS`** — cada ação bloqueada (descoberta, `TASK_START`, `TASK_RETRY`, Tool Gateway, IA, lifecycle, tick) começa com o Stop engajado.
- **`FAIL-SAFE`** — estado do Stop ilegível e a ação mutável começa.
- **`AUTO-ENGAGE`** — qualquer componente que aciona ou libera o Stop.
- **`SCHEDULER DOUBLE-RUN`** — a mesma janela executada duas vezes.
- **`AUTHORITY WIDENING`** — modo autônomo permitindo o que o manual nega.
- **`BREAKER SCOPE LEAK`** — circuito de uma fonte bloqueando outro escopo.
- **`PAUSE COUNTED AS FAILURE`** — pausa, espera ou Stop alimentando o breaker, o retry ou a performance.
- **`RETRY CLASS CONSUMPTION`** — classe que não deveria consumir `MAX_TASK_RETRIES` consumindo.
- **`RECOVERY DUPLICATION`** — recovery duplicando job, evento ou `Experience`.
- **`LIFECYCLE INSUFFICIENT SAMPLE`** — amostra pequena dormindo um agente.
- **`LIFECYCLE COOLDOWN/HYSTERESIS`** — transições em vaivém.
- **`SLEEP LOCK-IN`** — agente dormindo sem caminho de volta.

## Decisões em aberto para a revisão

1. Autenticação do humano no Emergency Stop (CLI direta no Postgres, com rota da API opcional protegida por segredo do fundador).
2. Condição de despertar de `SLEEP` (cooldown vencido mais demanda para o papel, ou humano).
3. Valores iniciais dos limiares do circuit breaker e do lifecycle na Constituição.
4. Se a identidade idempotente do Scheduler fica numa tabela própria (proposta) ou só no `jobId` do BullMQ.
5. Política de quiescência: tempo máximo que um passo em andamento pode terminar depois do `ENGAGE`.

## Processo

Mesmo do M2 a M5: este plano, revisão do ChatGPT sobre os critérios, autorização explícita do dono, implementação com mutation testing por garantia, relatório de fechamento, revisão externa final, autorização do dono e só então o merge. **O M6 não começa a ser implementado sem essa autorização.**
