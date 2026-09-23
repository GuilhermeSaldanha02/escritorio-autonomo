# M7-INTEGRATION — handoff para revisão do owner

Branch `codex/m7-integration`, derivada do M7-UI encerrado em `2422832`. Nenhum merge, M8, redesign, alteração de autoridade/Constitution/Governor ou de regra financeira. A migration própria é `0014_office_projection` (head, journal, receipts), validada com up/down apenas no banco descartável `office_m7_test` em contêiner isolado. Não usar esse procedimento contra o banco do owner. `.env` e secrets não foram lidos nem alterados.

## Fluxo implementado

Backend real → projeção read-only persistida → snapshot consistente + journal ordenado → GET `/office/snapshot` e WebSocket `/office/stream` → `LiveOfficeDataSource` → Office 2D existente. `FixtureOfficeDataSource` permanece como modo explícito de demonstração; LIVE não cai silenciosamente para fixture. O adapter aplica replacements idempotentes, reconecta com o último cursor aplicado e faz resync em gap/epoch/expiração. React e Phaser consomem o contrato, não o banco ou Redis. O Game permanece montado durante atualizações; arte, layout e assets não foram editados.

## Verificações executadas pelo implementador

- Unit raiz: 54 arquivos / 399 testes no hook de `9163427`; UI: 12 arquivos / 39 testes após a correção do fetch global.
- Integração completa final: 31 arquivos / 257 testes, incluindo up/down 0014, journal, replay, limites WS, overflow, retry 40001 e retenção concorrente. Uma rodada intermediária falhou porque o teste de overflow deixava um valor sintético incompatível com o downgrade 0010; limpeza transacional corrigida e a linha foi removida apenas do banco descartável. Outra rodada falhou porque Docker/PostgreSQL/Redis não estavam ativos; após restaurar os contêineres próprios, a suíte completa passou. A primeira rodada anterior teve três timeouts/contensão em testes antigos de orquestrador/sandbox; os 16 testes de sandbox e 7 do orquestrador passaram isoladamente.
- Typecheck raiz, lint raiz, lint UI e build do monorepo passaram. Lint UI mantém avisos não bloqueantes de Fast Refresh em contextos. Build mantém aviso conhecido: chunk Phaser de 1.723,44 kB minificado, acima de 500 kB.
- Fixture em navegador: seis salas e quatro personagens preservados; quatro Inspectors selecionados individualmente; viewport mobile sem overflow horizontal; após reload completo, sem erro/aviso novo no console. Comparação com `qa/evidencias/M7-POLISH/final.png` e demais capturas aprovadas. Esta é prova do implementador, não revisão independente.
- Snapshot direto e via proxy Vite responderam HTTP 200, contrato 2.0.0 e modo LIVE; parse do envelope passou. O navegador interno bloqueia `/office/snapshot` com `ERR_BLOCKED_BY_CLIENT`. No Chrome do owner, a fonte viva revelou `Illegal invocation` por chamar `window.fetch` sem receptor; um teste falhou antes da correção mínima e passou depois. Chrome isolado, sem extensões, renderizou LIVE em `qa/evidencias/M7-INTEGRATION/live-after-fetch-fix.png`. Não declarar aceite visual independente.

## Matriz I01–I18

`ALEGADO` significa evidência do implementador, não aceite independente. `PARCIAL` significa que ao menos uma assertiva do plano ainda não tem execução suficiente.

| ID | Estado | Evidência e lacuna |
| --- | --- | --- |
| I01 | ALEGADO | Seed/IDs, agente ausente, estado desconhecido: contrato, projeção unitária e integração. |
| I02 | ALEGADO | Associação, ambiguidade e pausa: `apps/api/test/office-projection.test.ts`. |
| I03 | ALEGADO | Datas null, IDLE, SLEEP/ARCHIVED: contrato, projeção e scene model. |
| I04 | ALEGADO | Ledger 10000/5000/3000/2000, custo/subsídio, REAL separado, negativo/zero/overflow: integração de projeção. |
| I05 | ALEGADO | Engage/release, SOURCE/AGENT OPEN/HALF_OPEN/CLOSED e leitura sem probe: integração Office; `UNVERIFIABLE` contra Postgres real em `autonomy-core.test.ts` e apresentação null na projeção pura. |
| I06 | ALEGADO | GET→SUBSCRIBE e revisão/cursor: `office-stream.test.ts`, contrato e journal. |
| I07 | ALEGADO | Transação A não commitada, B commitada, A depois: `office-projection.test.ts`; recibos e replay ordenados. |
| I08 | ALEGADO | Dois projectors concorrentes, rollback pré-commit, retry `40001` com nova conexão e nova execução pós-commit sem duplicata: integração de projeção. |
| I09 | ALEGADO | Reconciliação sem evento, recibos, evento desconhecido e canário de payload: integração. |
| I10 | ALEGADO | Cursor futuro/expirado/outra epoch/gap, nova instância da API, reconnect e novo `LiveOfficeDataSource` sob remontagem React: integração + unit. Reinício visual LIVE no Chrome do owner ainda não foi aceito, conforme I16. |
| I11 | ALEGADO | Evento e mensagem desconhecidos, major incompatível, AgentState novo: unit e integração. |
| I12 | ALEGADO | Backoff, heartbeat perdido, STALE, single-flight, unsubscribe e socket compartilhado: unit; montagem/desmontagem LIVE sob React StrictMode com fetch/socket falsos. Chrome isolado mostrou conexão LIVE; teste visual de reconnect pelo owner ainda não ocorreu. |
| I13 | ALEGADO | Canários sintéticos em payload, oportunidade/URL e texto externo omitidos; allowlists de schema e rotas. Não foram usados secrets reais. |
| I14 | ALEGADO | Fixture exibe HTML hostil como texto; Host/Origin e comandos de escrita recusados, inclusive STOP. Sem captura de rede externa do navegador nesta rodada. |
| I15 | ALEGADO | Fixture e LIVE offline, modo explícito, ausência de import backend concreto na cena: unit + auditoria de imports. |
| I16 | PARCIAL | 100 snapshots preservam Game/seleção/câmera mock; quatro Inspectors fixture verificados visualmente. Chrome isolado mostrou Office LIVE após correção do fetch, mas atualização sem F5, pan/zoom sob stream real e Inspectors LIVE ainda precisam de aceite externo. |
| I17 | ALEGADO | Retenção, 250 eventos sintéticos, lote/recibos/timeline, comando WS >2 KiB, buffer saturado sintético com fechamento 1009 e replay iniciado antes da retenção com barreira transacional: integração. |
| I18 | ALEGADO | Migration 0014 up/down preserva domínio; consultas Office read-only; regressão completa final 31/257 verde no banco descartável. |

## Próximo passo, sem ampliar escopo

I16 permanece PARCIAL na prova visual LIVE: o navegador interno bloqueia o endpoint loopback, mas o Chrome isolado já renderiza a cena após corrigir o fetch global. Owner deve validar no próprio Chrome a atualização sem F5, os quatro Inspectors e pan/zoom, guardando print, console e rede sanitizados em `qa/evidencias/M7-INTEGRATION/`. A revisão independente decide `PASSOU`; não fazer merge automaticamente.
