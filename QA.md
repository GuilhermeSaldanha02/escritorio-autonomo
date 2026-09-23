# QA — M7-UI

## Mapa de áreas

| ID | Área | Estado | Commit de verificação | Evidência |
| --- | --- | --- | --- | --- |
| M7-UNIT | Data source, fixture, resolver, scene model e blueprint visual | ALEGADO | rodada 2026-09-22 | 49 arquivos / 379 testes; prova do próprio implementador |
| M7-BUILD | Typecheck, lint e build do UI | ALEGADO | rodada 2026-09-22 | todos passaram; aviso não bloqueante de chunk Phaser |
| M7-VISUAL | Cenário, personagens, Inspector/Timeline e segurança de texto | ALEGADO | rodada 2026-09-22 | `qa/evidencias/M7-REBUILD/`; prova do próprio implementador |
| M7I-UNIT | Contrato, projeção, adapter e cena LIVE | ALEGADO | `9163427` | 54/399 raiz e 12/39 UI; `qa/evidencias/M7-INTEGRATION/` |
| M7I-INT | Migration, journal, snapshot, REST/WS e segurança | ALEGADO | `b88ae59` | 31/257 completos no banco descartável; migration 0014 up/down |
| M7I-VISUAL | Fixture aprovada versus LIVE | PARCIAL | `9163427` | Quatro Inspectors fixture verificados; Chrome isolado mostra LIVE em `qa/evidencias/M7-INTEGRATION/live-after-fetch-fix.png`; owner ainda não validou atualização sem F5 |
| M7I-MATRIX | Critérios I01–I18 | ALEGADO técnico; I16 visual PARCIAL | `b88ae59` | Matriz e limite do navegador em `docs/M7-INTEGRATION-HANDOFF.md` |

## M7-INTEGRATION — rodada do implementador, 2026-09-23

`docs/M7-INTEGRATION-HANDOFF.md` contém a matriz I01–I18 com evidência e lacunas. Nenhum item foi promovido a `PASSOU`: a revisão independente ainda não ocorreu. A migration 0014 foi validada com up/down somente em `office_m7_test` descartável; `.env` e secrets não foram lidos.

Suíte unitária raiz: 54 arquivos/399 testes no hook de `9163427`; UI: 12/39 nesta sessão. Integração completa final anterior: 31/257, incluindo migration 0014 up/down, replay, segurança, overflow, retry 40001, retenção concorrente e slow-client, após limpeza transacional da linha sintética e restauração dos containers descartáveis. Uma rodada intermediária falhou porque o valor de overflow deixado pelo teste não cabia no downgrade 0010; outra falhou com Docker desligado. Essas falhas não são ocultadas, e a rodada final verde é a referência. Typecheck, lint raiz/UI e build passaram nesta sessão; persistem avisos de Fast Refresh em contextos e de chunk Phaser 1.723,46 kB.

O navegador interno exibiu fixture sem erro novo após reload e permitiu selecionar os quatro Inspectors. Em LIVE, bloqueou o fetch loopback com `ERR_BLOCKED_BY_CLIENT`, apesar de GET direto/proxy HTTP 200 e contrato parseado. No Chrome do owner, o erro real foi `Failed to execute 'fetch' on 'Window': Illegal invocation`; um teste específico reproduziu a falha antes da correção e passou depois. Chrome isolado, sem extensões, passou a renderizar Office LIVE e a captura está em `qa/evidencias/M7-INTEGRATION/live-after-fetch-fix.png`. Isto é prova do implementador; não promove I16 ou revisão independente a PASSOU.

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
