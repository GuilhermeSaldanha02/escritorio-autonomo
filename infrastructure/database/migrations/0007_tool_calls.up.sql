-- 0007 — tool_calls (M3, Tool Gateway): auditoria técnica de toda execução
-- de ferramenta, mesmo espírito de model_calls (0001) para chamadas de IA.
CREATE TABLE tool_calls (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id              text NOT NULL REFERENCES agents (id),
  task_id               uuid REFERENCES tasks (id),
  correlation_id        uuid,
  tool                  text NOT NULL,
  status                text NOT NULL CHECK (status IN ('SUCCESS', 'ERROR', 'BLOCKED')),
  cost_brl              numeric(14, 6) NOT NULL DEFAULT 0 CHECK (cost_brl >= 0),
  duration_ms           integer NOT NULL CHECK (duration_ms >= 0),
  error                 text,
  budget_reservation_id uuid REFERENCES budget_reservations (id),
  created_at            timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX tool_calls_agent_idx ON tool_calls (agent_id, created_at DESC);
