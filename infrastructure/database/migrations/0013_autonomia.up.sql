-- 0013 — Autonomia (M6): Emergency Stop, Scheduler, Circuit Breaker, lifecycle e
-- trabalho pausado. Ver docs/M6-PLANO.md.
--
-- Estado que decide se o sistema pode agir (Emergency Stop, circuit breaker) é
-- sempre APPEND-ONLY e ordenado por `seq` (identity), nunca por occurred_at:
-- clock_timestamp() não segue a ordem de commit entre transações concorrentes,
-- e "a última linha vale" precisa de uma ordem total. O estado atual é derivado,
-- nunca uma coluna mutável (o erro que a 0010 quase teve).

-- Emergency Stop: só ENGAGED/RELEASED, só por ator humano (CLI ou API do
-- fundador). O CHECK de actor é uma segunda barreira, além do serviço único.
CREATE TABLE emergency_stop_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq         bigint GENERATED ALWAYS AS IDENTITY,
  kind        text NOT NULL CHECK (kind IN ('ENGAGED', 'RELEASED')),
  actor       text NOT NULL CHECK (actor IN ('FOUNDER_CLI', 'FOUNDER_API')),
  reason      text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX emergency_stop_events_seq_idx ON emergency_stop_events (seq);
CREATE TRIGGER emergency_stop_events_append_only BEFORE UPDATE OR DELETE ON emergency_stop_events
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

-- Scheduler: o Postgres é a autoridade da identidade lógica de uma execução
-- agendada (o BullMQ só transporta). UNIQUE(schedule_name, window_key) é o que
-- torna reentrega, dois schedulers e ticks concorrentes um único efeito.
-- Tick negado grava SKIPPED com o motivo, e isso não é falha.
CREATE TABLE scheduled_executions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_name text NOT NULL,
  window_key    text NOT NULL,
  status        text NOT NULL CHECK (status IN ('CLAIMED', 'DISPATCHED', 'SKIPPED', 'COMPLETED', 'FAILED')),
  skip_reason   text,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (schedule_name, window_key),
  CHECK (status <> 'SKIPPED' OR skip_reason IS NOT NULL)
);

-- Circuit breaker por escopo, append-only: o estado é a dobra dos eventos do
-- escopo. Só o escopo do evento é afetado por ele (SOURCE não para AGENT).
CREATE TABLE circuit_breaker_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq         bigint GENERATED ALWAYS AS IDENTITY,
  scope_type  text NOT NULL CHECK (scope_type IN ('SOURCE', 'AGENT')),
  scope_key   text NOT NULL,
  event_type  text NOT NULL CHECK (event_type IN ('FAILURE', 'SUCCESS', 'OPENED', 'HALF_OPEN', 'CLOSED')),
  reason      text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX circuit_breaker_events_seq_idx ON circuit_breaker_events (seq);
CREATE INDEX circuit_breaker_events_scope_idx ON circuit_breaker_events (scope_type, scope_key, seq);
CREATE TRIGGER circuit_breaker_events_append_only BEFORE UPDATE OR DELETE ON circuit_breaker_events
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

-- Histórico de lifecycle: o LifecycleService é o único que escreve em
-- agents.lifecycle_status, e cada transição deixa uma linha aqui (com a
-- evidência de AgentPerformance). O M6 não arquiva nem remove agente: o CHECK
-- impede ARCHIVED como origem ou destino (critério 20, no banco).
CREATE TABLE agent_lifecycle_transitions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq         bigint GENERATED ALWAYS AS IDENTITY,
  agent_id    text NOT NULL REFERENCES agents (id),
  from_status text NOT NULL CHECK (from_status IN ('PROBATION', 'ACTIVE', 'SLEEP')),
  to_status   text NOT NULL CHECK (to_status IN ('PROBATION', 'ACTIVE', 'SLEEP')),
  reason      text NOT NULL,
  evidence    jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array'),
  actor       text NOT NULL CHECK (actor IN ('LIFECYCLE_CONTROLLER', 'FOUNDER')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (from_status <> to_status)
);
CREATE INDEX agent_lifecycle_transitions_agent_idx ON agent_lifecycle_transitions (agent_id, seq DESC);
CREATE TRIGGER agent_lifecycle_transitions_append_only BEFORE UPDATE OR DELETE ON agent_lifecycle_transitions
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

-- Trabalho barrado por pausa: o job retorna normalmente (lançar consumiria uma
-- tentativa do BullMQ) e deixa uma linha idempotente aqui; o RELEASE re-despacha
-- estas linhas pelo outbox. resumed_at NULL = ainda pausado.
CREATE TABLE paused_work (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name       text NOT NULL,
  entity_id      uuid NOT NULL,
  correlation_id uuid,
  pause_reason   text NOT NULL,
  paused_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  resumed_at     timestamptz,
  UNIQUE (job_name, entity_id)
);
CREATE INDEX paused_work_pending_idx ON paused_work (paused_at) WHERE resumed_at IS NULL;

-- Pausa nunca vira falha, nem nos dados: uma tentativa barrada por Stop ou
-- circuito ganha um status próprio. Gravada como BLOCKED, a Experience
-- acusaria TOOL_CALL_BLOCKED e alimentaria o breaker do agente, fechando o
-- ciclo "circuito aberto, agente parado, performance piora, SLEEP".
ALTER TABLE tool_calls DROP CONSTRAINT tool_calls_status_check;
ALTER TABLE tool_calls ADD CONSTRAINT tool_calls_status_check CHECK (status IN ('SUCCESS', 'ERROR', 'BLOCKED', 'PAUSED'));
ALTER TABLE model_calls DROP CONSTRAINT model_calls_status_check;
ALTER TABLE model_calls ADD CONSTRAINT model_calls_status_check CHECK (status IN ('SUCCESS', 'ERROR', 'BLOCKED', 'PAUSED'));
