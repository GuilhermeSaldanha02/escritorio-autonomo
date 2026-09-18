# Relatório — Milestone 3: Inteligência Governada

- **Data:** 2026-09-17 · **Agente:** Claude (Sonnet 5) · **Branch:** `feat/m3-inteligencia` (saindo de `staging`)
- **Estado:** implementado, validado localmente e **aprovado pela revisão externa** ("M3 — APROVADO PARA MERGE ✅", ChatGPT, 2026-09-17). **Aguardando autorização do dono para o merge. Nada integrado em `staging`/`main`.**
- **Autorização de início:** dono, 2026-09-17, logo após o M2 ser aprovado pela revisão externa e integrado em `staging`/`main` (tag `m2-primeiro-ciclo`).
- **Consulta prévia (ChatGPT, 2026-09-17):** a especificação só tem uma linha de roadmap para o M3 ("AI Gateway, Model Router, Tool Gateway, custos, budgets, Governor completo"), sem critérios de aceite detalhados como o M1 teve. O escopo, a ordem de implementação e os 16 critérios abaixo vêm dessa consulta — registrada por completo em `docs/M3-PLANO.md`.
- **Repositório:** `GuilhermeSaldanha02/escritorio-autonomo` (privado, GitHub).

---

## 0. Como ler este relatório

Organizado pelos 16 critérios de aceite definidos com a revisão externa antes de começar (`docs/M3-PLANO.md`), na ordem de implementação real (7 passos). Uma limitação conhecida e não crítica foi encontrada e está registrada explicitamente na seção 5 — não escondida atrás de um ✅.

## 1. Objetivo do M3

> Provar que qualquer uso de IA ou ferramenta passa por gateways governados, observáveis e contabilizados, com roteamento determinístico, orçamento verificável e impossibilidade de um agente contornar essas regras pelo caminho oficial.

Decisão explícita, registrada desde o plano: **nenhum LLM local nem API paga real neste milestone** — por causa da RAM da máquina de desenvolvimento (8GB, já fragilizada no M2) e porque não era isso que precisava ser provado. `local`/`api` existem como adapters reais de contrato, testados contra servidor fake, mas ficam `NOT_CONFIGURED` em operação real.

## 2. O que foi construído (7 passos)

| Passo | Peça | Onde |
|---|---|---|
| 1 | Cost/Budget domain — reserva atômica de orçamento | `packages/budget`, migration `0005_budget` |
| 2-3 | AI Gateway + Model Router | `packages/ai`, migration `0006_model_calls_audit` |
| 4-5 | Tool Gateway + extensão do Governor (`TOOL_CALL`) | `packages/tool-gateway`, `packages/governor`, migration `0007_tool_calls` |
| 6 | Integração com o Orquestrador — Desenvolvedor/Revisor pelo Tool Gateway | `apps/worker/src/orchestrator/*`, `packages/agents` (só o tipo do parâmetro) |
| 7 | Diretor consulta o AI Gateway de verdade (E2E) | `apps/worker/src/orchestrator/opportunity-handler.ts` |

Fluxo alvo, como ficou implementado:

```
Agent
 → AI Gateway / Tool Gateway (agente nunca importa adapter/provider/SandboxManager direto)
 → Governor: capability? mode? orçamento (reserva atômica)? Constituição?
 → ALLOW / DENY
 → Model Router (AI_MODE) / GovernedSandbox → SandboxManager real
 → execução (mock sempre operacional; local/api contra servidor fake nos testes)
 → model_calls / tool_calls (auditoria técnica)
 → liquidação (SETTLED) ou devolução (RELEASED) da reserva
```

## 3. Commits (branch `feat/m3-inteligencia`, de `ca3872a` até `0fbee64`)

```
0fbee64 feat(worker): Diretor consulta o AI Gateway de verdade — passo 7 do M3 (E2E)
e87f67e feat(worker): Religa Desenvolvedor/Revisor pelo Tool Gateway — passo 6 do M3
27286e8 feat(tool-gateway): Adiciona Tool Gateway e extensao TOOL_CALL — passos 4-5 do M3
d230593 feat(ai): Adiciona AI Gateway e Model Router — passos 2-3 do M3
53c0c03 feat(budget): Adiciona reserva atomica de orcamento — passo 1 do M3
ca3872a docs: Registra inicio do M3 no ESTADO ATUAL
1e11a97 docs: Adiciona plano e criterios de aceite do Milestone 3
```

## 4. Critérios de aceite

| # | Critério | Prova |
|---|---|---|
| 1 | AI Gateway: toda chamada de IA do fluxo oficial passa por ele e gera registro em `model_calls` | ✅ `packages/ai` (`AiGateway.complete`); `tests/integration/ai-gateway.test.ts`; ciclo real em `orchestrator.test.ts` |
| 2 | Model Router: `AI_MODE` seleciona deterministicamente o adapter; `mock` operacional, `local`/`api` reais de contrato mas `NOT_CONFIGURED` | ✅ `packages/ai/test/model-router.test.ts`, `adapters.test.ts`, `adapters-fake-server.test.ts` (servidor fake real em localhost) |
| 3 | Zero gasto externo: suíte inteira roda sem chave real, sem API paga, sem LLM local | ✅ nenhuma chave real em nenhum arquivo; `AI_MODE=mock` é o único modo exercitado fora dos testes de contrato |
| 4 | Budget preflight: Governor verifica orçamento antes da execução | ✅ `tests/integration/ai-gateway.test.ts` ("BLOCKED... nunca chama o adapter"), mutação confirmada |
| 5 | Budget race safety: duas reservas concorrentes não estouram o orçamento juntas | ✅ `tests/integration/budget.test.ts` (8 reservas concorrentes, `pg_advisory_xact_lock`), mutação confirmada — 3/3 falhas sem o lock, 3/3 sucessos com o lock |
| 6 | Tool Gateway: toda ferramenta passa por ele; capacidade proibida recusada antes da execução | ✅ `tests/integration/tool-gateway.test.ts`, mutação confirmada |
| 7 | Sandbox preservation: execução continua no `SandboxManager` do M2, sem caminho alternativo | ✅ `GovernedSandbox` só envolve o `SandboxManager` real; suíte completa do M2 (`orchestrator.test.ts`) passou sem alteração de comportamento |
| 8 | Governor decide `TOOL_CALL`/orçamento; nenhum LLM participa da autorização | ✅ `packages/governor/test/governor.test.ts` (`GOVERNED_TOOLS`, `TOOL_CALL`); a chamada ao AI Gateway no passo 7 é só auditoria, não influencia `decide()`/`authorizeExecution()` |
| 9 | Auditabilidade: `model_calls`/`tool_calls` com agent_id, task_id/correlation_id, adapter/ferramenta, status, duração, custo, reserva ligada | ✅ migrations `0006`/`0007`; `budget_reservation_id` liga cada chamada à decisão do Governor que a autorizou |
| 10 | Falhas produzem estados conhecidos, nunca task/financeiro em estado desconhecido | ✅ `ai-gateway.test.ts` (`local` sem baseUrl → `ERROR`, reserva `RELEASED`); `tool-gateway.test.ts` (limites inválidos → `ERROR`, reserva `RELEASED`) |
| 11 | Nenhuma chave/segredo em frontend, prompt, evento ou log | ✅ nenhuma chave real existe no projeto; testes usam `'chave-de-teste-sem-valor-real'` explicitamente |
| 12 | Bypass: teste estrutural prova que agentes não acessam providers/ferramentas direto | ✅ `apps/worker/test/bypass.test.ts` — `development-handler.ts`/`review-handler.ts` não importam `@escritorio/tools` nem seguram `sandboxManager` |
| 13 | Mock E2E: ao menos um ciclo real do Orquestrador usa AI Gateway + Tool Gateway com `AI_MODE=mock` | ✅ `orchestrator.test.ts` — mesmo cenário feliz do M2, com `model_calls` real do Diretor (`mode=mock`, `status=SUCCESS`, custo R$0) e Desenvolvedor/Revisor via `GovernedSandbox`; mutação confirmada |
| 14 | Contabilidade: custo rastreável, sem virar receita nem alterar caixa indevidamente | ✅ `financial_ledger` inalterado (§8.8 do M1) — nenhum código do M3 escreve nele; custo fica em `model_calls`/`tool_calls`/`budget_reservations`, camada de Cost Accounting explícita fica para quando houver custo real a contabilizar |
| 15 | Compatibilidade com o M2: outbox, idempotência, retries, revisão independente, crash recovery, `TASK_WAITING_SLOT`, Governor continuam válidos | ✅ suíte de integração do M2 (`orchestrator.test.ts`, 7 testes) passou sem nenhuma mudança de asserção pré-existente |
| 16 | Qualidade: typecheck, lint, unit, integration, build limpos | ✅ typecheck, lint, 103 unitários, 69 integração, build limpo de `dist/` zerado em 11 pacotes |

## 5. Limitação conhecida, registrada (não é bug escondido)

**Auditoria do Diretor não é atômica com a transição de estado.** A chamada `aiGateway.complete()` no `opportunity-handler.ts` (passo 7) acontece numa transação própria, separada da transição `EVALUATING → APPROVED`. Numa reentrega tardia do BullMQ (job idempotente por leitura de estado, mas ainda não commitado quando a reentrega chega), a chamada ao AI Gateway pode se repetir antes da transição comitar, gerando mais de uma linha de auditoria em `model_calls` para a mesma oportunidade.

**Por que não é uma duplicação crítica:** o orçamento em si é protegido — `reserveBudget` usa uma `idempotencyKey` derivada do `correlationId`, então mesmo com duas chamadas ao AI Gateway, a segunda reserva vira `ALREADY_RESERVED` (não reserva duas vezes, não gasta duas vezes). O que duplicaria é só o registro de auditoria (`model_calls`), não um efeito financeiro ou de negócio.

**Por que não foi corrigido agora:** exigiria mover a chamada ao AI Gateway para dentro da mesma transação atômica da transição de estado (como o Orquestrador já faz para eventos), o que effectivamente significaria fazer uma chamada de rede (mesmo que mock, hoje) dentro de uma transação de banco aberta — um padrão que o próprio M2 evitou deliberadamente em outros pontos. Registrado como item para revisão futura, não escondido sob um ✅.

**Veredito da revisão externa sobre este ponto, com uma recomendação concreta para o futuro:** *"concordo que a solução não é colocar uma chamada futura de rede dentro da transação PostgreSQL apenas para obter atomicidade [...] Isso será ainda mais importante antes de ativarmos API paga real, porque hoje duplicar model_calls é basicamente ruído de auditoria; amanhã uma duplicação pode significar duas requisições externas faturáveis."* Recomendação registrada para antes de qualquer provider pago real: um `logical_ai_call_id` (ex.: `ai:DIRETOR-001:<correlationId>:approval-summary`) com `UNIQUE`, garantindo que duas entregas do mesmo job do BullMQ resolvam para a mesma operação lógica — idempotência da própria chamada/auditoria, não uma transação aberta durante I/O externo. Não bloqueia o M3.

## 6. Dependências adicionadas no M3 e por quê

Nenhuma dependência de terceiros nova — todos os 4 pacotes novos (`@escritorio/budget`, `@escritorio/ai`, `@escritorio/tool-gateway`) usam só `pg`/`bullmq`/`zod` já presentes no monorepo, e Node 22 `fetch` nativo para os adapters `local`/`api` (sem biblioteca de HTTP nova).

## 7. Comandos para rodar/validar

```bash
pnpm install
pnpm run typecheck && pnpm run lint
pnpm run test:unit
pnpm run test:integration   # requer Docker/Postgres/Redis de dev ligados (pnpm services:up)
pnpm run build
```

## 8. Confirmação — nenhum serviço pago foi necessário

Todo o M3 rodou com `AI_MODE=mock`. Os testes de `local`/`api` usam um servidor HTTP fake rodando no próprio processo do teste (localhost) — nunca uma chave real, nunca uma chamada de rede saindo da máquina. Custo externo total: R$0.

## 9. Situação e próximo passo

M3 implementado, validado localmente e **aprovado pela revisão externa**. Todos os 7 passos e os 16 critérios de aceite têm evidência reexecutável, incluindo mutação confirmada nas três propriedades mais delicadas (reserva de orçamento sob concorrência, bloqueio antes da execução no Tool Gateway, e o ciclo E2E real do critério 13). A limitação não crítica da seção 5 foi revisada e aceita como não-bloqueante, com uma recomendação registrada para antes de qualquer provider pago real (idempotência via `logical_ai_call_id`).

**Veredito completo da revisão externa (ChatGPT, 2026-09-17):** *"M3 — APROVADO PARA MERGE ✅. Considero o M3 — Inteligência Governada tecnicamente concluído e pronto para ser levado ao dono para autorização de merge em staging e depois main."*

A mesma revisão recomendou, para o M4 (Caçador Real, próximo da especificação): não começar a implementação diretamente — M4 traz fontes públicas reais, termos de plataforma, deduplicação, verificação de recompensa, prazos, confiança e potencial conteúdo externo malicioso, "uma fronteira de segurança bem diferente de M1–M3". Recomendação: desenhar os critérios de aceite do M4 com a revisão externa antes de qualquer código, mesmo padrão já seguido antes do M2 e do M3.

**Nada foi integrado em `staging`/`main` ainda — falta a autorização explícita do dono para o merge.** M4 não iniciado, e só deve começar com nova autorização e um desenho de critérios de aceite próprio, dada a mudança de risco que a revisão externa apontou.
