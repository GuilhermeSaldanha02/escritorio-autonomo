# Milestone 5 — Memória + Economia · relatório de fechamento

- **Status:** implementação concluída, com os 20 critérios atendidos no escopo aplicável. **Aguardando a revisão final e a autorização do dono para o merge.**
- **Histórico do critério 20:** o dono chegou a adiar o E2E (2026-09-18) para poupar custo de execução. A revisão externa recusou a exceção: o critério existe para provar composição, e o caminho de fechamento era barato. Foi fechado com um único teste de composição, sem código novo de produção (ver a linha 20).
- **Base:** `docs/M5-PLANO.md` (aprovado em duas rodadas pela revisão externa, com 3 ajustes já incorporados). Branch `feat/m5-memoria-economia`. Para o commit exato: `git log --oneline -1` na branch.
- **Regressão:** unitária 277/277, integração 113/113, typecheck e lint limpos. Custo externo R$0 (`AI_MODE=mock`).

## O que o M5 prova, e o que não prova

O M5 prova **infraestrutura de memória vetorial** (armazenar, filtrar por escopo, calcular distância, recuperar top-K no pgvector) e o **mecanismo econômico** (ledger idempotente, split conservativo, isolamento SIMULATION/REAL, reconciliação). **Não prova memória semântica**: o `DeterministicEmbeddingProvider` gera vetores por hash, sem qualidade de recuperação semântica (ajuste 3 da revisão). **Não prova receita real**: todo pagamento é `SIMULATED`, e nenhum lançamento `REAL` pode nascer (o serviço recusa `EXTERNAL_VERIFIED` até o M8).

## Critérios de aceite

| # | Critério | Estado | Onde está a prova |
|---|---|---|---|
| 1 | Tabelas e migrations reversíveis, sem regressão | Atendido | Migrations 0010, 0011, 0012; `database.test.ts` (reversibilidade); suíte M1-M4 verde |
| 2 | Task terminal produz `Experience` de evidência persistida, sem IA | Atendido para `COMPLETED` e `BLOCKED` | `experience-repository.ts`, `experience-handler.ts`; `orchestrator.test.ts`. Nenhum caminho do código leva uma task a `FAILED` hoje |
| 3 | Reentrega nunca duplica `Experience` | Atendido | `memory-service.test.ts` (duas chamadas e cinco em paralelo); mutação sem `ON CONFLICT` |
| 4 | `Experience` e `Memory` distintas | Atendido | Tabelas e tipos separados |
| 5 | Só vira memória via `MemoryProposal` → `MemoryValidator` | Atendido, com ressalva | `storeMemory` valida antes de gravar; mutação do validador. **Nenhum componente propõe memórias automaticamente ainda** |
| 6 | Proveniência, confiança, origem, timestamps, status/expiração "quando aplicável" | Atendido no escopo aplicável | Proveniência (`experience_id`), confiança, origem e timestamps existem. Status/lifecycle, `expires_at` e revalidação temporal **não existem** e ficam registrados como capacidade futura: neste M5 as memórias são conhecimento derivado de experiências, sem regra temporal |
| 7 | `UNTRUSTED_EXTERNAL` nunca ganha autoridade | Atendido (interpretação nossa) | `trust_level` sem default; busca não devolve conteúdo não confiável por padrão. Códigos de falha vêm só de status, nunca de texto livre |
| 8 | pgvector usado de verdade | Atendido, sem índice aproximado | Armazenamento, distância `<=>`, top-K, escopo. Ver decisão do ivfflat abaixo. Frase correta: "infraestrutura de memória vetorial funcionando" |
| 9 | Embeddings determinísticos, sem custo, com identidade | Atendido | `provider/model/version/dimensions` por memória; busca só no mesmo espaço vetorial |
| 10 | Recuperação filtrável por escopo sem vazar | Atendido | Escopos de agente, task e capability; mutações em cada filtro |
| 11 | Performance por janela, de fatos com proveniência | Atendido | `recordAgentPerformance` lê só de `experiences` |
| 12 | Retries/falhas/reviews/custo/duração sem dupla contagem | Atendido | Janela semiaberta `[from, to)`; mutação da janela fechada |
| 13 | M5 calcula, nunca altera lifecycle | Atendido | Teste confere `lifecycle_status` inalterado após `PROMOTE` |
| 14 | Ledger por serviço único, idempotente, append-only | Atendido | `confirmPayment`; `payment-service.test.ts` |
| 15 | Dinheiro exato, split conserva 100% | Atendido | `computeSplit` (centavos inteiros, resíduo para `RESERVE`); testes exaustivos |
| 16 | Trilha `SUBMITTED→PAID` simulada, `SIMULATION` nunca soma em caixa real | Atendido | `ledgerBalanceCents` por escopo; recusa de `EXTERNAL_VERIFIED` |
| 17 | Posting idempotente, concorrência não duplica | Atendido | Cinco confirmações simultâneas resultam em uma receita |
| 18 | Reconciliação detecta, não conserta | Atendido | `reconcile` e `reconcileFromDatabase`. **Nada a executa automaticamente** (agendamento é do M6) |
| 19 | Custo técnico separado do ledger, fronteira documentada | Atendido | Seção em `M5-PLANO.md`; teste do ciclo completo afirma ledger vazio |
| 20 | E2E determinístico das duas trilhas | Atendido | `tests/integration/m5-composition.test.ts`: uma execução sobre o ciclo real (Postgres, Redis, BullMQ e Docker). Trilha (a): task real → Experience (pelo orquestrador) → MemoryProposal → Memory → busca pgvector → AgentPerformance. Trilha (b): a mesma oportunidade, deixada em `SUBMITTED` pelo ciclo real → ACCEPTED → PAYMENT_PENDING → PAID → receita → split → reconciliação OK. Reprocessar as duas trilhas não muda nada. Asserts transversais: saldo `REAL` = 0, nenhum lançamento `REAL`, nenhuma evidência `EXTERNAL_VERIFIED`, `lifecycle_status` de todos os agentes inalterado, custo técnico fora do ledger |

## Decisões tomadas na implementação (para a revisão conferir)

1. **`capability` da `Experience` é o `role` do agente atribuído.** `tasks` não tem coluna de capability; o papel é o fato persistido. É uma **aproximação da V1**, não a identidade conceitual definitiva: `role` diz quem é o agente, e a capability ideal diria qual capacidade foi usada (por exemplo, um mesmo DESENVOLVEDOR executando backend, migration ou teste). Quando a task persistir uma capability, a coluna passa a vir dela.
2. **`BLOCKED` conta como falha.** Não tem transição de saída, então é terminal. `CANCELLED` não gera `Experience`. A diferença entre "tentou e falhou" e "foi bloqueado" não se perde: fica em `failure_codes` (`TASK_FAILED` x `TASK_BLOCKED`).
3. **Sem índice ivfflat.** A 0011 criou um; medi no Postgres que a consulta real nunca o usa (o planner escolhe o índice de escopo e ordena, resultado exato) e que um ivfflat criado sobre tabela vazia devolveu 53 de 300 linhas com o `probes` padrão. A 0012 remove o índice. Busca aproximada fica para quando houver volume e embedding real. Um teste cobre K maior que o total, contra a reintrodução de um índice aproximado.
4. **Pagamento mínimo de 5 centavos.** Com 4, o bucket `EXPANSION` vira 0 e o ledger recusa lançamento de valor zero. É uma restrição do esquema (lançamentos não-zero mais o split), **não uma regra econômica constitucional**.
5. **`down` da 0010 descarta os lançamentos `*_ALLOCATION`.** O schema antigo não os representa; são derivados de uma `REVENUE` que permanece. Reverter o schema **não preserva** essas projeções derivadas.
6. **Checksum de migration ignora só o fim de linha (CRLF para LF).** O mesmo arquivo com CRLF era recusado como "editado depois de aplicado". Achado quando dois agentes passaram a usar o mesmo repositório. Espaços, comentários e qualquer outro conteúdo continuam contando: uma migration realmente alterada ainda é detectada.

Sobre o conteúdo `UNTRUSTED_EXTERNAL`: fica **fora da busca padrão**, mas não apagado da memória recuperável. `searchMemories` aceita `includeUntrusted` para uma recuperação explícita (forense ou de evidência), e o resultado continua marcado como não confiável.

## Provas por mutação

Cada garantia foi quebrada de propósito e o teste específico falhou (com controle sem mutação passando antes):

- **Domínio puro:** resíduo do split descartado; pular etapa na state machine; escopo sempre `REAL`; quatro checks da reconciliação; guarda de agente misturado; amostra mínima; consistência `SUCCESS` x review `FAILED`; validador de memória.
- **Pagamento (Postgres real):** sem checagem de idempotência; sem advisory lock (o teste pega pelo desfecho, pois linha bloqueada e `UNIQUE` já impedem duplicar: defesa em profundidade); sem guarda `EXTERNAL_VERIFIED`; saldo sem filtro de escopo; saldo somando os buckets; guarda de valor mínimo.
- **Memória (Postgres real):** sem `ON CONFLICT` (Experience e performance); `BLOCKED` fora; validador ignorado; busca sem filtro de confiança, de agente, de capability, de task e de proveniência do embedding; ordem invertida; janela fechada nos dois lados.
- **Orquestrador:** tirar cada um dos dois disparos de `record-experience`; injetar um lançamento indevido no ledger (a fronteira do critério 19 pega).
- **Migrator:** voltar ao hash bruto faz o teste de CRLF falhar.

## Lacunas e riscos declarados

- **Nenhum componente propõe memórias.** O gate existe e funciona, mas `MemoryProposal` só é criado por quem chama `storeMemory`. No teste de composição, o próprio teste faz o papel do proponente, montando a proposta a partir dos fatos da Experience.
- **Reconciliação e avanço de pagamento sem chamador real.** `reconcileFromDatabase` e `advancePaymentStatus` só rodam em testes. Quem os dispara é decisão do M6 (agendamento) e do M8 (aceite externo).
- **Status/expiração de memória não implementados** (critério 6, "quando aplicável"): registrados como capacidade futura.
- **Busca exata, sem índice aproximado.** Correta hoje; não escala para muitas memórias.
- **`FAILED` inalcançável** pelo orquestrador atual: só `COMPLETED` e `BLOCKED` produzem `Experience`.
- **Migrations editadas antes de mergear.** A 0012 foi reescrita duas vezes na branch antes do primeiro commit, e o banco local foi alinhado à mão. Nada disso saiu da branch.

## Como o critério 20 foi fechado

Os dois lados já estavam provados separadamente (`memory-service.test.ts` e `payment-service.test.ts`). O que faltava era a composição, a categoria de erro que testes isolados não pegam. `m5-composition.test.ts` roda as duas trilhas na mesma execução sobre o ciclo real do orquestrador, sem código novo de produção. Ele passa em cerca de 6 segundos.

Prova por mutação, com o teste falhando pela razão esperada em cada uma: tirar o disparo de `record-experience` do `COMPLETED` (o teste espera a Experience e estoura o tempo); lançamento simulado virando `REAL` (o split deixa de bater e o saldo `REAL` deixa de ser zero); busca ignorando o escopo de agente (a memória vaza para o Revisor).

## Situação e próximo passo

Implementação concluída. Falta a revisão final da revisão externa e a autorização explícita do dono para o merge (`staging`, depois `main`). Nada de M6 começa automaticamente: antes, reabrir a seção do M6 da especificação e definir critérios de aceite com o revisor. Trabalho paralelo do Office (M7-PREP) é independente e segue em outra branch, sem bloquear este merge.
