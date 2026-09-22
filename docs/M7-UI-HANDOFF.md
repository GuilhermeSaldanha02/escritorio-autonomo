# M7-UI — Handoff para revisão

## Entrega

Polish após aprovação do cenário: seis placas pixel-art de salas, iluminação e
sinalização discretas nos corredores, texto vazio do Inspector corrigido para
"Selecione um agente no escritório para visualizar seu estado.". Quatro
personagens preservados e quatro Inspectors validados. Screenshots finais em
`qa/evidencias/M7-POLISH/`. Nenhuma reconstrução adicional ou mudança de lógica.

- Branch: `feat/m7-office-ui`
- Commit: `6256ad9 feat(m7-ui): concluir painel fixture-driven`
- Base: `f468625` (`staging`/`main` com M6 integrado)
- Checkpoint anterior preservado: `baa54ca`
- Commit visual atual: `6110674 feat(m7-ui): transformar office em pixel art operacional`
- Checkpoint de polimento: `960db6e feat(m7-ui): polir protagonista visual do office`.
- Commit final de polish aprovado: `03e8b1f feat(m7-ui): Finalize placas e detalhes do escritório`.

## Reconstrução visual — 2026-09-22

O desenho anterior foi substituído por texturas pixel-art originais construídas
em canvas: paredes com espessura, portas, pisos, móveis com profundidade e
personagens humanos orientados para os monitores. Não há dependência de assets
de terceiros nem de nomes/contornos coloridos para reconhecer as salas.

Movimento agora percorre cada waypoint com o personagem inteiro. O monitor da
mesa de destino liga ao fim da entrada PROBATION. A seleção atualiza a cena sem
recriar o jogo e o ResizeObserver mantém as coordenadas dos cliques corretas.
O canvas não impõe mais altura mínima que criava uma área vazia abaixo da planta.

Provas: `qa/evidencias/M7-REBUILD/`. A autoria da revisão é do implementador,
portanto o aceite independente segue pendente, sem alegação de QA externo.

## Histórico da primeira rodada visual

O renderer Phaser foi elevado de um diagrama de salas para um escritório
top-down original: pisos, paredes espessas, corredores, portas, mobiliário,
plantas, estantes, café, racks, painel de operações e personagens pixelados
distintos por agente. A posição final dos agentes fica na cadeira da
workstation; `PROBATION` mantém uma rota visual de entrada.

## Verificações executadas

- `pnpm --filter ui run test:unit`: 9 arquivos, 28 testes.
- `pnpm run test:unit`: 49 arquivos, 379 testes.
- `pnpm run typecheck`.
- `pnpm run lint`.
- `pnpm --filter ui run build`.
- Gate visual local em `http://localhost:5173/`: conteúdo presente, canvas Phaser
  montado com escritório mobiliado e personagens pixelados, Dashboard/Timeline
  visíveis e nenhum overlay de erro.
- Composição final: o Office ocupa a largura disponível quando nenhum agente está
  selecionado; o Inspector só reserva uma coluna dedicada durante a inspeção.

## Limites preservados

Não foram adicionados backend, API, WebSocket, fonte viva, cursor/resync,
persistência, Agent Factory, novos eventos, migrations, ações financeiras ou
regras de Governor. A fixture é somente demonstrativa e a UI é read-only.

## Fechamento

O dono aprovou o M7-UI no commit `03e8b1f`. A branch está pronta para
planejamento de integração separado. Não iniciar M7-INTEGRATION nesta etapa.
Os estados de QA permanecem `ALEGADO` quando dependem de aceite externo ainda
não registrado. O warning conhecido do build é o chunk Phaser acima de 500 kB.

## Próxima revisão

Repetir a inspeção visual em contexto independente e anexar as provas cruas
exigidas pelo `QA.md` (`print.png`, `console.txt`, `rede.txt`) para promover os
itens de `ALEGADO` para `PASSOU`. Não fazer merge/rebase nesta branch sem nova
decisão de integração.
