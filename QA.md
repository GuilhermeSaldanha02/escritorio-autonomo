# QA — M7-UI

## Mapa de áreas

| ID | Área | Estado | Commit de verificação | Evidência |
| --- | --- | --- | --- | --- |
| M7-UNIT | Data source, fixture, resolver, scene model e blueprint visual | ALEGADO | rodada 2026-09-22 | 49 arquivos / 379 testes; prova do próprio implementador |
| M7-BUILD | Typecheck, lint e build do UI | ALEGADO | rodada 2026-09-22 | todos passaram; aviso não bloqueante de chunk Phaser |
| M7-VISUAL | Cenário, personagens, Inspector/Timeline e segurança de texto | ALEGADO | rodada 2026-09-22 | `qa/evidencias/M7-REBUILD/`; prova do próprio implementador |
| M7I-UNIT | Contrato, projeção, adapter e cena LIVE | ALEGADO; I11 reprovou no QA e aguarda reteste após `5803223` | `5803223` | 54/401 raiz e 12/40 UI; regressão de mensagens inválidas repetidas em `qa/evidencias/M7-INTEGRATION/i06-i11-retest.md` |
| M7I-INT | Migration, journal, snapshot, REST/WS e segurança | ALEGADO; I06 reprovou no QA e aguarda reteste após `2e15b24` | `2e15b24` | 31/259 em PostgreSQL/Redis descartáveis, incluindo migration 0014 up/down; `qa/evidencias/M7-INTEGRATION/i06-i11-retest.md` |
| M7I-VISUAL | Fixture aprovada versus LIVE | PASSOU no aceite visual do owner para atualização sem F5; QA independente pendente | `102248e` + aceite owner 2026-09-23 | Personagem/Inspector AGUARDANDO, seleção preservada, Timeline `AGENT_STATE_CHANGED`; `qa/evidencias/M7-INTEGRATION/i16-owner-acceptance.md`. Pan/zoom não individualizados no relato. |
| M7I-MATRIX | Critérios I01–I18 | QA independente REPROVOU I06/I11; correções verdes só pelo implementador; I16 PASSOU no aceite visual do owner | `2e15b24`/`5803223` + aceite owner 2026-09-23 | Reteste do mesmo QA pendente; matriz em `docs/M7-INTEGRATION-HANDOFF.md`. |

## M7-INTEGRATION — rodada do implementador, 2026-09-23

`docs/M7-INTEGRATION-HANDOFF.md` contém a matriz I01–I18 com evidência e lacunas. Na rodada original, nenhum item técnico foi promovido a `PASSOU` pelo implementador. Depois, o QA independente reprovou I06/I11; as correções deste checkpoint não alteram esse veredito antes do reteste pelo mesmo QA. A migration 0014 foi validada com up/down somente em `office_m7_test` descartável; `.env` e secrets não foram lidos.

Suíte unitária raiz: 54 arquivos/399 testes no hook de `9163427`; UI: 12/39 nesta sessão. Integração completa final anterior: 31/257, incluindo migration 0014 up/down, replay, segurança, overflow, retry 40001, retenção concorrente e slow-client, após limpeza transacional da linha sintética e restauração dos containers descartáveis. Uma rodada intermediária falhou porque o valor de overflow deixado pelo teste não cabia no downgrade 0010; outra falhou com Docker desligado. Essas falhas não são ocultadas, e a rodada final verde é a referência. Typecheck, lint raiz/UI e build passaram nesta sessão; persistem avisos de Fast Refresh em contextos e de chunk Phaser 1.723,46 kB.

O navegador interno exibiu fixture sem erro novo após reload e permitiu selecionar os quatro Inspectors. Em LIVE, bloqueou o fetch loopback com `ERR_BLOCKED_BY_CLIENT`, apesar de GET direto/proxy HTTP 200 e contrato parseado. No Chrome do owner, o erro real foi `Failed to execute 'fetch' on 'Window': Illegal invocation`; um teste específico reproduziu a falha antes da correção e passou depois. Chrome isolado, sem extensões, passou a renderizar Office LIVE e a captura está em `qa/evidencias/M7-INTEGRATION/live-after-fetch-fix.png`. Essa captura é prova do implementador, não do aceite posterior do owner nem da revisão independente.

## I16 — aceite visual do owner, 2026-09-23

Após uma única transição controlada no banco descartável (`DESENVOLVEDOR-001`: `IDLE` → `WAITING`, com `AGENT_STATE_CHANGED`), a leitura do snapshot confirmou revisão 2, modo LIVE, estado `WAITING` e o evento na Timeline. O owner confirmou no próprio Chrome, **sem F5**, personagem e Inspector de OCIOSO para AGUARDANDO, seleção no mesmo agente, Office aberto em LIVE e Timeline com `AGENT_STATE_CHANGED` às 23:02. Registra-se **I16 PASSOU na validação visual do owner para esse fluxo**. O relato não individualizou pan/zoom nem os quatro Inspectors LIVE; não há print/console/rede do Chrome do owner anexados. Este aceite não promove I16 a PASSOU no QA independente. Detalhes e limites: `qa/evidencias/M7-INTEGRATION/i16-owner-acceptance.md`.

## I06/I11 — correções após reprovação independente, 2026-09-23

O QA independente encontrou (I06) mesmo cursor com snapshots diferentes e (I11) ciclo ilimitado após mensagens WS inválidas. Os testes novos falharam contra a implementação anterior e passaram após os commits `2e15b24` e `5803223`. Autorreteste: 54/401 unit raiz, 12/40 UI, 31/259 integração em `office_m7_test`/Redis descartáveis, typecheck, lint e build verdes. Estes resultados são **ALEGADO pelo implementador**; I06/I11 seguem **REPROVOU no último QA independente** até novo veredito externo. Prova e comandos: `qa/evidencias/M7-INTEGRATION/i06-i11-retest.md`.

## Fechamento documental — 2026-09-22

O dono aprovou a implementação visual final no commit `03e8b1f` para encerramento
do escopo M7-UI. A aprovação do dono não altera automaticamente os estados
`ALEGADO` abaixo: eles seguem assim porque as provas foram coletadas pelo
implementador e ainda não há aceite externo independente registrado.

Validação final: 49 arquivos/379 testes passaram; typecheck, lint e build UI
passaram. O build mantém o warning conhecido de chunk Phaser acima de 500 kB.
As evidências versionadas estão em `qa/evidencias/M7-REBUILD/` e
`qa/evidencias/M7-POLISH/`. `.env` continuou ignorado e fora do Git.

## Limitação do registro

### Polish final — 2026-09-22

Cenário anterior aprovado pelo dono. Acrescentadas somente seis placas,
luzes embutidas/sinalização no corredor e correção do texto vazio do Inspector.
Sprites existentes preservados: Caçador azul/headset, Diretor violeta/cabelo
claro, Desenvolvedor verde/cabelo escuro e Revisor dourado/cabelo castanho.

Os quatro agentes foram selecionados individualmente e os quatro Inspectors
inspecionados visualmente: identidade, estado, estação e tarefa corretos;
um único canvas preservado em todas as seleções. Capturas e console/rede em
`qa/evidencias/M7-POLISH/`. Console: zero erros/avisos.
Revisão do implementador: ALEGADO; aguarda aceite visual independente.

Checks desta rodada: suíte raiz 49 arquivos/379 testes, typecheck, lint e
build UI passaram. Persiste somente o aviso conhecido de tamanho do chunk Phaser.

O repositório não possui `scripts/qa-obsoletos.mjs`. A reconstrução possui provas
cruas em `qa/evidencias/M7-REBUILD/`, mas permanece `ALEGADO` por ter sido
verificada pelo próprio implementador. Uma passada independente ainda é
necessária para promover o resultado para `PASSOU`.

## Rodada técnica — 2026-09-21

- `pnpm run test:unit`: 49 arquivos, 378 testes — passou.
- `pnpm run typecheck`: passou.
- `pnpm run lint`: passou.
- `pnpm --filter ui run build`: passou; apenas aviso de chunk Phaser acima de
  500 kB.
- Painel local: carregou com conteúdo, canvas Phaser e sem overlay de erro.
- Renderer visual: piso, paredes, portas, corredores, mesas, cadeiras,
  computadores, plantas, estantes, café, racks, painel de operações e
  personagens pixelados originais.
- Movimento visual: agentes são posicionados na cadeira da workstation; rota de
  `PROBATION` continua visual e determinística.
- O `.env` permaneceu ignorado e fora do Git.

## Rodada de polimento visual — 2026-09-21

- `pnpm --filter ui run test:unit`: 9 arquivos, 27 testes — passou.
- `pnpm run test:unit`: 49 arquivos, 378 testes — passou.
- `pnpm run typecheck`: passou.
- `pnpm run lint`: passou.
- `pnpm --filter ui run build`: passou; permanece apenas o aviso não bloqueante do chunk Phaser.
- Composição: sem seleção, o mapa ocupa o protagonismo e o Inspector fica compacto; com seleção, o Inspector retorna como coluna dedicada.
- Prévia local: carregou conteúdo, Dashboard, canvas Phaser, Inspector compacto e Timeline; a prova visual continua `ALEGADO` por ser revisão do próprio implementador.
