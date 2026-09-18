# Milestone 5 — Memória + Economia · plano

- **Consulta prévia (ChatGPT, 2026-09-18):** a especificação só tem uma linha de roadmap para o M5 ("pgvector, experiências, performance, ledger e reconciliação"), sem critérios de aceite detalhados. O escopo, a arquitetura e os 20 critérios abaixo vêm dessa consulta — feita depois de reabrir a especificação original e mapear o que M1-M4 já cobrem, exatamente como recomendado ao fechar o M4.
- **Segunda rodada (mesmo dia): plano aprovado, condicionado a 3 ajustes.** Depois de escrever a primeira versão deste documento, a revisão externa leu o arquivo completo e aprovou a direção, com 3 ajustes já incorporados abaixo: (1) política de arredondamento do split vira regra normativa, não exemplo; (2) `financial_ledger` ganha `ledger_scope` (`SIMULATION`/`REAL`) — dinheiro simulado nunca soma em caixa/receita real, nem hoje nem quando o M6 tomar decisões autônomas com base em saldo; (3) o `DeterministicEmbeddingProvider` prova infraestrutura vetorial, nunca qualidade semântica — o relatório de fechamento não pode alegar "memória semântica funcionando". Veredito literal: *"M5-PLANO — APROVADO COM 3 AJUSTES ANTES DO CÓDIGO [...] Com as três pequenas alterações [...] o plano fica APROVADO PARA IMPLEMENTAÇÃO."*
- **Implementado** na branch `feat/m5-memoria-economia`, autorizado pelo dono. Os 20 critérios estão atendidos; o critério 20 foi fechado por um teste de composição (`tests/integration/m5-composition.test.ts`) depois que a revisão externa recusou adiá-lo. Resultado e lacunas em `docs/M5-MEMORIA-ECONOMIA.md`. Falta a revisão final e a autorização do dono para o merge.

## Objetivo

> M5 prova que a empresa sabe lembrar e contabilizar. M6 decide quando agir autonomamente com base nisso. M8 prova que dinheiro externo entrou de verdade.

Essa separação de responsabilidade é deliberada e fecha uma fronteira que a especificação deixa implícita: M5 não decide nada sozinho (lifecycle automático de agente é M6), e não afirma receita real nenhuma (pagamento externo de verdade é M8). M5 constrói e prova o **mecanismo** — memória, avaliação de desempenho, ledger, reconciliação — com dado simulado explicitamente marcado como tal, do mesmo jeito que o M2 provou o ciclo completo com uma oportunidade simulada antes do M4 trazer dado real.

## O que M1-M4 já cobrem (não duplicar)

| Peça | Estado atual |
|---|---|
| `financial_ledger` (tabela) | Existe desde o M1. Nenhum código escreve nela ainda. |
| Enum de status de `opportunities` | Já inclui `SUBMITTED`/`ACCEPTED`/`PAYMENT_PENDING`/`PAID` como valores válidos desde o M1. Nenhum código transiciona para eles — o ciclo do M2/M3 vai só até a task `COMPLETED`. |
| `model_calls`/`tool_calls`/`budget_reservations` (M3) | Auditoria de custo **técnico** — separado de receita/caixa por desenho, não é o que o M5 mexe. |
| Extensão `pgvector` | Habilitada desde o M1. Nenhuma coluna `vector` usada ainda. |
| `memories`/`experiences`/`agent_performance` | Citadas na especificação (§12) como tabelas futuras "por migrations" — não existem. |
| Lifecycle de agente (`PROBATION`/`ACTIVE`/`SLEEP`/`ARCHIVED`) | Enum existe na tabela `agents` desde o M1. Nenhuma lógica de avaliação ou transição automática. |
| Reward/evidência de oportunidade (M4) | `reward_status`, elegibilidade, política de automação — sobre a oportunidade em si, não sobre pagamento recebido nem sobre a empresa. |

## Memória: experiência é fato, memória é conhecimento selecionado

Regra central, que evita o erro mais fácil de cometer aqui: **"task `COMPLETED`" nunca vira memória corporativa automaticamente.**

```
Task + attempts + review + events + model_calls + tool_calls
 → ExperienceBuilder (determinístico, sem IA)
 → Experience (fato histórico)
 → MemoryProposal
 → MemoryValidator
 → ACCEPTED / REJECTED
 → Corporate Memory (só se ACCEPTED)
```

- `Experience` é derivada só de evidência já persistida (nenhuma chamada de IA — `AI_MODE` continua `mock`): `task_id`, `agent_id`, `capability`, `outcome` (`SUCCESS`/`FAILURE`), `attempt_count`, `review_result`, `duration_ms`, `technical_cost`, `failure_codes[]`, `evidence_refs[]`, `created_at`.
- Reentrega/retry do BullMQ nunca duplica uma `Experience` — mesma disciplina de idempotência do M2/M3/M4.
- `MemoryValidator` é o gate — proposta de memória não vira memória corporativa sozinha, mesma lógica de "proposta passa por validação" do §8.7 da especificação.
- Conteúdo `UNTRUSTED_EXTERNAL` (M4) armazenado como evidência de uma experiência nunca ganha autoridade por estar ali — mesma regra do M4, sem exceção por estar num contexto novo.

### pgvector precisa ser usado de verdade, não só existir na migration

Recomendação explícita da revisão: `vector(...)` numa coluna sem busca de verdade não prova o que o roadmap pede.

```
Memory → embedding → pgvector → similarity search (top-K) → filtros de escopo
```

- `EmbeddingProvider` como abstração: `DeterministicEmbeddingProvider` (M5 — mesma entrada sempre produz o mesmo vetor, sem custo, sem rede) / `LocalEmbeddingProvider` e `ApiEmbeddingProvider` ficam para quando existir modelo real (fora do M5).
- Cada memória guarda `embedding_provider`, `embedding_model`, `embedding_version`, `embedding_dimensions` — embeddings de proveniências diferentes nunca são tratados como se pertencessem ao mesmo espaço vetorial silenciosamente.
- Recuperação filtrável por escopo (empresa/agente/task/capability) sem vazar conhecimento entre escopos indevidos.

**Ajuste 3 da revisão externa — o que o M5 prova, sem exagerar:** um vetor determinístico (por hash/algoritmo artificial) prova armazenamento vetorial, compatibilidade dimensional, filtragem por escopo, cálculo de distância e recuperação top-K funcionando — **não prova qualidade de recuperação semântica**. O relatório de fechamento do M5 nunca pode dizer "memória semântica funcionando"; a frase correta é "infraestrutura de memória vetorial funcionando". Busca semanticamente útil só é verdade quando um `EmbeddingProvider` real (`Local`/`Api`) existir, fora do M5.

## Performance de agente: M5 calcula, M6 decide

```
AgentPerformance
├── tasks_completed / tasks_failed
├── success_rate / review_pass_rate / retry_rate
├── avg_duration / technical_cost
└── janela temporal
```

M5 pode produzir uma `AgentPerformanceAssessment` com `recommended_action` (`PROMOTE`/`KEEP`/`INVESTIGATE`) — puramente determinística e explicitamente uma recomendação. **M5 nunca executa** `PROBATION → ACTIVE`, `ACTIVE → SLEEP` nem `SLEEP → ARCHIVED` sozinho; transformar avaliação em ação autônoma é M6 (Scheduler/Governor), consistente com a linha do roadmap que separa "M5 — memória + economia" de "M6 — autonomia".

## Economia: ledger é fato, não estado mutável

```
Ledger        = fatos econômicos (append-only)
model_calls / tool_calls = telemetria técnica (M3, já existe)
budget_reservations      = controle de autorização de gasto (M3, já existe)
```

Nunca misturar as três camadas. `balance` é sempre derivado (`SUM(credits) - SUM(debits)`), nunca um campo mutável tipo `UPDATE company SET balance = ...`. Ledger continua append-only (§9 da especificação, já vale desde o M1): erro contábil se corrige por linha de reversal/compensação, nunca reescrevendo histórico.

### Dinheiro nunca em ponto flutuante

Representação em centavos inteiros (`10101` para R$101,01), nunca `float`.

**Política de arredondamento (ajuste 1 da revisão externa — normativa, não exemplo):**

```
RESERVE     = floor(revenue * 50 / 100)
OPERATIONS  = floor(revenue * 30 / 100)
EXPANSION   = floor(revenue * 20 / 100)
remainder   = revenue - RESERVE - OPERATIONS - EXPANSION
RESERVE    += remainder
```

Invariante obrigatória, sempre, centavo a centavo, nunca aproximado: `RESERVE + OPERATIONS + EXPANSION == REVENUE`. Fechada aqui para que a implementação não precise decidir isso no meio do código.

### `SIMULATION` e `REAL` são escopos de ledger isolados desde o M5 (ajuste 2 da revisão externa)

Não basta marcar `PaymentEvidence` como `SIMULATED`/`TEST` — o isolamento precisa existir também no lado do ledger, para que nenhuma leitura futura (inclusive decisões autônomas do M6) confunda dinheiro simulado com caixa real:

```
SIMULATED PaymentEvidence → lançamentos de escopo SIMULATION → SIMULATION balance
EXTERNAL_VERIFIED PaymentEvidence → lançamentos de escopo REAL → REAL cash/revenue
```

Todo lançamento de `financial_ledger` carrega um `ledger_scope` (`SIMULATION`/`REAL`). `available_real_cash`, `external_revenue` e qualquer futura métrica de `SELF_SUSTAINING` só somam lançamentos de escopo `REAL` — nunca `SIMULATION`. No M5, só o caminho `SIMULATION` existe; o M8 é quem introduz o primeiro lançamento `REAL`. O motivo concreto: no M6, quando o Diretor começar a tomar decisões autônomas com base em saldo, ele nunca pode achar que a empresa tem R$500 porque um teste econômico do M5 colocou R$500 no ledger.

### `PAID` é alcançável no M5 — só com pagamento explicitamente simulado

```
PaymentEvidence (SIMULATED no M5 / EXTERNAL_VERIFIED no M8)
 → PaymentConfirmationService
 → State Machine (SUBMITTED → ACCEPTED → PAYMENT_PENDING → PAID)
 → RevenuePostingService
 → financial_ledger
 → split 50/30/20
 → reconciliação
```

O domínio distingue a origem da confirmação desde já — `PaymentEvidence` tem um campo de proveniência (`SIMULATED`/`TEST` vs. `EXTERNAL_VERIFIED`), não uma função genérica `markPaid()`. No M5, o único provider é `SIMULATED`; no M8, troca-se o provider por evidência externa real sem redesenhar o domínio. **Pagamento simulado nunca conta como receita externa real nem marca a empresa como `SELF_SUSTAINING`** — essa marca fica reservada para quando `PaymentEvidence` for `EXTERNAL_VERIFIED` de verdade (M8).

### Reconciliação: detecta, não conserta sozinha

M5 é conservador de propósito: o reconciliador produz `RECONCILIATION_OK`/`RECONCILIATION_MISMATCH` com evidência, mas **não repara dinheiro automaticamente**. Auto-repair econômico fica para uma decisão posterior, fora do M5. Casos que precisa detectar:

- oportunidade `PAID` sem lançamento de receita correspondente;
- receita duplicada;
- split ausente, duplicado, ou cuja soma não bate com a receita;
- lançamento de ledger sem origem (órfão);
- confirmação de pagamento duplicada (posting não-idempotente).

## Fronteira com o Cost Accounting (critério 19)

Custo técnico e fato econômico são camadas diferentes e **nenhum código do M5 transforma um no outro**:

| Camada | Tabelas | O que representa |
|---|---|---|
| Telemetria técnica | `model_calls`, `tool_calls` | O que cada chamada custou e quanto demorou. Em `AI_MODE=mock` o custo é sempre R$0 (constraint no banco). |
| Autorização de gasto | `budget_reservations` | Quanto o Governor deixou gastar por finalidade. Não é gasto realizado. |
| Fato econômico | `financial_ledger` | Receita, subsídio e custo operacional **comprovados**, append-only, com `ledger_scope`. |

**Prova mecânica:** o teste do ciclo completo (`tests/integration/orchestrator.test.ts`) roda a esteira inteira, com chamadas de IA e de ferramenta registradas, e afirma que `financial_ledger` continua vazio. Se alguém ligar `model_calls` ao ledger sem passar por esta fronteira, esse teste falha.

**O que um Cost Accounting futuro (fora do M5, sem milestone atribuído) precisaria respeitar** para transformar custo real em lançamento:

- Só lê `model_calls`/`tool_calls` com `mode <> 'mock'` e `cost_brl > 0` — custo comprovado, nunca estimativa nem reserva.
- Lança `OPERATING_COST` (o tipo já existe no ledger, com `model_call_id` e `task_id` opcionais desde o M1), sempre em escopo explícito, com `idempotency_key` derivada da chamada de origem (por exemplo `cost:model_call:<id>`): reprocessar nunca duplica.
- É um serviço próprio e idempotente, como `confirmPayment`, e não um efeito colateral do AI Gateway ou do Tool Gateway.
- Erro contábil se corrige por lançamento de compensação, nunca reescrevendo histórico.

## Critérios de aceite do M5

| # | Critério |
|---|---|
| 1 | Existem `experiences`, `memories` e `agent_performance` com migrations reversíveis e sem regressão M1-M4. |
| 2 | Conclusão/falha de uma task produz `Experience` determinística a partir de evidência já persistida (task, attempts, review, events, model_calls, tool_calls) — nunca uma chamada de IA. |
| 3 | Reentrega/retry do BullMQ nunca cria `Experience` duplicada. |
| 4 | `Experience` e `Memory` são entidades distintas — uma é fato histórico, a outra é conhecimento selecionado. |
| 5 | Experiência só vira memória corporativa através de `MemoryProposal → MemoryValidator`; nunca automaticamente. |
| 6 | Memória mantém proveniência/evidência, confiança, origem, timestamps e status/expiração quando aplicável. |
| 7 | Conteúdo `UNTRUSTED_EXTERNAL` (M4) armazenado como evidência de experiência/memória nunca ganha autoridade por estar ali. |
| 8 | `pgvector` é usado de verdade: armazenamento, compatibilidade dimensional, filtragem por escopo, cálculo de distância e recuperação top-K funcionando. O `DeterministicEmbeddingProvider` existe só para provar essa infraestrutura — não constitui prova de qualidade semântica (ajuste 3 da revisão externa); o relatório de fechamento nunca descreve isso como "memória semântica funcionando". |
| 9 | Embeddings do M5 são determinísticos/locais de teste, nunca uma chamada paga; `embedding_provider`/`model`/`version`/`dimensions` ficam identificados por memória. |
| 10 | Recuperação é filtrável por escopo (empresa/agente/task/capability) sem vazar conhecimento entre escopos indevidos. |
| 11 | Performance de agente é calculada por janela temporal, a partir de fatos com proveniência — nunca um contador mutável sem rastro. |
| 12 | Retries/falhas/reviews/custo/duração entram corretamente na avaliação de performance, sem dupla contagem. |
| 13 | M5 calcula `AgentPerformanceAssessment` (com `recommended_action` opcional) mas **nunca** transiciona o lifecycle do agente automaticamente — isso é M6. |
| 14 | `financial_ledger` passa a receber fatos econômicos por um serviço único e idempotente, continua append-only. |
| 15 | Dinheiro usa representação exata (centavos inteiros, nunca float); o split 50/30/20 segue a política normativa de arredondamento (ajuste 1: `floor` por bucket, resíduo sempre para `RESERVE`) e conserva exatamente 100% do valor, sempre. |
| 16 | Pagamento simulado prova `SUBMITTED → ACCEPTED → PAYMENT_PENDING → PAID`, mas fica inequivocamente marcado como `SIMULATED`/`TEST`. Todo lançamento de `financial_ledger` carrega `ledger_scope` (`SIMULATION`/`REAL`) — `SIMULATION` nunca soma em `available_real_cash`, `external_revenue` nem em qualquer métrica de `SELF_SUSTAINING` (ajuste 2 da revisão externa). |
| 17 | Postar a mesma confirmação de pagamento é idempotente; concorrência nunca duplica receita. |
| 18 | Reconciliação detecta `PAID` sem ledger, ledger órfão/duplicado, split ausente/duplicado/incorreto, e produz evidência — sem apagar ou reescrever histórico. Nunca conserta dinheiro sozinha no M5. |
| 19 | Custos técnicos (`model_calls`/`tool_calls`/`budget_reservations`) permanecem separados do ledger econômico, com fronteira explícita documentada para um futuro Cost Accounting transformar custo real comprovado em lançamento. |
| 20 | **E2E determinístico** prova as duas trilhas, mantendo toda a regressão M1-M4 verde e custo externo R$0: (a) `task/result → Experience → MemoryProposal → Memory → pgvector retrieval → AgentPerformance`; (b) `simulated payment → PAID → revenue → split 50/30/20 → reconciliation`. |

## Prioridade de mutation testing (os pontos mais perigosos)

- **`LEDGER IDEMPOTENCY`** — postar a mesma confirmação duas vezes nunca duplica receita.
- **`SPLIT CONSERVATION`** — soma do split sempre bate com a receita, mesmo com resíduo de centavos.
- **`PAYMENT DOUBLE-POST`** — concorrência no posting de pagamento não duplica.
- **`RECONCILIATION MISMATCH`** — o reconciliador realmente detecta as inconsistências listadas, não só o caso feliz.
- **`EXPERIENCE DUPLICATION`** — reentrega do BullMQ não duplica `Experience`.
- **`MEMORY VALIDATION BYPASS`** — nenhum caminho cria memória corporativa sem passar pelo `MemoryValidator`.
- **`PERFORMANCE DOUBLE-COUNT`** — retry/reentrega não conta duas vezes na avaliação de performance.
- **`VECTOR SCOPE FILTER`** — busca por similaridade nunca vaza memória de um escopo para outro.
- **`SIMULATED ≠ EXTERNAL REVENUE`** — nenhum caminho de código consegue marcar um pagamento simulado como receita externa real.

## Fora do escopo do M5 (registrado, não esquecido)

- Lifecycle automático de agente (`PROBATION → ACTIVE` etc.), Scheduler, Circuit Breaker autônomo, Agent Factory autônoma — tudo M6.
- Pagamento externo real, primeiro R$1 externo de verdade, `SELF_SUSTAINING` real — M8.
- Embedding local ou pago — `EmbeddingProvider` fica pronto para receber isso depois, mas nenhum dos dois é ligado no M5.
- Auto-repair de inconsistência econômica encontrada pela reconciliação — decisão para depois do M5.
- `AlgoraEvidenceEnricher` e a fixture `CONFLICTING` multi-fonte do M4 — pendências registradas no fechamento do M4, sem decisão ainda se entram aqui ou num M4.x de hardening; não fazem parte deste plano a menos que decidido explicitamente antes de começar o código.

## Processo (mesmo que funcionou no M2, M3 e M4)

Plano (este documento) → revisão externa → ajustes se necessário → autorização do dono para começar o código → implementação por passos com prova reexecutável → mutação confirmada nos pontos da lista acima → relatório de fechamento → revisão externa → autorização do dono antes do merge.
