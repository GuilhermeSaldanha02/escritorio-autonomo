# M7 — Contrato do Office UI

## Escopo desta fatia

O M7-UI é uma projeção visual read-only do Escritório Autônomo. A tela usa a
fixture local como fonte demonstrativa e não implementa API, WebSocket,
projeção persistente, Agent Factory, novos eventos, migration ou regra de
governança.

## Fluxo obrigatório

```text
OFFICE_DEMO_FIXTURE
  -> FixtureOfficeDataSource
  -> OfficeDataSource
  -> OfficeDataProvider
  -> React
  -> OfficeCanvas
  -> Phaser
```

`main.tsx` é o composition root e injeta a fonte. Componentes React não
conhecem a implementação concreta da fixture.

## Dados e segurança

- A fixture contém os quatro fundadores, postos ocupados e postos `EMPTY`.
- Estados aceitos são `IDLE`, `SEARCHING`, `ANALYZING`, `THINKING`, `CODING`,
  `TESTING`, `REVIEWING`, `WAITING`, `BLOCKED`, `SUCCESS`, `FAILED`, `SLEEP`.
- Qualquer estado não reconhecido cai em `UNKNOWN` por meio do
  `VisualStateResolver`.
- Caixa `REAL` e caixa `SIMULATION` permanecem separadas.
- Autonomia, auto-spend, emergency stop e circuit breaker são sinais visuais;
  nenhuma ação financeira é executada pela UI.
- Eventos `UNTRUSTED_EXTERNAL` são renderizados como texto React, sem
  `innerHTML`.

## Limite para M7-INTEGRATION

A troca da fixture por uma fonte viva, resync/cursor, persistência,
telemetria operacional e ações de governança pertencem à etapa de integração
posterior.
