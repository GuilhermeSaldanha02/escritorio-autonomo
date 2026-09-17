# Milestone 2 — Primeiro ciclo · plano

- **Autorizado pelo dono:** 2026-09-17, após aprovação do M1 na revisão externa. Branch `feat/m2-primeiro-ciclo` (de `staging`).
- **Fonte:** especificação §8.1 (Orquestrador), §8.6 (Sandbox), §11 (estados), §13 (contratos), §17 (roadmap), §19 (primeiro ciclo); revisão externa do M1 (outbox como primeira tarefa).
- **Objetivo (§19):** provar o fluxo, não a inteligência. Agentes determinísticos; nenhuma IA; R$0.

## Fluxo alvo

```
OPORTUNIDADE FALSA (Caçador simulado → OPPORTUNITY_FOUND)
 → verificação determinística → OPPORTUNITY_VERIFIED
 → DIRETOR MOCK → DIRECTOR_DECISION(EXECUTE) → Governor autoriza → APPROVED
 → TASK_CREATED → TASK_ASSIGNED (DESENVOLVEDOR-001)
 → DESENVOLVEDOR MOCK aplica mudança e roda testes em SANDBOX → IMPLEMENTATION_READY
 → REVISOR roda testes reais em sandbox limpa e independente → REVIEW_PASSED
 → TASK COMPLETED → todos os eventos persistidos
```

Agentes nunca se chamam: `AGENTE → EVENTO → ORQUESTRADOR → FILA → OUTRO AGENTE` (§8.1).

## Ordem de implementação

1. ✅ **Transactional Outbox** — evento e pedido de job na mesma transação; dispatcher no Worker publica no BullMQ. Elimina o evento sem job (pendência 1 do M1).
2. ✅ **Máquinas de estado** de oportunidade (§11) e tarefa — validação pura em código (`packages/shared/src/lifecycle.ts`). **Falta:** transição condicional atômica no banco (`UPDATE ... WHERE status = $from`) na mesma transação do evento — isso é trabalho do passo 5 (Orquestrador), não deste passo.
3. **Contratos §13** validados (zod) e agentes determinísticos em `packages/agents`.
4. **Sandbox Manager** em `packages/tools`: container descartável sem rede, com teto de CPU/RAM/disco/pids/tempo.
5. **Orquestrador** no Worker: cada passo grava transição + evento + próximo job atomicamente.
6. **API de simulação** e consulta da linha do tempo.

## Critérios de aceite do M2

| # | Critério | Prova esperada |
|---|---|---|
| 1 | Evento e job são atômicos: com Redis fora, o evento fica pendente no outbox e é publicado quando o Redis volta | ✅ `tests/integration/outbox.test.ts` (Redis inalcançável real) |
| 2 | Reentrega do outbox não duplica job nem evento | ✅ `outbox.test.ts`: reentrega e 3 dispatchers concorrentes |
| 3 | Transições inválidas de oportunidade e tarefa são recusadas por código; nenhum agente declara `PAID` | ✅ `packages/shared/test/lifecycle.test.ts` (18 casos: caminho feliz, pulos de etapa, ator errado, estados finais) |
| 4 | Cenário feliz percorre o fluxo alvo completo até `COMPLETED`, com todos os eventos persistidos em ordem | teste de integração com sandbox real |
| 5 | Revisor valida em sandbox **independente** da do Desenvolvedor (container novo, código reconstruído do diff) | teste + evento com ids de sandbox distintos |
| 6 | Revisão reprovada volta ao Desenvolvedor; após `MAX_TASK_RETRIES` a tarefa vira `BLOCKED` com `TASK_BLOCKED` | teste de integração |
| 7 | Oportunidade que exige capacidade proibida gera `ACTION_BLOCKED` e é rejeitada, sem criar tarefa | teste de integração |
| 8 | Sandbox sem rede, sem capabilities, não-root, com teto de memória/CPU/pids/disco e tempo máximo | teste que tenta rede e estouro de tempo |
| 9 | Paralelismo respeita `MAX_PARALLEL_TASKS` | configuração do Worker + teste |
| 10 | Estado dos agentes muda durante o ciclo (`AGENT_STATE_CHANGED`) — base para o Office | teste |
| 11 | typecheck, lint, test e build passam de estado limpo; R$0 | validação final |

## Progresso

### 1. Transactional Outbox — concluído (`e2a8dc5` + ajuste de padrões)

- Migration `0002_outbox`; `EventBus.publish` grava evento + pedido de job numa transação; `EventBus.publishIn` compõe com outras escritas (base do Orquestrador).
- `OutboxDispatcher` no Worker: `FOR UPDATE SKIP LOCKED`, backoff exponencial, prazo por publicação, lote de 10 e prazo de 1,5 s em produção (uma queda do Redis segura uma conexão do pool por no máximo ~15 s por ciclo).
- A API não fala mais com o BullMQ: aceita pedidos (202) mesmo com o Redis fora.
- **Bugs encontrados pelos testes e corrigidos:** (a) com o Redis fora, `queue.add` do BullMQ espera a conexão para sempre em vez de falhar — sem prazo, o dispatcher travaria com a transação e os locks abertos; (b) `now()` no PostgreSQL é o início da transação, então o backoff nascia vencido — trocado por `clock_timestamp()`.
- **Prova:** 7 testes de integração do outbox (atomicidade, rollback conjunto, Redis inalcançável real + recuperação, reentrega, 3 dispatchers concorrentes com 20 jobs, fila desconhecida, API com Redis fora) + processos compilados reais: `TEST_JOB_REQUESTED` com linha no outbox publicada em 1 tentativa → `TEST_JOB_COMPLETED`.
- **Limitação conhecida:** a reentrega deduplica pelo `jobId` enquanto o BullMQ retém o job (`removeOnComplete: 1000`, `removeOnFail: 5000`). Depois disso, uma queda exatamente entre publicar e marcar criaria um job novo; a chave de idempotência dos eventos gravados pelo job impede duplicar o efeito.

### 2. Máquinas de estado — parcialmente concluído (`e61a909`)

- `packages/shared/src/lifecycle.ts`: `OPPORTUNITY_STATUSES`/`TASK_STATUSES` (§11), grafo de transições válidas, `Actor` explícito (`agent` vs `system`). `assertOpportunityTransition`/`assertTaskTransition` lançam `InvalidTransitionError`.
- Fatos externos (`ACCEPTED`, `PAYMENT_PENDING`, `PAID`) só por `system`; `PAID` exige especificamente `PAYMENT_CONFIRMATION` — nem o Orquestrador, nem o fundador bastam. Nenhum agente pode declarar nenhum dos três.
- **Gap conhecido, deixado para o passo 5:** isto é validação pura em memória. As tabelas `opportunities`/`tasks` (migration `0001`) só têm `CHECK` de valor válido, não de transição válida — um `UPDATE` direto ainda pode pular etapa. A garantia real vem quando o Orquestrador fizer `UPDATE ... WHERE status = $from` condicional, na mesma transação do evento (mesmo padrão do outbox). Até lá, `assertOpportunityTransition`/`assertTaskTransition` protegem quem passa por elas, não o banco.
- **Prova:** 8 testes unitários (typecheck/lint limpos, build de todos os pacotes limpo a partir de estado zerado).

## Fora do escopo do M2

IA real (M3), Tool Gateway completo (M3), conector real do Caçador (M4), memória vetorial e ledger de custos (M5), scheduler/circuit breaker/Emergency Stop (M6), Office 2D (M7), submissão real e pagamento.
