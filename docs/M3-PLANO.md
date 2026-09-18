# Milestone 3 — Inteligência Governada · plano

- **Autorizado pelo dono:** 2026-09-17, após M2 aprovado pela revisão externa e integrado em `staging`/`main` (tag `m2-primeiro-ciclo`).
- **Fonte:** especificação §17 (roadmap — linha única: "AI Gateway, Model Router, Tool Gateway, custos, budgets, Governor completo"; sem critérios de aceite detalhados como o M1 teve em §18). `.env.example` já antecipava: "local/api chegam com o AI Gateway (M3)".
- **Consulta externa antes de montar este plano (ChatGPT, 2026-09-17):** a especificação não detalha o M3 como detalhou o M1 — o escopo abaixo, a ordem de implementação e os 16 critérios de aceite vêm dessa consulta, não só de interpretação própria. Decisões centrais: (1) `local`/`api` nascem arquiteturalmente reais e testados contra servidor fake, mas **não são declarados operacionais** — ficam `UNAVAILABLE`/`NOT_CONFIGURED` até haver integração real; (2) `model_calls`/`tool_calls` são auditoria técnica, **não** viram automaticamente linha do `financial_ledger` (evita contaminar o livro financeiro com telemetria de custo zero); (3) orçamento precisa de reserva atômica (`AVAILABLE → RESERVED → SETTLED/RELEASED`), não um simples `if (saldo >= custo)` — duas operações concorrentes não podem juntas estourar o limite; (4) agentes nunca importam adapters/providers diretamente, só falam com os Gateways.
- **Restrição de máquina, decidida explicitamente:** 8GB de RAM, já fragilizada no M2 (chegou a ~245MB livres). Rodar um LLM local de verdade (Ollama/3B-7B) ou uma API paga real **não é objetivo de fechamento do M3** — não prova nada que a arquitetura de gateways+Governor já não precise provar sozinha, e arrisca a máquina desnecessariamente. Registrado como capability futura, não como um "M3b" formal.

## Objetivo (definido com a revisão externa, não está na especificação original)

> Provar que qualquer uso de IA ou ferramenta passa por gateways governados, observáveis e contabilizados, com roteamento determinístico, orçamento verificável e impossibilidade de um agente contornar essas regras pelo caminho oficial.

O M3 não precisa provar que um LLM real é inteligente — precisa provar que a empresa consegue controlar inteligência e ferramentas como recursos econômicos governados. Trocar `FakeAdapter` por `Ollama`/`OpenAI`/outro provider deve ser uma mudança de infraestrutura/configuração no futuro, não uma reescrita dos agentes.

## Fluxo alvo

```
Agent
 → AI Gateway / Tool Gateway (agente nunca importa adapter/provider direto)
 → Governor: capability? mode allowed? budget (reserva atômica)? Constituição? Emergency Stop?
 → ALLOW / DENY
 → Model Router (AI_MODE) / Tool Adapter
 → execução (mock sempre; local/api contra servidor fake nos testes)
 → model_calls / tool_calls (auditoria técnica)
 → Cost Accounting (decide o que vira fato econômico)
 → financial_ledger (só quando há fato econômico real — nunca para custo R$0)
 → Events (auditoria/timeline)
```

## Modos do AI_MODE — o que "suportado" significa no M3

| Modo | Status no M3 |
|---|---|
| `mock` | **Operacional.** Usado pelos testes E2E do M3. Custo real R$0 (já garantido pelo `CHECK (mode <> 'mock' OR cost_brl = 0)` da migration 0001). |
| `local` | Adapter real, testado contra um servidor fake compatível (contrato exercitado de verdade). **Sem LLM local rodando.** Estado declarado: `NOT_CONFIGURED`. Não é objetivo do M3 ligar um modelo real — decisão explícita por causa da RAM da máquina. |
| `api` | Adapter real, testado contra servidor fake. **Sem chave real, sem chamada paga.** Estado declarado: `NOT_CONFIGURED`. Ativar isso exige autorização explícita de gasto do dono (`AUTO_SPEND`/`approvedByFounder`, já existente no Governor) — não é decisão deste milestone.

Não confundir "arquiteturalmente implementado e testado" com "operacionalmente comprovado" — mesma disciplina do M1/M2 (provar o fluxo antes da inteligência real).

## Ordem de implementação

1. **Cost/Budget domain** — primeiro, não por último: quando o AI Gateway e o Tool Gateway nascerem, já nascem governados. Núcleo: reserva atômica de orçamento (`AVAILABLE → RESERVED → SETTLED` ou `RELEASED`), no mesmo espírito de atomicidade do `TransitionService` do M2 (`UPDATE ... WHERE` condicional numa transação, não um `if` em memória).
2. **AI Gateway** — ponto único de entrada para qualquer chamada de IA; agentes só falam com ele.
3. **Model Router** — escolhe o adapter (`mock`/`local`/`api`) por `AI_MODE`, determinístico.
4. **Tool Gateway** — ponto único de entrada para execução de ferramentas; reaproveita o `SandboxManager` do M2 para tudo que executa código — não cria um segundo caminho de execução no host.
5. **Extensão do Governor** — novos tipos de `GovernedAction`: `TOOL_CALL` (capacidade) e `BUDGET_CHECK` (reserva), compondo com o que já existe (`SPEND` já tem `approvedByFounder`/`AUTO_SPEND` — a extensão é sobre *quando* checar orçamento antes de uma operação, não reinventar a política).
6. **Integração com o Orquestrador** — pelo menos um ciclo real usando AI Gateway + Tool Gateway de verdade, com `AI_MODE=mock`, chegando ao resultado esperado (critério 13 abaixo).
7. **Auditoria + E2E** — `model_calls`/`tool_calls` completos, testes de ponta a ponta.

## Regra arquitetural (vale para todo o M3, não só um passo)

**Agentes não importam adapters/providers diretamente.** Nenhum agente (`Diretor`/`Desenvolvedor`/`Revisor`/futuros) pode importar `OpenAIAdapter`, `OllamaAdapter` ou `SandboxManager` — só falam com `aiGateway.complete(...)` / `toolGateway.execute(...)`. Um teste estrutural/arquitetural (critério 12) prova isso, não só a convenção.

## Critérios de aceite do M3

| # | Critério |
|---|---|
| 1 | **AI Gateway:** toda chamada de IA do fluxo oficial passa obrigatoriamente por ele e gera registro auditável em `model_calls`. |
| 2 | **Model Router:** `AI_MODE` seleciona deterministicamente o adapter correto. `mock` funciona operacionalmente; `local`/`api` têm adapters reais de contrato, testados contra servidor fake, mas permanecem explicitamente não comprovados contra provedores reais (`NOT_CONFIGURED`). |
| 3 | **Zero gasto externo:** a suíte completa do M3 roda sem chave real, sem API paga e sem LLM local em execução. Custo externo de desenvolvimento continua R$0. |
| 4 | **Budget preflight:** antes de uma operação potencialmente custosa, o Governor verifica orçamento disponível. Operação acima do limite é recusada **antes** da execução externa. |
| 5 | **Budget race safety:** duas operações concorrentes não podem individualmente passar no budget check e, juntas, ultrapassar o orçamento por condição de corrida — exige reserva atômica, não um `if (saldo >= custo)` solto. |
| 6 | **Tool Gateway:** toda ferramenta governada é solicitada por ele. Capacidade proibida é recusada antes da execução. |
| 7 | **Sandbox preservation:** execução de código continua usando o `SandboxManager` do M2. O Tool Gateway não cria caminho alternativo de execução irrestrita no host. |
| 8 | **Governor:** decide deterministicamente, no mínimo, `capability`, `TOOL_CALL`, `BUDGET_CHECK` e as regras já existentes (`SPEND`/`TASK_RETRY`/`TASK_START`). Nenhum LLM participa da decisão final de autorização. |
| 9 | **Auditabilidade:** `model_calls`/`tool_calls` registram no mínimo `agent_id`, `task_id`/`correlation_id`, adapter/ferramenta, timestamps, status, duração, custo estimado/real quando aplicável, e a decisão de autorização relacionada. |
| 10 | **Falhas:** timeout, adapter indisponível, resposta inválida e erro de ferramenta produzem estados/eventos conhecidos — nunca deixam operação financeira ou task em estado desconhecido. |
| 11 | **Segredos:** nenhuma chave/API secret aparece em frontend, prompt, evento, log ou payload persistido. Configuração sensível fica só no servidor. |
| 12 | **Bypass:** teste arquitetural/estrutural prova que agentes não acessam providers de IA nem ferramentas governadas diretamente — só pelos Gateways. |
| 13 | **Mock E2E:** pelo menos um ciclo do Orquestrador usa AI Gateway + Tool Gateway reais com `AI_MODE=mock` e chega ao resultado esperado. |
| 14 | **Contabilidade:** uso de IA/ferramentas registra custo de forma rastreável, sem transformar telemetria em receita nem alterar caixa indevidamente (`financial_ledger` continua só `REVENUE`/`OPERATING_COST`/`FOUNDER_SUBSIDY`, com `CHECK` de receita exigindo pagamento real). |
| 15 | **Compatibilidade com o M2:** outbox, idempotência, retries, revisão independente, crash recovery, `TASK_WAITING_SLOT` e o Governor atual continuam válidos — nenhum teste do M2 regride. |
| 16 | **Qualidade:** typecheck, lint, unit, integration e build passam de estado limpo. |

## Nota sobre o critério 5 (a mais delicada do M3)

Exemplo do problema que a reserva atômica evita:

```
Orçamento = R$5
Agente A verifica: R$4 disponível? SIM
Agente B verifica: R$4 disponível? SIM
A executa R$4
B executa R$4
Total = R$8 ❌ (estourou o orçamento de R$5)
```

Solução: todo custo estimado passa por um ciclo de reserva antes de executar — `AVAILABLE → RESERVED → SETTLED` (custo real confirmado) ou `RESERVED → RELEASED` (chamada não ocorreu/falhou). A reserva em si precisa ser uma operação atômica no banco (mesmo padrão de `UPDATE ... WHERE` condicional do `TransitionService`), não uma leitura-depois-escrita em dois passos separados — senão o mesmo problema de corrida se repete um nível abaixo.

## Separação: `model_calls`/`tool_calls` (técnico) vs. `financial_ledger` (financeiro)

Decisão explícita da revisão externa, para não repetir o erro de transformar todo log em movimentação financeira: `model_calls`/`tool_calls` registram `estimated_cost`, `actual_cost`, `currency`, `provider` como auditoria técnica da chamada. Só viram uma linha do `financial_ledger` (`OPERATING_COST`) através de uma camada de **Cost Accounting** que decide, segundo a política financeira, quando um custo estimado/real é de fato um fato econômico a registrar — nunca automaticamente, e nunca para chamadas `mock` (que já são `cost_brl = 0` por `CHECK` de schema). O `financial_ledger` continua incapaz de transformar estimativa de custo em receita ou alterar caixa fora das regras já existentes (§8.8 da especificação, migration 0001).

## O que falta no schema (não existe ainda, precisa de migration)

- `tool_calls`: tabela nova, mesmo espírito de `model_calls` (`agent_id`, `task_id`, ferramenta, status, duração, custo estimado/real, decisão de autorização).
- Uma tabela ou mecanismo de **reserva de orçamento** (`budget_reservations` ou equivalente) com estado (`RESERVED`/`SETTLED`/`RELEASED`) e expiração — para o critério 5.
- `model_calls` (migration 0001) já existe e já cobre boa parte do critério 9 (`agent_id`, `task_id`, `mode`, `provider`, `model`, tokens, `cost_brl`, `duration_ms`, `status`) — falta só `correlation_id` e o vínculo com a decisão do Governor, se não estiver coberto por evento.

## Fora do escopo do M3 (registrado, não esquecido)

- Ligar um LLM local real (Ollama ou similar) — decisão explícita por causa da RAM da máquina (8GB, já fragilizada no M2). Fica como capability futura, sem milestone formal (`M3b`) associado — ativa quando houver necessidade real e máquina/ambiente adequados.
- Ligar uma API de IA paga real — exige autorização explícita de gasto do dono (`AUTO_SPEND`), que continua `false` por padrão; não é decisão deste milestone.
- Scheduler, circuit breaker, Emergency Stop de verdade (M6) — o Governor do M3 decide `BUDGET_CHECK`/`TOOL_CALL`, mas a arquitetura de emergência completa é milestone futuro; o fluxo alvo já reserva o lugar para "Emergency Stop?" na decisão do Governor, mas a implementação plena não é critério de aceite do M3.

## Processo (mesmo que funcionou no M2)

Plano → critérios de aceite → implementação por passos, cada um com prova reexecutável → mutação confirmada nas propriedades críticas (especialmente a reserva de orçamento) → relatório de fechamento → revisão externa (mesma conversa do ChatGPT) → autorização do dono antes do merge em `staging`/`main`.
