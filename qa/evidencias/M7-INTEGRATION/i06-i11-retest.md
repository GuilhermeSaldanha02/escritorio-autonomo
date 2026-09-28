# I06/I11 — autorreteste após reprovação independente (2026-09-23)

Fonte da reprovação: apontamentos do owner nesta tarefa, atribuídos ao QA independente. Não foi fornecido relatório bruto do QA para anexar. Este registro é prova do **implementador** e não altera o veredito externo até novo reteste pelo mesmo QA.

## I06 — mesmo cursor, mesmo snapshot

- Causa confirmada: `oneRefresh` gerava `generatedAt` e `metadata.observedAt` novos em tick sem alteração nas cinco seções e persistia outro snapshot sob a mesma revisão. Em revisão com seção alterada, o journal não levava essas datas ao cliente.
- Regressão antes da correção: `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/office-projection.test.ts -t 'I06:'` → **2 falhas**: timestamps diferentes com mesmo cursor; replacement sem `generatedAt`/`metadata`. O teste de contrato `packages/office-contract/test/schema.test.ts -t 'I06:'` também falhou antes da correção.
- Correção `2e15b24`: snapshot do head é preservado integralmente sem revisão; `observed_at` do head segue avançando para o heartbeat; updates de revisão real incluem datas/metadata e ao menos uma seção de domínio. REST e replay devolvem o mesmo snapshot para o cursor.
- Depois: teste focado I06 **2/2**; contrato **4/4**; `office-projection.test.ts` + `office-stream.test.ts` **20/20** em PostgreSQL descartável.

## I11 — mensagens WS inválidas repetidas

- Causa confirmada: falha de parse chamava resync com refetch e novo socket imediatos; `SYNC_COMPLETE` zerava tentativa de conexão, permitindo novo ciclo agressivo.
- Regressão antes da correção: teste `I11: mensagens inválidas repetidas` em `LiveOfficeDataSource.test.ts` **falhou**, pois o segundo socket surgiu antes do atraso exigido.
- Correção `5803223`: para mensagens inválidas consecutivas sem intervalo superior a 60 s, há dois retries com esperas de 1 s e 2 s; a terceira encerra novos sockets, deixa cache visível com conexão `DISCONNECTED` e não avança cursor. Update válido zera a contagem. O teste repete mensagem inválida após `SYNC_COMPLETE`, não só uma ocorrência.
- Depois: `LiveOfficeDataSource.test.ts` **9/9**; UI completa **12 arquivos/40 testes**.

## Gates finais do implementador

- `pnpm run test:integration` → **31 arquivos/259 testes**, exit 0, duração 299,17 s. `TEST_DATABASE_URL` foi derivada no shell preparado e validada como `office_m7_test` no PostgreSQL descartável loopback `61223`; Redis descartável loopback `61225`. A suíte inclui migration 0014 up/down e regressão M1–M6. Nenhum reset no banco `office_m7_owner_live` nem no banco do owner.
- `pnpm run test:unit` → **54 arquivos/401 testes**, exit 0; hooks dos dois commits de código também passaram 401/401.
- `pnpm --filter ui run test:unit` → **12 arquivos/40 testes**, exit 0.
- `pnpm run typecheck` → exit 0.
- `pnpm run lint` → exit 0.
- `pnpm --filter ui run lint` → exit 0, três warnings conhecidos `react(only-export-components)`.
- `pnpm run build` → exit 0, warning conhecido de chunk Phaser/UI de 1.723,77 kB (>500 kB).
- `git diff --check` → sem erros antes dos commits.

Não foi lido ou modificado `.env`/secret. Sem redesign, merge ou M8. O reteste independente de I06/I11 continua pendente.
