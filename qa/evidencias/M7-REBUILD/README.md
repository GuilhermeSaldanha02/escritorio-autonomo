# Reconstrução visual M7 — 2026-09-22

Provas coletadas pelo implementador com Playwright em localhost:5173.
Resultado próprio: **ALEGADO**, aguardando revisão independente.

- `print.png`: cenário completo a 1440 px, sem labels de salas; ambientes reconhecíveis por materiais/mobiliário.
- `inspector.png`: Revisor selecionado; também foram clicados Caçador, Diretor e Desenvolvedor, verificando o Inspector e um único canvas após cada seleção.
- `mobile.png`: viewport 390×844; sem overflow horizontal (largura útil 375, canvas 341).
- `probation.png`: cópia da fixture com NOVO-001 em desk-pros-02, sentado em (186,146), monitor ligado após a rota.
- `zoom.png` / `pan.png`: roda e arraste no canvas; handler também verificado de 1 para 1.4, limite mínimo 1.
- `console.txt`: zero erros e zero avisos no carregamento final.
- `rede.txt`: recursos locais; nenhuma chamada ao backend ou API externa.

## Movimento e limites da prova

O teste de unidade percorre segmentos para os nove postos e verifica que os pés
do agente não cruzam mesas. As rotas usam portas/corredores da planta atual;
não se trata de pathfinding genérico para plantas arbitrárias.

PROBATION foi montado temporariamente no navegador com o mesmo renderer/model e
cópia do snapshot. A primeira execução sofreu throttling de requestAnimationFrame
na ferramenta e excedeu o timeout. A repetição usou forceSetTimeOut somente no
harness e chegou à cadeira com o monitor ligado. Nenhum ajuste de timer foi
imposto ao produto. O harness foi destruído e a página normal recarregada.

Texto externo `<img src=x onerror=alert(1)>` permaneceu literal: zero elementos
`img` dentro de `.untrusted-text`. Dashboard, data source, contratos e resolver
não foram alterados.

## Aceite visual do implementador

Sem nomes ou bordas de estado, o cenário continua reconhecível como escritório;
os personagens estão sentados diante das mesas; a composição apresenta um
ambiente de jogo top-down. Esta avaliação não substitui o aceite do dono.

Checks: UI 9 arquivos/28 testes; raiz 49 arquivos/379 testes; typecheck/lint/build
passaram. O aviso de tamanho do chunk Phaser permanece conhecido.
