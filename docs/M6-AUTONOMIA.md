# Milestone 6 — Autonomia · relatório de fechamento

- **Status:** implementação concluída; dos 24 critérios, 22 atendidos e 2 atendidos em parte (9 e 13), com as lacunas aceitas pela revisão externa listadas abaixo. A revisão externa exigiu fechar os critérios 8 e 16/23(c) antes do merge; ambos foram fechados. **Aguardando a revisão final e a autorização do dono para o merge.**
- **Base:** `docs/M6-PLANO.md` (aprovado pela revisão externa e autorizado pelo dono). Branch `feat/m6-autonomia`. Para o commit exato: `git log --oneline -1` na branch.
- **Regressão:** ver "Regressão" no fim. Custo externo R$0 (`AI_MODE=mock`, nenhum pagamento real).
- **Padrão de segurança:** `AUTONOMY_ENABLED=false` continua o padrão. Ligá-lo não dá autoridade nova a ninguém.

## O que o M6 entrega

Seis frentes sobre o ciclo do M2-M5, sem criar um segundo motor:

| Frente | Onde mora |
|---|---|
| Política de autonomia (ordem única: Stop → `AUTONOMY_ENABLED` → circuito → Governor) | `packages/autonomy/src/autonomy-controller.ts` |
| Scheduler com identidade lógica no Postgres | `scheduler.ts`, `scheduled_executions`, `apps/worker/src/scheduler-actions.ts` |
| Emergency Stop (serviço único, CLI e API do fundador) | `emergency-stop.ts`, `apps/cli`, `apps/api/src/routes/emergency-stop.ts` |
| Circuit Breaker por escopo `SOURCE`/`AGENT` | `circuit-breaker.ts`, `circuit-breaker-store.ts` |
| Recovery (tasks órfãs, reservas sem dono, sandboxes vazadas, pausas velhas) | `recovery.ts`, `packages/tools/src/sandbox-reaper.ts` |
| Lifecycle governado (só `PROBATION→ACTIVE`, `ACTIVE→SLEEP`, `SLEEP→ACTIVE`) | `lifecycle-policy.ts`, `lifecycle-service.ts` |

Os três invariantes intocáveis: (1) decisão autônoma permitida implica decisão manual permitida; o único caminho a "permitido" é `governor.evaluate`; (2) pausa, circuito ou Stop **não é falha** (status `PAUSED`, o job retorna normalmente, nenhuma tentativa é gasta, `Experience` só conta `ERROR`/`BLOCKED`); (3) o Postgres é a verdade, o BullMQ só transporta.

## Critérios de aceite

| # | Estado | Onde está a prova |
|---|---|---|
| 1 Agendas, frequências da Constituição, nada roda com `AUTONOMY_ENABLED=false` | Atendido | `autonomy-scheduler.test.ts`, `autonomy-scheduler-actions.test.ts` (as 5 agendas), composição (tick negado grava `SKIPPED`, `outbox` vazio) |
| 2 Identidade lógica idempotente, dois schedulers e ticks concorrentes = um efeito | Atendido | `scheduled_executions` com `UNIQUE (schedule_name, window_key)`; teste de concorrência e mutação sem o claim |
| 3 Tick negado grava o motivo e não é falha | Atendido | `SKIPPED` + `skip_reason`; nenhum evento de falha |
| 4 Tempo injetável | Atendido | todos os testes do Scheduler e do breaker usam relógio injetado |
| 5 Stop persistido, append-only, ator e motivo, serviço único, só humano | Atendido | `emergency-stop-failsafe.test.ts`, `autonomy-founder-stop.test.ts` (17 casos), CHECK do banco só aceita `FOUNDER_CLI`/`FOUNDER_API`, testes de arquitetura (só CLI e API tocam o serviço e `releaseAndResume`). Segredo da API só de `FOUNDER_ADMIN_SECRET` no ambiente do processo da API, comparação timing-safe, 404 sem segredo |
| 6 Com o Stop engajado nada mutável começa | Atendido | `autonomy-pause.test.ts` (jobs, Tool Gateway, IA), Scheduler, lifecycle, recovery; mutações de bypass em cada portão |
| 7 Fail-safe: estado ilegível nega; funciona sem Redis | Atendido | `readStopState` nunca lança (`UNVERIFIABLE`); o estado vive só no Postgres |
| 8 Quiescência com prazo máximo | Atendido | `quiescence.ts` (`QuiescenceGuard`): depois do ENGAGE a operação em curso tem `EMERGENCY_QUIESCENCE_TIMEOUT_SECONDS`; dentro do prazo termina o passo atual. Vencido: **cancelável** (sandbox) recebe o `AbortSignal`, o container é morto e removido e o Tool Gateway grava `PAUSED`; **não cancelável** (chamada de IA) termina sozinha, o resultado é **descartado** (`PROGRESS_BLOCKED`) e nada progride. Ambos gravam `EMERGENCY_QUIESCENCE_EXCEEDED`. **Transação de banco nunca passa pelo guard**, então nunca é interrompida. Estado do Stop ilegível não aborta nada. Prova: `autonomy-quiescence.test.ts` (7 casos, Docker real: sandbox de 60 s encerrada em segundos, sem container vazado, sem reserva presa) e 4 mutações pegas |
| 9 Só recomenda o Stop | Parcial (aceito): sem regra de disparo | `recommendEmergencyStop` só grava `EMERGENCY_STOP_RECOMMENDED` (uma por hora e por fonte/código); nenhum componente automático chama `engage`/`release` (teste de arquitetura). **Nenhum componente chama a recomendação ainda:** falta decidir a regra de quando recomendar |
| 10 Breaker persistido por escopo, limiares constitucionais, relógio injetável, sobrevive a restart | Atendido | `circuit-breaker.test.ts`, `autonomy-core.test.ts`; estado é a dobra dos eventos append-only |
| 11 Só o próprio escopo, `HALF_OPEN` com uma sonda | Atendido | mutação de vazamento de escopo; composição: fonte aberta e uma task inteira completa |
| 12 Alimentado só por falha técnica (fonte) e desfecho terminal (agente); pausa nunca conta | Atendido | `discovery-handler` e `experience-handler`; `autonomy-pause.test.ts`; mutação "pausa contada como falha" |
| 13 Retries classificados, só `BUSINESS_RETRY` consome | **Parcial (aceito)** | Classificação e a regra em `retry-policy.test.ts`; arquitetura garante que só o Revisor escreve `retry_count`; composição prova Stop e circuito sem gastar tentativa (`retry_count` 0, nenhum job falhou). **Sem prova de worker para espera de slot e reentrega do BullMQ** |
| 14 Backoff técnico formalizado | Atendido | `TECHNICAL_BACKOFF` (exponencial, 1 s, jitter 0,5), lista de erros não retentáveis vira `UnrecoverableError` |
| 15 Recovery só de estado técnico, reserva só com prova de que não há dono vivo | Atendido | `autonomy-recovery.test.ts` (16 casos), inclusive paralelo e Docker real; nunca toca ledger, pagamento nem `PAID` |
| 16 Recovery depois de interrupção equivalente à do M2 (worker encerrado no meio) | Atendido no nível controlado do M2 | `m6-composition.test.ts`, "Worker A cai no meio do ciclo": Worker A preso no passo do Desenvolvedor e fechado à força; o Stop é engajado; Worker B assume o job stalled relendo o Postgres, **pausa em vez de falhar**; o RELEASE retoma; a task conclui com `retry_count` 0 e cada evento-chave (`TASK_STARTED`, `IMPLEMENTATION_READY`, `REVIEW_STARTED`, `REVIEW_PASSED`, `TASK_COMPLETED`), a `Experience` e a task exatamente uma vez. Recovery e Scheduler depois disso não mudam nada. **É a interrupção controlada do M2, não um crash de processo** |
| 17 Lifecycle: só as três transições, amostra mínima, histerese, cooldown, evidência, Governor, histórico append-only | Atendido | `lifecycle-policy.test.ts`, `autonomy-lifecycle.test.ts` (19 casos) |
| 18 Amostra pequena nunca é ruim; janela sobreposta a pausa não vale; sem o ciclo "circuito → SLEEP" | Atendido | mutações de amostra e de janela pausada |
| 19 `SLEEP→ACTIVE` por cooldown + demanda elegível + Governor, sem depender de desempenho; humano pelo mesmo serviço | Atendido | `LifecycleService.applyManual` com ator `FOUNDER`; mutação de lock-in |
| 20 Sem `ARCHIVED`, criar ou remover agente | Atendido | CHECK do banco, regra do Governor, teste de arquitetura |
| 21 Autonomia não aumenta autoridade | Atendido | propriedade em `autonomy-controller.test.ts` sobre toda ação governada; `AUTO_SPEND` independente |
| 22 R$0, `AI_MODE=mock` | Atendido | nenhum pagamento real, nenhum ledger `REAL` |
| 23 Composição sobre o ciclo real | Atendido, com a dívida de 23(a) | `tests/integration/m6-composition.test.ts` (5 cenários; Postgres, Redis, BullMQ, Docker e GitHub fake): tick → descoberta → Diretor; Stop no meio do ciclo pausa sem falhar e o RELEASE completa sem duplicar; circuito de fonte aberto barra só a descoberta; recovery de job perdido; queda do Worker (critério 16). **Dívida de observabilidade aceita pela revisão externa:** o tick não registra o motivo do circuito (só o portão de jobs pausa) e `HALF_OPEN→CLOSED` está provado nos testes isolados, não na composição |
| 24 Regressão M1-M5 verde | Atendido | ver abaixo |

## Defeitos que só a composição achou (corrigidos)

1. **`jobId` com `:` era recusado pelo BullMQ.** `scheduled-DISCOVERY:…` e `recovery:redispatch:…` entravam no outbox e nunca eram despachados, com 32 tentativas de despacho. Os testes isolados só olhavam o `job_id` da linha do outbox. Correção: os ids usam `-`, e `enqueueInOutbox` agora **recusa `:` na hora**, dentro da transação.
2. **Trabalho pausado ficava sem quem o retomasse** quando o circuito fechava ou quando o `RELEASE` era interrompido entre liberar e retomar. Correção: a varredura do recovery retoma pausas mais velhas que o prazo de "sem sinal de vida", com o Stop liberado; a primeira retomada depois do cooldown é a própria sonda `HALF_OPEN`.

## Decisões e desvios para a revisão conferir

1. O circuito só barra trabalho **novo** (descoberta pela fonte; primeira tentativa `ASSIGNED` do Desenvolvedor). Barrar a continuação travaria a task que serve de sonda.
2. O Scheduler usa `setInterval` de 60 s no worker como **transporte**, e não um repeatable job do BullMQ. A identidade da janela é do Postgres, então dois workers ou um restart não duplicam efeito.
3. O motivo de circuito aberto aparece no portão de jobs (pausa), não no tick. É o desvio do critério 23(a).
4. O recovery reutiliza `RESERVATION_STALE_AFTER_SECONDS` (30 min) como horizonte de "sem sinal de vida" também para tasks e pausas.
5. `scheduled_executions.skip_reason` também guarda o texto do erro de uma execução `FAILED`.
6. A Constituição ganhou o bloco `autonomia`; o Governor ganhou a ação `AGENT_LIFECYCLE_TRANSITION`.
7. O migrator agora normaliza CRLF→LF no checksum (Windows gravava CRLF e recusava migrations "editadas").

## Lacunas conhecidas (nada aqui é escondido)

Aceitas pela revisão externa como documentadas, sem bloquear o merge:

- Provas de worker para espera de slot e reentrega do BullMQ (critério 13); Stop e circuito sem gastar retry estão provados.
- O tick não registra o motivo do circuito, e `HALF_OPEN→CLOSED` não está na composição (23a).
- `recommendEmergencyStop` existe e só grava evento, mas nenhum componente o chama: falta a regra de quando recomendar, que deve nascer de evidência operacional (critério 9).
- A rota HTTP do Stop usa só o segredo compartilhado, sem limitação de taxa: adequado ao uso local, hardening futuro antes de expor a API.
- A mutação do portão de jobs sozinha não derruba a composição da queda do Worker, porque o Tool Gateway também barra com o Stop engajado (defesa em profundidade); cada camada é derrubada isoladamente em `autonomy-pause.test.ts`.

## Regressão

Unitária 351/351 (inclui os testes de arquitetura), integração 235/235 (28 arquivos, Postgres, Redis, BullMQ e Docker reais), typecheck e lint limpos. As mutações de cada garantia foram feitas uma a uma (quebrar, ver o teste específico falhar, reverter).
