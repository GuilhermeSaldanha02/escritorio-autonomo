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
3. ✅ **Contratos §13** validados (zod) e agentes determinísticos em `packages/agents`.
4. ✅ **Sandbox Manager** em `packages/tools`: container descartável sem rede, com teto de CPU/RAM/disco/pids/tempo.
5. ✅ **Orquestrador** no Worker: cada passo grava transição + evento + próximo job atomicamente.
6. **API de simulação** e consulta da linha do tempo.

## Critérios de aceite do M2

| # | Critério | Prova esperada |
|---|---|---|
| 1 | Evento e job são atômicos: com Redis fora, o evento fica pendente no outbox e é publicado quando o Redis volta | ✅ `tests/integration/outbox.test.ts` (Redis inalcançável real) |
| 2 | Reentrega do outbox não duplica job nem evento | ✅ `outbox.test.ts`: reentrega e 3 dispatchers concorrentes |
| 3 | Transições inválidas de oportunidade e tarefa são recusadas por código; nenhum agente declara `PAID` | ✅ `packages/shared/test/lifecycle.test.ts` (18 casos) + `tests/integration/transitions.test.ts` (garantia real do banco, não só em memória — 8 testes, mutação confirmada) |
| 4 | Cenário feliz percorre o fluxo alvo completo até `COMPLETED`, com todos os eventos persistidos em ordem | ✅ `tests/integration/orchestrator.test.ts` (Postgres+Redis+Docker reais, `OPPORTUNITY_FOUND`→...→`REVIEW_PASSED`) |
| 5 | Revisor valida em sandbox **independente** da do Desenvolvedor (container novo, reconstruído a partir do snapshot + hash — ver nota abaixo) | ✅ `orchestrator.test.ts` (developer_sandbox_id ≠ review_sandbox_id; sandbox do Revisor roda de verdade e decide pelo que observa, não pelo autodeclarado) + `reviewer.test.ts` (hash divergente recusa sem tocar Docker) |
| 6 | Revisão reprovada volta ao Desenvolvedor; após `MAX_TASK_RETRIES` a tarefa vira `BLOCKED` com `TASK_BLOCKED` | ✅ `orchestrator.test.ts` (retry_count incrementa e IN_PROGRESS; no limite, BLOCKED + oportunidade FAILED) |
| 7 | Oportunidade que exige capacidade proibida gera `ACTION_BLOCKED` e é rejeitada, sem criar tarefa | ✅ `orchestrator.test.ts` (TRADING negado pela Constituição → REJECTED, nenhuma task) |
| 8 | Sandbox sem rede, sem capabilities, não-root, com teto de memória/CPU/pids/disco e tempo máximo | ✅ `tests/integration/sandbox.test.ts` (16 testes; mutação confirmada em rede e não-root; CPU verificado via `inspect().HostConfig.NanoCpus` — smoke test do valor que chega ao Docker, não benchmark de desempenho) |
| 9 | Paralelismo respeita `MAX_PARALLEL_TASKS` | ✅ `orchestrator.test.ts` (Governor recusa `TASK_START` com o limite ocupado — garantia V1 single-worker, ver nota) |
| 10 | Estado dos agentes muda durante o ciclo (`AGENT_STATE_CHANGED`) — base para o Office | ✅ `orchestrator.test.ts` (DESENVOLVEDOR-001/REVISOR-001 mudam de estado, eventos persistidos) |
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

### 3. Contratos e agentes mock — concluído (`844d27b`)

- `packages/agents`: contratos §13.1–§13.4 (zod, `.strict()`), Diretor (`decide` + `authorizeExecution`), Desenvolvedor (`runMockDeveloperTask`, mock explícito) e Revisor (`decideReview` + `nextTaskStatusAfterReview`).
- **Separação propositalmente reforçada:** `decide()` não recebe o Governor (o Diretor não pode alterá-lo nem contorná-lo); `authorizeExecution()` é o segundo portão obrigatório mesmo com `EXECUTE`, e só ele pode negar por proibição. `decideReview()` não recebe quem implementou — nunca aprova o próprio trabalho de quem chama.
- Fórmula de score do Diretor é provisória e documentada como tal — dado real de mercado só chega no M4 (Caçador real); nenhum dado de negócio foi inventado, é heurística de infraestrutura para provar o fluxo.
- **Prova:** 33 testes unitários (contratos rejeitam payload malformado/campo extra; Diretor determinístico e sensível a `automation_allowed`/`reward_verified`/score; Governor bloqueia `EXECUTE` proposto pelo Diretor quando a capacidade exigida é proibida; Revisor reprova com build quebrado, teste falho ou qualquer alerta de segurança; retries até `MAX_TASK_RETRIES` voltam ao Desenvolvedor, depois `BLOCKED`).
- **Ainda não wired a nada:** este pacote não fala com o Event Bus, o banco nem o Worker. É lógica pura, testável sem Docker. A ligação (persistir cada transição, publicar eventos, criar a Task real) é o Orquestrador — passo 5.

### 4. Sandbox Manager — concluído (`6f1b034`)

- `packages/tools`: `SandboxManager.run()` cria um container novo por chamada (dockerode), sempre remove ao final. `NetworkMode: none`, `CapDrop: ALL`, `SecurityOpt: no-new-privileges`, `ReadonlyRootfs: true`, `User: 65534:65534` (nobody), `/workspace` em tmpfs com teto de tamanho, `Memory`/`MemorySwap`/`NanoCpus`/`PidsLimit` no HostConfig.
- **Truque central:** arquivos e comando viajam só por variável de ambiente (JSON + base64), nunca interpolados em texto de shell — zero risco de injeção via nome de arquivo, conteúdo ou argumento. O shell grava os arquivos com um `node -e` de script fixo e só então faz `exec "$0" "$@"`, trocando de processo para o comando real: é por isso que o comando vira o PID 1 do container, e o OOM killer / SIGKILL de timeout / código de saída refletem *o comando*, não um intermediário nosso.
- **Prova:** 14 testes de integração com Docker real — stdout/stderr separados, seed de arquivo (raiz e subdiretório), código de saída propagado, sem rede, não-root, estoura memória (`OOMKilled`), estoura disco (tmpfs, `ENOSPC`), estoura tempo (`timedOut`), contém fork bomb (`pidsLimit`), sempre remove o container, dois runs nunca compartilham `/workspace`, limites inválidos recusados antes de tocar o Docker.
- **Mutação confirmada:** `NetworkMode: bridge` fez o teste de rede falhar 3/3 vezes; `User: root` fez o teste de não-root falhar.
- **Duas descobertas de ambiente (Docker Desktop + WSL2 nesta máquina), documentadas no código/teste, não corrigidas por serem do ambiente, não do Sandbox Manager:**
  1. `pidsLimit` abaixo de ~10 faz o próprio `spawn()` do Node **travar** em vez de falhar (fork() nunca retorna erro) — quem mata o processo nesse caso é o timeout do Sandbox Manager, não o próprio script. O teste usa `pidsLimit: 10`, que já contém a fork bomb (37/40 falharam) sem esse efeito.
  2. Testar "sem rede" com `fetch('http://...')` é frágil: sem interface de rede, a resolução de nome não erra rápido, **trava até o `AbortSignal`** — e por depender só do relógio, um teste assim deu falso-negativo quando a rede do host estava momentaneamente lenta (visto nesta sessão: bridge com internet real, mas conexão >3s, reportando "sem rede" por engano). Corrigido testando uma conexão TCP direta por IP (sem DNS): com `--network none` o kernel nem tenta rotear, e o erro (`ENETUNREACH`) chega em milissegundos — determinístico nas duas direções.
- **Ainda não wired ao Desenvolvedor/Revisor.** `runMockDeveloperTask` (passo 3) continua mock; ligar o Desenvolvedor a uma sandbox real e o Revisor a uma segunda sandbox independente (critério 5) é trabalho do Orquestrador — passo 5.
- **Teste de CPU adicionado depois da revisão inicial:** `NanoCpus` era o único limite do critério 8 sem prova própria (as outras 14 provas cobrem memória/pids/disco/tempo/rede/não-root). Como não há como medir "quanto CPU o kernel entregou" de forma barata e determinística, o teste inspeciona o container ainda em execução (via `docker.listContainers` pelo prefixo do nome, já que `run()` sempre remove o container ao sair) e confere que o `HostConfig.NanoCpus` que o Docker recebeu bate com o pedido — prova que o valor chega, não um benchmark. `validateLimits` também passou a rejeitar `cpuFraction` abaixo de 0.001 (mínimo que o próprio Docker aceita para `NanoCpus`), com teste dedicado.
- **Decisão sobre o critério 5 ("código reconstruído do diff"):** o `SandboxManager.run()` recebe `files: Record<string,string>` — conteúdo completo, não um diff. Aplicar um diff dentro do sandbox exigiria `git`/`patch` na imagem (ausentes em `node:24-alpine`) e o conteúdo anterior para aplicar contra — e o sandbox não tem rede para buscar nada em tempo de revisão. Decisão: o transporte entre Desenvolvedor e Revisor no Orquestrador (passo 5) é o conteúdo dos arquivos pós-mudança (que a sandbox do Desenvolvedor já produziu), não o diff — o Revisor semeia uma sandbox nova a partir desses arquivos. O campo `diff` do contrato `ImplementationReady` continua existindo como artefato de auditoria no evento, não como mecanismo de transporte. O critério 5 fica provado por `sandboxId`s distintos entre as duas execuções (Desenvolvedor e Revisor nunca reaproveitam container), não por reconstrução literal via patch.

## Revisão externa antes do passo 5 (ChatGPT, 2026-09-17)

Consultado antes de iniciar o Orquestrador (passo 5), com o progresso dos passos 1-4. Decisões incorporadas ao design:

- **Transição atômica (aprovado, com 3 exigências):** `UPDATE ... WHERE status = $from` na mesma transação do evento/outbox (não depois). `rowCount === 0` deve diferenciar `NOT_FOUND` (linha não existe) de `STATE_CONFLICT` (outro worker já moveu o estado) — importante para recovery/debug. Um `STATE_CONFLICT` onde o estado atual já É o alvo da mesma chave de idempotência deve virar `ALREADY_APPLIED`, não uma falha — protege contra duplicidade de entrega do BullMQ. A cadeia de autoridade do passo 2 (`Agent → State Machine → Actor/Authority → Atomic persistence`) continua obrigatória: o SQL atômico resolve concorrência, não substitui `assertOpportunityTransition`/`assertTaskTransition`.
- **Um job por transição (aprovado):** preferido a um job único rodando o ciclo inteiro. `PostgreSQL` registra onde a empresa está; `BullMQ` transporta o que precisa acontecer a seguir — um crash retoma do outbox pendente, não perde a task.
- **`MAX_PARALLEL_TASKS` via concorrência do BullMQ — aprovado só como garantia V1 single-worker**, documentada explicitamente como tal. Com múltiplos processos Worker no futuro, `concurrency` por processo não soma um limite global da empresa — isso fica para o Governor/Orchestrator decidir mais adiante; não construir um semáforo distribuído agora.
- **Critério 5 — mudança de terminologia:** não descrever como "código reconstruído do diff" (tecnicamente não é o que acontece). Descrever como: *"o Revisor reconstrói o estado candidato em uma sandbox nova e independente usando o snapshot pós-implementação produzido pelo Desenvolvedor; o `diff` permanece como artefato de auditoria, não como mecanismo de transporte/reconstrução."* A intenção original da especificação era impedir que o Revisor rodasse no MESMO container do Desenvolvedor ("parece funcionar" → aprova) — isso está garantido pelos containers descartáveis independentes.
- **Integridade do artefato entre Desenvolvedor e Revisor (novo requisito):** não confiar apenas no snapshot recebido. `runMockDeveloperTask` deve produzir um hash SHA-256 determinístico do snapshot de arquivos resultante (`resultingSnapshotHash`); o Orquestrador leva esse hash até a sandbox do Revisor, que recalcula o hash do que recebeu e confere contra o esperado antes de revisar. Prova que o Revisor analisou exatamente o artefato que saiu do Desenvolvedor, sem depender de estado/processo compartilhado. Guardar `sandboxDevId`/`sandboxReviewId`/`originalSnapshotHash`/`resultingSnapshotHash` nos eventos relevantes.
- **Arquitetura do Orquestrador:** evitar uma classe monolítica. Separar em handlers por etapa (`OpportunityHandler`, `DirectorHandler`, `DevelopmentHandler`, `ReviewHandler`, `RetryHandler`) coordenados por um `TransitionService` comum que compõe State Machine + Governor + persistência atômica + evento + outbox. Nunca pular uma camada: `Agente propõe → Governor autoriza → State Machine valida → Banco confirma atomicamente → Evento registra → Outbox garante continuação`.
- **Critério de fechamento do M2** (não é contagem de testes): provar que `CRASH`, `REDIS DOWN`, `DUPLICATE DELIVERY`, `RETRY`, `REVIEW FAILED` e `FORBIDDEN ACTION` não conseguem, nenhum deles: duplicar trabalho crítico, pular estado, burlar o Governor, aprovar a própria execução, exceder retries, ou deixar o sistema sem saber em que estado a task está.

### 5. Orquestrador — concluído

- `packages/events/src/transitions.ts`: `transitionOpportunity`/`transitionTask` fazem `UPDATE ... WHERE status = $from` na mesma transação do evento+outbox — fecha o gap do passo 2. Distingue `TransitionNotFoundError` de `TransitionConflictError`; reentrega idempotente da mesma transição vira `ALREADY_APPLIED`, não erro nem duplicidade. `assertOpportunityTransition`/`assertTaskTransition` continuam rodando antes do UPDATE — o SQL atômico resolve concorrência, não abre atalho para pular a validação de autoridade.
- `apps/worker/src/orchestrator/`: um handler por transição pesada (`opportunity-handler`, `development-handler`, `review-handler`), coordenados por `orchestrator-worker` (fila `orchestrator`, um job por passo do ciclo, concorrência = `MAX_PARALLEL_TASKS`). Cada handler é idempotente por leitura de estado — uma reentrega do BullMQ (at-least-once) relê o status atual no banco em vez de assumir de onde o payload do job diz que partiu, então resume corretamente depois de um crash em qualquer ponto.
- Ciclo real da oportunidade agora tem o estado `EVALUATING` entre `VERIFIED` e `APPROVED`/`REJECTED` (o grafo de transições do passo 2 já prendia nisso — corrigido, não relaxado).
- **Critério 5 — decisão de terminologia** (revisão externa antes do passo 5): o Revisor não reconstrói a partir do `diff` literal — reconstrói a partir do **snapshot de arquivos pós-mudança** (`resulting_files`) que o Desenvolvedor produz, com um **hash SHA-256** (`resulting_snapshot_hash`, `packages/shared/src/snapshot.ts`) que o Revisor recalcula e confere antes de rodar qualquer coisa. Hash divergente reprova sem tocar o Docker. O `diff` permanece só como artefato de auditoria no evento.
- **Desenvolvedor mock, versão real** (`runDeveloperTaskInSandbox`): roda um programa fixo e determinístico (`packages/agents/src/mock-solution.ts`) num container real — o "mock" está na inteligência (nenhum código é gerado a partir da tarefa), não na execução (container, build e testes são reais). O Revisor roda o **mesmo comando** numa **sandbox nova e independente**, seedada com o snapshot recebido — nunca reaproveita a do Desenvolvedor, e `decideReview` nunca recebe quem implementou.
- `MAX_PARALLEL_TASKS` (critério 9): antes de iniciar uma task, o `development-handler` conta tasks em `IN_PROGRESS`/`IN_REVIEW` no banco e consulta `governor.evaluate({kind:'TASK_START', ...})` — uma garantia real do Governor, não só a concorrência do BullMQ. Documentado como **garantia V1 single-worker** (orientação da revisão externa): com múltiplos processos Worker, um limite verdadeiramente global fica para depois do M2.
- `AGENT_STATE_CHANGED` (critério 10): `apps/worker/src/orchestrator/agent-state.ts` atualiza `agents.state` e publica o evento vinculado à task, numa transação própria (perder um evento de estado isolado não corrompe o ciclo de negócio).
- Migration `0003_orquestrador`: `opportunities.required_capabilities` (capacidades que a execução exigiria — o Diretor/Governor precisam disso e o contrato §13.1 não carrega).
- **Prova:** `tests/integration/transitions.test.ts` (8 testes: aplicar, recusar, `ALREADY_APPLIED`, `TransitionConflictError`, `TransitionNotFoundError`, duas transições concorrentes do mesmo `from` — exatamente uma aplica; regras de autoridade de oportunidade). `tests/integration/orchestrator.test.ts` (5 testes: cenário feliz completo até `COMPLETED` com sandboxes distintas e eventos-chave persistidos; capacidade proibida → `ACTION_BLOCKED` sem task; retry disponível → `IN_PROGRESS`; retries esgotados → `BLOCKED` + oportunidade `FAILED`; Governor recusa `TASK_START` no limite). `packages/agents/test/reviewer.test.ts` (novo: hash divergente reprova sem chamar a sandbox — mutação confirmada). Mutação confirmada também em: `WHERE status = $from` (3 testes de transições quebram), `TASK_START` do Governor (teste de paralelismo quebra).
- **Simplificação consciente:** a "verificação determinística" e a decisão do Diretor rodam no mesmo job (`decide-opportunity`) em vez de jobs separados — ambas são operações rápidas, sem I/O externo, e cada sub-transição já é atômica e idempotente por si (uma reentrega no meio resume do estado real, não duplica nada). Um job por passo pesado (Desenvolvedor em sandbox, Revisor em sandbox) é onde isso realmente importa, e é o que foi feito.
- **Fora do M2, registrado para depois:** decisões `BACKLOG`/`INVESTIGATE` do Diretor deixam a oportunidade parada em `EVALUATING` sem reavaliação futura (§19 pede provar o fluxo feliz e os bloqueios, não o backlog). `repository`/`branch` do contrato do Desenvolvedor são sintetizados (`mock://local`) — não existem no schema de `tasks` porque não há repositório real até M4+.
- **Gap latente (não é bug no M2, apontado na revisão final do passo 5):** uma task barrada pelo `TASK_START` do Governor esgota as tentativas do job (`MAX_TASK_RETRIES + 1`, backoff exponencial) e fica parada em `ASSIGNED` sem nenhum job pendente nem evento — o sistema perde de vista o motivo. Com um único Worker isso nunca acontece na prática (a concorrência do BullMQ já é `MAX_PARALLEL_TASKS`, então o Governor nunca chega a negar), por isso o teste de paralelismo (critério 9) precisou inserir manualmente duas tasks "ocupantes" para forçar o caso. Com mais de um processo Worker, precisa de reenfileiramento com atraso (ou um evento explícito tipo `TASK_WAITING_SLOT`) em vez de um `throw` que só conta como tentativa perdida.

## Fora do escopo do M2

IA real (M3), Tool Gateway completo (M3), conector real do Caçador (M4), memória vetorial e ledger de custos (M5), scheduler/circuit breaker/Emergency Stop (M6), Office 2D (M7), submissão real e pagamento.
