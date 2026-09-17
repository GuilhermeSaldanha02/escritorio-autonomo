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

1. **Transactional Outbox** — evento e pedido de job na mesma transação; dispatcher no Worker publica no BullMQ. Elimina o evento sem job (pendência 1 do M1).
2. **Máquinas de estado** de oportunidade (§11) e tarefa, com transição condicional no banco + evento na mesma transação.
3. **Contratos §13** validados (zod) e agentes determinísticos em `packages/agents`.
4. **Sandbox Manager** em `packages/tools`: container descartável sem rede, com teto de CPU/RAM/disco/pids/tempo.
5. **Orquestrador** no Worker: cada passo grava transição + evento + próximo job atomicamente.
6. **API de simulação** e consulta da linha do tempo.

## Critérios de aceite do M2

| # | Critério | Prova esperada |
|---|---|---|
| 1 | Evento e job são atômicos: com Redis fora, o evento fica pendente no outbox e é publicado quando o Redis volta | teste de integração |
| 2 | Reentrega do outbox não duplica job nem evento | teste de integração |
| 3 | Transições inválidas de oportunidade e tarefa são recusadas por código; nenhum agente declara `PAID` | testes unitários |
| 4 | Cenário feliz percorre o fluxo alvo completo até `COMPLETED`, com todos os eventos persistidos em ordem | teste de integração com sandbox real |
| 5 | Revisor valida em sandbox **independente** da do Desenvolvedor (container novo, código reconstruído do diff) | teste + evento com ids de sandbox distintos |
| 6 | Revisão reprovada volta ao Desenvolvedor; após `MAX_TASK_RETRIES` a tarefa vira `BLOCKED` com `TASK_BLOCKED` | teste de integração |
| 7 | Oportunidade que exige capacidade proibida gera `ACTION_BLOCKED` e é rejeitada, sem criar tarefa | teste de integração |
| 8 | Sandbox sem rede, sem capabilities, não-root, com teto de memória/CPU/pids/disco e tempo máximo | teste que tenta rede e estouro de tempo |
| 9 | Paralelismo respeita `MAX_PARALLEL_TASKS` | configuração do Worker + teste |
| 10 | Estado dos agentes muda durante o ciclo (`AGENT_STATE_CHANGED`) — base para o Office | teste |
| 11 | typecheck, lint, test e build passam de estado limpo; R$0 | validação final |

## Fora do escopo do M2

IA real (M3), Tool Gateway completo (M3), conector real do Caçador (M4), memória vetorial e ledger de custos (M5), scheduler/circuit breaker/Emergency Stop (M6), Office 2D (M7), submissão real e pagamento.
