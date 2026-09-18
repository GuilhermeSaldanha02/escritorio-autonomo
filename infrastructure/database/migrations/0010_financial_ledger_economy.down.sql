DROP TABLE payment_evidence;

ALTER TABLE financial_ledger
  DROP CONSTRAINT financial_ledger_amount_cents_check,
  DROP CONSTRAINT financial_ledger_ledger_scope_check,
  DROP CONSTRAINT financial_ledger_entry_type_check,
  DROP CONSTRAINT financial_ledger_check;

ALTER TABLE financial_ledger
  ADD COLUMN amount_brl numeric(14, 2);

ALTER TABLE financial_ledger DISABLE TRIGGER financial_ledger_append_only;
UPDATE financial_ledger SET amount_brl = (amount_cents::numeric / 100);
ALTER TABLE financial_ledger ENABLE TRIGGER financial_ledger_append_only;

ALTER TABLE financial_ledger
  ALTER COLUMN amount_brl SET NOT NULL,
  DROP COLUMN amount_cents,
  DROP COLUMN ledger_scope;

ALTER TABLE financial_ledger
  ADD CONSTRAINT financial_ledger_amount_brl_check CHECK (amount_brl > 0),
  ADD CONSTRAINT financial_ledger_entry_type_check
    CHECK (entry_type IN ('REVENUE', 'OPERATING_COST', 'FOUNDER_SUBSIDY')),
  ADD CONSTRAINT financial_ledger_check
    CHECK (entry_type <> 'REVENUE' OR (opportunity_id IS NOT NULL AND external_reference IS NOT NULL));
