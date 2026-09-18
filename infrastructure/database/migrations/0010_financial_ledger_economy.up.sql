-- 0010 — Ledger real e PaymentEvidence (M5, Memória + Economia).
--
-- financial_ledger existe desde o M1 mas nenhum código nunca escreveu nela
-- (confirmado antes de tocar o schema). Por isso a migração retipa
-- amount_brl (numeric(14,2), ponto flutuante decimal) para amount_cents
-- (bigint, centavos inteiros) em vez de manter as duas representações lado a
-- lado — decisão normativa do M5-PLANO.md ("dinheiro nunca em ponto
-- flutuante"), sem risco de regressão porque a tabela está vazia e nenhum
-- código depende do tipo antigo.
--
-- entry_type ganha os três buckets do split determinístico (ajuste 1 da
-- revisão externa: RESERVE recebe sempre o resíduo do arredondamento) como
-- valores próprios, em vez de uma coluna "bucket" solta — mesmo padrão de
-- enum-por-CHECK já usado em todo o schema.
--
-- ledger_scope (ajuste 2 da revisão externa) isola lançamentos SIMULATION de
-- REAL desde a origem: NOT NULL, sem DEFAULT, para forçar toda inserção a
-- declarar explicitamente o escopo — nunca um valor implícito que poderia
-- vazar dinheiro de teste para uma leitura de caixa real.
ALTER TABLE financial_ledger
  DROP CONSTRAINT financial_ledger_amount_brl_check,
  DROP CONSTRAINT financial_ledger_entry_type_check,
  DROP CONSTRAINT financial_ledger_check;

ALTER TABLE financial_ledger
  ADD COLUMN amount_cents bigint,
  ADD COLUMN ledger_scope text;

UPDATE financial_ledger SET amount_cents = ROUND(amount_brl * 100)::bigint;

ALTER TABLE financial_ledger
  ALTER COLUMN amount_cents SET NOT NULL,
  ALTER COLUMN ledger_scope SET NOT NULL,
  DROP COLUMN amount_brl;

ALTER TABLE financial_ledger
  ADD CONSTRAINT financial_ledger_amount_cents_check CHECK (amount_cents > 0),
  ADD CONSTRAINT financial_ledger_ledger_scope_check CHECK (ledger_scope IN ('SIMULATION', 'REAL')),
  ADD CONSTRAINT financial_ledger_entry_type_check
    CHECK (entry_type IN ('REVENUE', 'OPERATING_COST', 'FOUNDER_SUBSIDY',
                           'RESERVE_ALLOCATION', 'OPERATIONS_ALLOCATION', 'EXPANSION_ALLOCATION')),
  ADD CONSTRAINT financial_ledger_check
    CHECK (entry_type NOT IN ('REVENUE', 'RESERVE_ALLOCATION', 'OPERATIONS_ALLOCATION', 'EXPANSION_ALLOCATION')
           OR (opportunity_id IS NOT NULL AND external_reference IS NOT NULL));

CREATE INDEX financial_ledger_scope_idx ON financial_ledger (ledger_scope, entry_type);

-- ---------------------------------------------------------------------------
-- payment_evidence: proveniência de uma confirmação de pagamento, separada
-- da decisão de contabilizar (M5-PLANO.md — nunca um markPaid() genérico).
-- No M5 só SIMULATED existe; EXTERNAL_VERIFIED é o caminho do M8, sem
-- precisar redesenhar o domínio.
CREATE TABLE payment_evidence (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id     uuid NOT NULL REFERENCES opportunities (id),
  provenance         text NOT NULL CHECK (provenance IN ('SIMULATED', 'EXTERNAL_VERIFIED')),
  amount_cents       bigint NOT NULL CHECK (amount_cents > 0),
  currency           char(3) NOT NULL,
  external_reference text NOT NULL,
  idempotency_key    text NOT NULL UNIQUE,
  confirmed_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX payment_evidence_opportunity_idx ON payment_evidence (opportunity_id);
CREATE TRIGGER payment_evidence_append_only BEFORE UPDATE OR DELETE ON payment_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
