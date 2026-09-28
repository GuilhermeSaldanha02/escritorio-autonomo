-- M7: somente projeção sanitizada. Não altera tabelas M1-M6.
CREATE TABLE office_projection_head (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  epoch uuid NOT NULL DEFAULT gen_random_uuid(),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  snapshot jsonb,
  observed_at timestamptz,
  min_replay_revision bigint NOT NULL DEFAULT 0 CHECK (min_replay_revision >= 0),
  contract_version text NOT NULL DEFAULT '2.0.0'
);
INSERT INTO office_projection_head (singleton) VALUES (true);

CREATE TABLE office_stream_entries (
  epoch uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  base_revision bigint NOT NULL CHECK (base_revision >= 0),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (epoch, revision),
  CHECK (revision = base_revision + 1)
);
CREATE INDEX office_stream_entries_created_idx ON office_stream_entries (created_at);

CREATE TABLE office_event_receipts (
  source_event_id uuid PRIMARY KEY,
  considered_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
