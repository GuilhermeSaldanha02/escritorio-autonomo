-- O schema anterior não conhece PAUSED: as tentativas pausadas são descartadas
-- na reversão (não são fatos primários, e não há trigger append-only nestas tabelas).
DELETE FROM tool_calls WHERE status = 'PAUSED';
DELETE FROM model_calls WHERE status = 'PAUSED';
ALTER TABLE tool_calls DROP CONSTRAINT tool_calls_status_check;
ALTER TABLE tool_calls ADD CONSTRAINT tool_calls_status_check CHECK (status IN ('SUCCESS', 'ERROR', 'BLOCKED'));
ALTER TABLE model_calls DROP CONSTRAINT model_calls_status_check;
ALTER TABLE model_calls ADD CONSTRAINT model_calls_status_check CHECK (status IN ('SUCCESS', 'ERROR', 'BLOCKED'));

DROP TABLE paused_work;
DROP TABLE agent_lifecycle_transitions;
DROP TABLE circuit_breaker_events;
DROP TABLE scheduled_executions;
DROP TABLE emergency_stop_events;
