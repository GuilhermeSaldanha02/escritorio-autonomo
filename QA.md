# QA — M7-UI

## Mapa de áreas

| ID | Área | Estado | Commit de verificação | Evidência |
| --- | --- | --- | --- | --- |
| M7-UNIT | Data source, fixture, resolver e scene model | ALEGADO | `11dc35f` + rodada 2026-09-21 | 47 arquivos / 374 testes; prova do próprio implementador |
| M7-BUILD | Typecheck, lint e build do UI | ALEGADO | `11dc35f` + rodada 2026-09-21 | todos passaram; aviso não bloqueante de chunk Phaser |
| M7-VISUAL | Dashboard, canvas, Inspector/Timeline e segurança de texto | ALEGADO | `11dc35f` + rodada 2026-09-21 | painel ativo em `localhost:5173`; prova do próprio implementador |

## Limitação do registro

O repositório ainda não possui `scripts/qa-obsoletos.mjs` nem evidências
cruas versionadas em `qa/evidencias/<ID>/`. Por isso os itens permanecem
`ALEGADO`; uma passada independente deve anexar `print.png`, `console.txt` e
`rede.txt` antes de promover qualquer item para `PASSOU`.

## Rodada técnica — 2026-09-21

- `pnpm run test:unit`: 47 arquivos, 374 testes — passou.
- `pnpm run typecheck`: passou.
- `pnpm run lint`: passou.
- `pnpm --filter ui run build`: passou; apenas aviso de chunk Phaser acima de
  500 kB.
- Painel local: carregou com conteúdo, canvas Phaser e sem overlay de erro.
- O `.env` permaneceu ignorado e fora do Git.
