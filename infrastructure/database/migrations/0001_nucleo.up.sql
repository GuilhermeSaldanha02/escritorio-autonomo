-- 0001 — Núcleo do Milestone 1 (especificação §12)
-- agents, opportunities, tasks, events, model_calls, financial_ledger
--
-- Tabelas futuras (task_attempts, reviews, submissions, memories, experiences,
-- budgets, strategies, agent_performance, tool_calls) entram por migrations novas.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- Prepara a memória vetorial (§8.7) sem serviço externo; nenhuma coluna vector no M1.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Registros de auditoria e dinheiro são append-only (§1, §9): a aplicação só insere.
CREATE OR REPLACE FUNCTION reject_append_only_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Tabela % é append-only: % não é permitido', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- agents: identidade persistente. O id (ex.: CACADOR-001) é independente do nome exibido.
CREATE TABLE agents (
  id               text PRIMARY KEY CHECK (id ~ '^[A-Z]+-[0-9]{3}$'),
  role             text NOT NULL CHECK (role IN ('CACADOR', 'DIRETOR', 'DESENVOLVEDOR', 'REVISOR')),
  display_name     text NOT NULL,
  responsibility   text NOT NULL,
  lifecycle_status text NOT NULL DEFAULT 'PROBATION'
                   CHECK (lifecycle_status IN ('PROBATION', 'ACTIVE', 'SLEEP', 'ARCHIVED')),
  state            text NOT NULL DEFAULT 'IDLE'
                   CHECK (state IN ('IDLE', 'SEARCHING', 'ANALYZING', 'THINKING', 'CODING', 'TESTING',
                                    'REVIEWING', 'WAITING', 'BLOCKED', 'SUCCESS', 'FAILED', 'SLEEP')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER agents_set_updated_at BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- opportunities: contrato OPPORTUNITY_FOUND (§13.1) + ciclo de estados (§11).
CREATE TABLE opportunities (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source             text NOT NULL,
  source_url         text NOT NULL,
  title              text NOT NULL,
  reward_amount      numeric(14, 2) CHECK (reward_amount >= 0),
  reward_currency    char(3),
  reward_verified    boolean NOT NULL DEFAULT false,
  requirements       jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(requirements) = 'array'),
  deadline           timestamptz,
  ai_allowed         boolean,
  automation_allowed boolean,
  payment_method     text,
  evidence           jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array'),
  confidence         numeric(4, 3) CHECK (confidence BETWEEN 0 AND 1),
  status             text NOT NULL DEFAULT 'DISCOVERED'
                     CHECK (status IN ('DISCOVERED', 'VERIFYING', 'VERIFIED', 'EVALUATING', 'APPROVED',
                                       'REJECTED', 'WORKING', 'SUBMITTED', 'ACCEPTED', 'PAYMENT_PENDING',
                                       'PAID', 'EXPIRED', 'INVALID', 'ABANDONED', 'FAILED')),
  discovered_by      text REFERENCES agents (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- Deduplicação: a mesma oportunidade na mesma fonte existe uma vez só.
  UNIQUE (source, source_url),
  CHECK ((reward_amount IS NULL) = (reward_currency IS NULL))
);
CREATE INDEX opportunities_status_idx ON opportunities (status);
CREATE TRIGGER opportunities_set_updated_at BEFORE UPDATE ON opportunities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- tasks: trabalho operacional e critérios (contrato DEVELOPER_TASK, §13.3).
CREATE TABLE tasks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id      uuid REFERENCES opportunities (id),
  assigned_agent_id   text REFERENCES agents (id),
  objective           text NOT NULL,
  acceptance_criteria jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(acceptance_criteria) = 'array'),
  allowed_tools       text[] NOT NULL DEFAULT '{}',
  status              text NOT NULL DEFAULT 'CREATED'
                      CHECK (status IN ('CREATED', 'ASSIGNED', 'IN_PROGRESS', 'IMPLEMENTATION_READY',
                                        'IN_REVIEW', 'COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED')),
  retry_count         integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  max_cost_brl        numeric(14, 2) NOT NULL DEFAULT 0 CHECK (max_cost_brl >= 0),
  max_runtime_minutes integer CHECK (max_runtime_minutes > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_status_idx ON tasks (status);
CREATE INDEX tasks_opportunity_idx ON tasks (opportunity_id);
CREATE TRIGGER tasks_set_updated_at BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- events: trilha de auditoria. O tipo é validado na aplicação (catálogo em
-- packages/events) para que eventos novos não exijam migration.
CREATE TABLE events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type            text NOT NULL CHECK (type ~ '^[A-Z][A-Z0-9_]*$'),
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  agent_id        text REFERENCES agents (id),
  task_id         uuid REFERENCES tasks (id),
  opportunity_id  uuid REFERENCES opportunities (id),
  correlation_id  uuid,
  -- Retry de job nunca duplica evento crítico (§20): mesma chave, mesmo evento.
  idempotency_key text UNIQUE,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_type_idx ON events (type, occurred_at DESC);
CREATE INDEX events_correlation_idx ON events (correlation_id) WHERE correlation_id IS NOT NULL;
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

-- ---------------------------------------------------------------------------
-- model_calls: uso e custo de IA (§8.4). No M1 só existe o modo mock.
CREATE TABLE model_calls (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      text NOT NULL REFERENCES agents (id),
  task_id       uuid REFERENCES tasks (id),
  mode          text NOT NULL CHECK (mode IN ('mock', 'local', 'api')),
  provider      text NOT NULL,
  model         text NOT NULL,
  input_tokens  integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_brl      numeric(14, 6) NOT NULL DEFAULT 0 CHECK (cost_brl >= 0),
  duration_ms   integer NOT NULL CHECK (duration_ms >= 0),
  status        text NOT NULL CHECK (status IN ('SUCCESS', 'ERROR', 'BLOCKED')),
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Chamada mock nunca tem custo.
  CHECK (mode <> 'mock' OR cost_brl = 0)
);
CREATE INDEX model_calls_agent_idx ON model_calls (agent_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- financial_ledger: movimentações; saldo é sempre derivado, nunca armazenado (§9).
CREATE TABLE financial_ledger (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_type         text NOT NULL
                     CHECK (entry_type IN ('REVENUE', 'OPERATING_COST', 'FOUNDER_SUBSIDY')),
  amount_brl         numeric(14, 2) NOT NULL CHECK (amount_brl > 0),
  description        text NOT NULL,
  opportunity_id     uuid REFERENCES opportunities (id),
  task_id            uuid REFERENCES tasks (id),
  model_call_id      uuid REFERENCES model_calls (id),
  -- Comprovante externo (ex.: id do pagamento na plataforma).
  external_reference text,
  idempotency_key    text NOT NULL UNIQUE,
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  -- Receita só existe com pagamento real confirmado e rastreável (§8.8).
  CHECK (entry_type <> 'REVENUE' OR (opportunity_id IS NOT NULL AND external_reference IS NOT NULL))
);
CREATE INDEX financial_ledger_type_idx ON financial_ledger (entry_type, recorded_at);
CREATE TRIGGER financial_ledger_append_only BEFORE UPDATE OR DELETE ON financial_ledger
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
