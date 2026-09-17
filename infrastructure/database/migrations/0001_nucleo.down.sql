-- Reverte 0001. As extensões ficam: podem ser compartilhadas e removê-las exige superusuário.
DROP TABLE IF EXISTS financial_ledger;
DROP TABLE IF EXISTS model_calls;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS opportunities;
DROP TABLE IF EXISTS agents;
DROP FUNCTION IF EXISTS reject_append_only_change();
DROP FUNCTION IF EXISTS set_updated_at();
