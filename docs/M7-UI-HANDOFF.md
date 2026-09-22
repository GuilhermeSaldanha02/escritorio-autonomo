# M7-UI — Handoff para revisão

## Entrega anterior

- Branch: `feat/m7-office-ui`
- Commit: `6256ad9 feat(m7-ui): concluir painel fixture-driven`
- Base: `f468625` (`staging`/`main` com M6 integrado)
- Checkpoint anterior preservado: `baa54ca`

## Rodada visual final em andamento

O renderer Phaser foi elevado de um diagrama de salas para um escritório
top-down original: pisos, paredes espessas, corredores, portas, mobiliário,
plantas, estantes, café, racks, painel de operações e personagens pixelados
distintos por agente. A posição final dos agentes fica na cadeira da
workstation; `PROBATION` mantém uma rota visual de entrada.

## Verificações executadas

- `pnpm --filter ui run test:unit`: 8 arquivos, 25 testes.
- `pnpm run test:unit`: 48 arquivos, 376 testes.
- `pnpm run typecheck`.
- `pnpm run lint`.
- `pnpm --filter ui run build`.
- Gate visual local em `http://localhost:5173/`: conteúdo presente, canvas Phaser
  montado com escritório mobiliado e personagens pixelados, Dashboard/Timeline
  visíveis e nenhum overlay de erro.

## Limites preservados

Não foram adicionados backend, API, WebSocket, fonte viva, cursor/resync,
persistência, Agent Factory, novos eventos, migrations, ações financeiras ou
regras de Governor. A fixture é somente demonstrativa e a UI é read-only.

## Próxima revisão

Repetir a inspeção visual em contexto independente e anexar as provas cruas
exigidas pelo `QA.md` (`print.png`, `console.txt`, `rede.txt`) para promover os
itens de `ALEGADO` para `PASSOU`. Não fazer merge/rebase nesta branch sem nova
decisão de integração.
