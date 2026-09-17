-- 0003 — Suporte ao Orquestrador (M2 passo 5)
--
-- required_capabilities: capacidades que a EXECUÇÃO desta oportunidade
-- exigiria (ex.: TRADING, DIRECT_OUTREACH), se conhecidas. O contrato
-- OPPORTUNITY_FOUND (§13.1) não carrega esse dado; o Diretor/Governor
-- precisam dele para decidir e autorizar (packages/agents/src/director.ts).
-- Validado na aplicação contra o catálogo GOVERNED_CAPABILITY_NAMES — mesmo
-- padrão já usado em events.type, para não exigir migration a cada capacidade nova.
ALTER TABLE opportunities
  ADD COLUMN required_capabilities text[] NOT NULL DEFAULT '{}';
