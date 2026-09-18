-- 0009 — Identidade em camadas e modelo de verificação do M4 (Caçador Real).
--
-- Decisão estrutural registrada em docs/M4-PLANO.md (§ decisão intermediária):
-- a tabela opportunities e o campo reward_verified já são o contrato testado
-- do M1-M3 (decide() do Diretor, mappers do Orquestrador, rota de simulação
-- da API) — nenhuma migração destrutiva, nenhuma coluna existente muda de
-- significado. Toda a modelagem nova do M4 entra em colunas adicionais
-- nullable; reward_verified continua escrito exatamente como antes pelos
-- caminhos legados (ex.: apps/api/src/routes/simulations.ts).
--
-- reward_status é a "verdade rica" do M4 (VERIFIED/PARTIALLY_VERIFIED/
-- UNVERIFIED/CONFLICTING) — nunca um substituto de reward_verified. Registros
-- históricos M1-M3/simulados recebem backfill determinístico nesta migração
-- (true -> VERIFIED, false -> UNVERIFIED); nunca inventamos PARTIALLY_VERIFIED
-- ou CONFLICTING para dados que nunca tiveram essa evidência. Novas linhas
-- criadas pelos caminhos legados (que não conhecem reward_status) ficam com
-- reward_status NULL — não é o mesmo que UNVERIFIED, é "não modelado pelo M4".
--
-- A derivação reward_verified = (reward_status = 'VERIFIED') para oportunidades
-- do M4 é responsabilidade do código de persistência do Caçador
-- (packages/cacador), centralizada numa função só — não um trigger de banco.
-- Um trigger BEFORE INSERT/UPDATE sobre esta tabela sobrescreveria também as
-- inserções legadas (simulations.ts nunca menciona reward_status, então
-- sempre cairia no DEFAULT e apagaria o reward_verified explícito que a
-- simulação depende para produzir EXECUTE no Diretor mock) — avaliado e
-- descartado por esse motivo.
ALTER TABLE opportunities
  ADD COLUMN reward_status text
    CHECK (reward_status IN ('VERIFIED', 'PARTIALLY_VERIFIED', 'UNVERIFIED', 'CONFLICTING')),
  ADD COLUMN reward_source text,
  ADD COLUMN payment_conditions text,
  ADD COLUMN eligibility_status text
    CHECK (eligibility_status IN ('ELIGIBLE', 'INELIGIBLE', 'UNKNOWN')),
  ADD COLUMN automation_policy_status text
    CHECK (automation_policy_status IN ('ALLOWED', 'DISALLOWED', 'UNKNOWN')),
  ADD COLUMN verified_at timestamptz,
  -- Identidade em camadas (Deduplicator, M4-PLANO.md): source+external_id é a
  -- identidade forte; canonical_url/target_identity/content_fingerprint são
  -- sinais auxiliares, nunca identidade única (título/URL mudam facilmente).
  ADD COLUMN external_id text,
  ADD COLUMN canonical_url text,
  ADD COLUMN target_identity text,
  ADD COLUMN content_fingerprint text,
  ADD COLUMN content_hash text,
  ADD COLUMN source_updated_at timestamptz,
  ADD COLUMN last_seen_at timestamptz,
  -- Conteúdo externo (regra central do M4): raw preservado para auditoria,
  -- normalized é o que o resto do pipeline lê — nunca um único campo.
  ADD COLUMN trust_level text CHECK (trust_level IN ('UNTRUSTED_EXTERNAL')),
  ADD COLUMN raw_external_content text,
  ADD COLUMN normalized_content text,
  ADD COLUMN raw_hash text;

UPDATE opportunities
   SET reward_status = CASE WHEN reward_verified THEN 'VERIFIED' ELSE 'UNVERIFIED' END
 WHERE reward_status IS NULL;

-- Identidade forte quando a fonte fornece um id estável: uma mesma fonte
-- nunca tem duas linhas para o mesmo external_id (critério 8 do M4 —
-- reprocessar a mesma oportunidade não cria duplicata). Parcial porque
-- external_id não existe para oportunidades legadas/simuladas.
CREATE UNIQUE INDEX opportunities_source_external_id_idx
  ON opportunities (source, external_id)
  WHERE external_id IS NOT NULL;
