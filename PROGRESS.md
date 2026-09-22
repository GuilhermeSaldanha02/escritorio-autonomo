# Painel de acompanhamento — M7-INTEGRATION

## ESTADO ATUAL

- **Última sessão:** 2026-09-22 · agente: codex · branch: `codex/m7-integration`, worktree `C:/escritorio-autonomo-m7-integration`.
- **O que foi feito:** contrato/projeção pura `825e706`; migration 0014, head+journal+receipts `758c75d`; REST snapshot e stream WS read-only com replay, origin/host loopback, projector 1 s e lifecycle de API. M7-UI segue intacto.
- **Verificado:** suíte raiz `51 arquivos / 388 testes`; integração focada `3 arquivos / 11 testes` (commit tardio, concorrência, replay, segurança, retenção, up/down); typecheck, lint e build verdes; warning Phaser >500 kB conhecido. Banco `office_m7_test` e Redis próprios, sem volumes do owner.
- **Em andamento:** checkpoint da etapa 3; depois adapter, cena e matriz I01–I18. QA independente permanece ALEGADO.
- **Não commitado:** etapa 3 aguardando commit.
- **Bloqueado / a decidir:** nenhum pedido de ampliação de escopo. Banco/Redis de teste são containers próprios `codex-m7-pg-test` e `codex-m7-redis-test`, sem volumes do owner.
- **Próximo passo:** checkpoint da etapa 3, testes vermelhos do LiveOfficeDataSource, depois ligação mínima da UI. Sem merge ou M8.
- **Para o outro agente saber:** `/office/snapshot` serve head persistido; `/office/stream` usa replay/tail do journal, sem Pub/Sub. Fastify WS 11.3.1 registrado antes das rotas. `main.ts` inicia projector após montar API, com `onClose`; não executar main contra config do owner. Caçador/Diretor sem telemetria equivalente; UI ainda recria Game. `.env` não foi lido; integração somente no `office_m7_test`.

## PAINEL

| Marco | Estado | Check executável | Evidência / observação |
| --- | --- | --- | --- |
| R1 — Rebase sobre `staging` | CONCLUÍDO | `baa54ca`, base `f468625` |
| R2 — Workspace e lockfile | CONCLUÍDO | typecheck e lockfile reconciliado com pnpm 11.2.2 |
| R3 — Contrato e assets | CONCLUÍDO | docs M7, layout e paleta |
| R4 — Data source e fixture | CONCLUÍDO | 3 testes de fixture, sem rede |
| R5 — OfficeCanvas / Phaser | CONCLUÍDO | escritório top-down pixel-art, mobiliário, corredores e personagens |
| R6 — Dashboard, Inspector e Timeline | CONCLUÍDO | testes React e gate visual |
| R7 — Qualidade e handoff | CONCLUÍDO | `6110674`, regressão verde; revisão independente do QA ainda necessária |
