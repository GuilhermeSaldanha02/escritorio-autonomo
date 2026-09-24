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

## Reconciliação M7-INTEGRATION (contrato 2.0.0)

O contrato 1.0.0 descrito na preparação histórica não foi implementado e não
é compatível com o Office visual. O pacote browser-safe
`packages/office-contract` formaliza a forma camelCase já usada pela UI,
sem transportar payloads do domínio. `OfficeSnapshot` admite `DEMO` e `LIVE`;
datas sem evidência são `null`, campos financeiros e governança indisponíveis
também são `null`, e a metadata distingue qualidade e conexão. A fixture
permanece DEMO; ela não é fallback silencioso para LIVE.

O transporte LIVE usa envelope `{contractVersion, streamCursor, revision,
snapshot}` com revisão decimal exata e cursor opaco `v2.<epoch>.<revision>`.
`OFFICE_UPDATED` substitui seções completas e exige `baseCursor` consecutivo;
`SUBSCRIBE`, `SYNC_START`, `SYNC_COMPLETE`, `FULL_RESYNC_REQUIRED` e
`HEARTBEAT` são mensagens de rede, distintas do `OfficeEvent` local de
invalidação. A estratégia operacional de journal/replay e seus limites estão
em `docs/M7-INTEGRATION-PLAN.md`.

Um cursor identifica **um único snapshot integral**. Tick sem alteração nas
seções do domínio conserva o snapshot persistido, inclusive `generatedAt` e
`metadata.observedAt`; só o `observed_at` do head avança para o heartbeat de
frescor. Quando há revisão, o `OFFICE_UPDATED` leva também `generatedAt` e
`metadata`, além das seções alteradas, para que o replacement reconstrua o
mesmo snapshot do REST. Datas sozinhas não criam revisão.

Mensagem WS desconhecida/malformada força resync sem avançar o cursor. Se
repetida, o `LiveOfficeDataSource` usa espera progressiva (1 s, depois 2 s)
e, na terceira ocorrência consecutiva sem intervalo superior a 60 s nem
update válido, para de reconectar e marca a conexão `DISCONNECTED`. Uma
atualização válida zera a contagem; não há fallback para DEMO.

No LIVE inicial, nomes/responsabilidades dos quatro fundadores vêm somente
de metadata pública por ID, objetivos de tarefa são templates locais e a
timeline é uma allowlist de tipos/IDs/datas. Texto externo livre e payloads
não entram no DTO. Nenhum dado LIVE é prova de liveness do Worker.
