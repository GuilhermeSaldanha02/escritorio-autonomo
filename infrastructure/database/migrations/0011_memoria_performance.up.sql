-- 0011 — experiences, memories (pgvector de verdade) e agent_performance (M5).
--
-- As três tabelas são citadas na especificação (§12) desde o M1 como
-- "futuras por migrations" — nenhuma existia até aqui. embedding usa
-- vector(32), a dimensão de DeterministicEmbeddingProvider
-- (packages/memory/src/embedding-provider.ts); um EmbeddingProvider real
-- (Local/Api, fora do M5) com dimensão diferente precisa de uma migration
-- própria — a coluna não é genérica de propósito, para nunca misturar
-- espaços vetoriais de proveniências diferentes silenciosamente.
--
-- As três são append-only, mesmo padrão de events/financial_ledger/
-- payment_evidence: fato histórico não se edita, se corrige com uma linha
-- nova (uma Experience/Memory/AgentPerformanceAssessment errada vira
-- evidência para uma decisão, nunca desaparece nem é reescrita).

-- experiences: fato histórico determinístico (task+attempts+review+events+
-- model_calls+tool_calls → ExperienceBuilder, nunca IA). idempotency_key
-- garante que reentrega do BullMQ nunca duplica uma Experience (M5-PLANO.md:
-- "mesma disciplina de idempotência do M2/M3/M4").
CREATE TABLE experiences (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id             uuid NOT NULL REFERENCES tasks (id),
  agent_id            text NOT NULL REFERENCES agents (id),
  capability          text NOT NULL,
  outcome             text NOT NULL CHECK (outcome IN ('SUCCESS', 'FAILURE')),
  attempt_count       integer NOT NULL CHECK (attempt_count >= 1),
  review_result       text CHECK (review_result IN ('PASSED', 'FAILED')),
  duration_ms         integer NOT NULL CHECK (duration_ms >= 0),
  technical_cost_brl  numeric(14, 6) NOT NULL DEFAULT 0 CHECK (technical_cost_brl >= 0),
  failure_codes       text[] NOT NULL DEFAULT '{}',
  evidence_refs       text[] NOT NULL DEFAULT '{}',
  idempotency_key     text NOT NULL UNIQUE,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (outcome <> 'SUCCESS' OR review_result IS DISTINCT FROM 'FAILED')
);
CREATE INDEX experiences_agent_idx ON experiences (agent_id, created_at DESC);
CREATE TRIGGER experiences_append_only BEFORE UPDATE OR DELETE ON experiences
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

-- memories: conhecimento selecionado, nunca automático — só existe uma linha
-- aqui se um MemoryProposal passou pelo MemoryValidator com ACCEPTED
-- (M5-PLANO.md: "task COMPLETED nunca vira memória corporativa
-- automaticamente"). scope_agent_id/scope_capability NULL = escopo
-- corporativo (visível a toda a empresa); preenchido = escopo restrito, para
-- retrieval nunca vazar conhecimento de um agente/capability para outro
-- indevidamente.
CREATE TABLE memories (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experience_id          uuid NOT NULL REFERENCES experiences (id),
  content                text NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
  confidence             numeric(3, 2) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  source                 text NOT NULL,
  scope_agent_id         text REFERENCES agents (id),
  scope_capability       text,
  embedding              vector(32) NOT NULL,
  embedding_provider     text NOT NULL,
  embedding_model        text NOT NULL,
  embedding_version      text NOT NULL,
  embedding_dimensions   integer NOT NULL CHECK (embedding_dimensions > 0),
  created_at             timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX memories_experience_idx ON memories (experience_id);
CREATE INDEX memories_scope_idx ON memories (scope_agent_id, scope_capability);
-- ivfflat exige ANALYZE após ter linhas para o planner escolher o índice;
-- aceitável no volume do M5 (dado simulado, sem escala de produção).
CREATE INDEX memories_embedding_idx ON memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);
CREATE TRIGGER memories_append_only BEFORE UPDATE OR DELETE ON memories
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

-- agent_performance: M5 calcula (AgentPerformanceAssessment), nunca decide —
-- cada linha é uma avaliação histórica de uma janela específica; transformar
-- isso em transição de lifecycle real (PROBATION→ACTIVE etc.) é M6.
-- idempotency_key evita recalcular/duplicar a mesma janela.
CREATE TABLE agent_performance (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id               text NOT NULL REFERENCES agents (id),
  window_from            timestamptz NOT NULL,
  window_to              timestamptz NOT NULL,
  sample_size            integer NOT NULL CHECK (sample_size >= 0),
  tasks_completed        integer NOT NULL CHECK (tasks_completed >= 0),
  tasks_failed            integer NOT NULL CHECK (tasks_failed >= 0),
  success_rate            numeric(5, 4) NOT NULL CHECK (success_rate BETWEEN 0 AND 1),
  review_pass_rate        numeric(5, 4) CHECK (review_pass_rate BETWEEN 0 AND 1),
  retry_rate              numeric(5, 4) NOT NULL CHECK (retry_rate BETWEEN 0 AND 1),
  avg_duration_ms         numeric(14, 2) NOT NULL CHECK (avg_duration_ms >= 0),
  total_technical_cost_brl numeric(14, 6) NOT NULL CHECK (total_technical_cost_brl >= 0),
  recommended_action      text NOT NULL CHECK (recommended_action IN ('PROMOTE', 'KEEP', 'INVESTIGATE')),
  idempotency_key         text NOT NULL UNIQUE,
  calculated_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (window_to > window_from)
);
CREATE INDEX agent_performance_agent_idx ON agent_performance (agent_id, window_to DESC);
CREATE TRIGGER agent_performance_append_only BEFORE UPDATE OR DELETE ON agent_performance
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
