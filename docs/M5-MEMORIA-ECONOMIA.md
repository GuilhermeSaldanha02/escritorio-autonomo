# Milestone 5 — Memória + Economia · relatório de fechamento

- **Status:** implementação concluída **exceto o critério 20** (E2E determinístico das duas trilhas). O M5 **não deve ser mergeado** enquanto esse critério não for atendido ou a lacuna não for aceita explicitamente pelo dono, com revisão externa.
- **Por que o critério 20 ficou de fora:** decisão do dono em 2026-09-18, para poupar custo de execução (tokens e tempo) numa sessão já longa. Não é uma limitação técnica: ver "Caminho barato para fechar o critério 20" abaixo.
- **Base:** `docs/M5-PLANO.md` (aprovado em duas rodadas pela revisão externa, com 3 ajustes já incorporados). Branch `feat/m5-memoria-economia`. Para o commit exato: `git log --oneline -1` na branch.
- **Regressão:** unitária 277/277, integração 112/112, typecheck e lint limpos. Custo externo R$0 (`AI_MODE=mock`).

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
| 6 | Proveniência, confiança, origem, timestamps, status/expiração "quando aplicável" | Parcial | Proveniência (`experience_id`), confiança, origem e timestamps existem. **Status e expiração não foram implementados** |
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
| 20 | E2E determinístico das duas trilhas | **NÃO ATENDIDO** | Adiado por decisão do dono |

## Decisões tomadas na implementação (para a revisão conferir)

1. **`capability` da `Experience` é o `role` do agente atribuído.** `tasks` não tem coluna de capability; o papel é o fato persistido.
2. **`BLOCKED` conta como falha.** Não tem transição de saída, então é terminal. `CANCELLED` não gera `Experience`.
3. **Sem índice ivfflat.** A 0011 criou um; medi no Postgres que a consulta real nunca o usa (o planner escolhe o índice de escopo e ordena, resultado exato) e que um ivfflat criado sobre tabela vazia devolveu 53 de 300 linhas com o `probes` padrão. A 0012 remove o índice. Busca aproximada fica para quando houver volume e embedding real. Um teste cobre K maior que o total, contra a reintrodução de um índice aproximado.
4. **Pagamento mínimo de 5 centavos.** Com 4, o bucket `EXPANSION` vira 0 e o ledger recusa lançamento de valor zero.
5. **`down` da 0010 descarta os lançamentos `*_ALLOCATION`.** O schema antigo não os representa; são derivados de uma `REVENUE` que permanece.
6. **Checksum de migration ignora fim de linha.** O mesmo arquivo com CRLF era recusado como "editado depois de aplicado". Achado quando dois agentes passaram a usar o mesmo repositório.

## Provas por mutação

Cada garantia foi quebrada de propósito e o teste específico falhou (com controle sem mutação passando antes):

- **Domínio puro:** resíduo do split descartado; pular etapa na state machine; escopo sempre `REAL`; quatro checks da reconciliação; guarda de agente misturado; amostra mínima; consistência `SUCCESS` x review `FAILED`; validador de memória.
- **Pagamento (Postgres real):** sem checagem de idempotência; sem advisory lock (o teste pega pelo desfecho, pois linha bloqueada e `UNIQUE` já impedem duplicar: defesa em profundidade); sem guarda `EXTERNAL_VERIFIED`; saldo sem filtro de escopo; saldo somando os buckets; guarda de valor mínimo.
- **Memória (Postgres real):** sem `ON CONFLICT` (Experience e performance); `BLOCKED` fora; validador ignorado; busca sem filtro de confiança, de agente, de capability, de task e de proveniência do embedding; ordem invertida; janela fechada nos dois lados.
- **Orquestrador:** tirar cada um dos dois disparos de `record-experience`; injetar um lançamento indevido no ledger (a fronteira do critério 19 pega).
- **Migrator:** voltar ao hash bruto faz o teste de CRLF falhar.

## Lacunas e riscos declarados

- **Critério 20 não atendido.** Ver abaixo.
- **Nenhum componente propõe memórias.** O gate existe e funciona, mas `MemoryProposal` só é criado por quem chama `storeMemory`. O E2E (trilha a) teria de fabricar a proposta.
- **Reconciliação e avanço de pagamento sem chamador real.** `reconcileFromDatabase` e `advancePaymentStatus` só rodam em testes. Quem os dispara é decisão do M6 (agendamento) e do M8 (aceite externo).
- **Status/expiração de memória não implementados** (critério 6, "quando aplicável").
- **Busca exata, sem índice aproximado.** Correta hoje; não escala para muitas memórias.
- **`FAILED` inalcançável** pelo orquestrador atual: só `COMPLETED` e `BLOCKED` produzem `Experience`.
- **Migrations editadas antes de mergear.** A 0012 foi reescrita duas vezes na branch antes do primeiro commit, e o banco local foi alinhado à mão. Nada disso saiu da branch.

## Caminho barato para fechar o critério 20

Os dois lados do E2E já estão provados separadamente contra Postgres real: `memory-service.test.ts` cobre `Experience → Memory → busca → performance` e `payment-service.test.ts` cobre `pagamento simulado → PAID → receita → split → reconciliação`. O que falta é **um único teste que compõe as duas trilhas** sobre o ciclo do orquestrador, com o mesmo estado de banco e afirmando o total. É um teste de composição, sem código novo de produção, bem menor do que um E2E novo do zero. Fica a decisão do dono e da revisão externa se isso basta.

## Situação e próximo passo

Aguardando o veredito da revisão externa sobre a lacuna do critério 20 e a decisão do dono. Nada de M6 começa automaticamente: antes, reabrir a seção do M6 da especificação e definir critérios de aceite com o revisor.
