# QA — M7-UI

## Mapa de áreas

| ID | Área | Estado | Commit de verificação | Evidência |
| --- | --- | --- | --- | --- |
| M7-UNIT | Data source, fixture, resolver, scene model e blueprint visual | ALEGADO | rodada 2026-09-21 | 49 arquivos / 378 testes; prova do próprio implementador |
| M7-BUILD | Typecheck, lint e build do UI | ALEGADO | rodada 2026-09-21 | todos passaram; aviso não bloqueante de chunk Phaser |
| M7-VISUAL | Dashboard, escritório top-down, personagens, Inspector/Timeline e segurança de texto | ALEGADO | rodada 2026-09-21 | painel atualizado em `localhost:5173`; prova do próprio implementador |

## Limitação do registro

O repositório ainda não possui `scripts/qa-obsoletos.mjs` nem evidências
cruas versionadas em `qa/evidencias/<ID>/`. Por isso os itens permanecem
`ALEGADO`; uma passada independente deve anexar `print.png`, `console.txt` e
`rede.txt` antes de promover qualquer item para `PASSOU`.

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
