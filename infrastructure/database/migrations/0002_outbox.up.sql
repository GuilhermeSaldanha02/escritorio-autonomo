-- 0002 — Transactional Outbox (M2, revisão externa do M1)
--
-- O evento e o pedido de job são gravados na mesma transação. Um dispatcher
-- no Worker publica os pendentes no BullMQ. Se o Redis cair, nada se perde:
-- a linha fica pendente e é publicada quando ele voltar.
--
-- Tabela separada de `events` porque `events` é append-only e o outbox
-- precisa registrar tentativas e o momento da publicação.

CREATE TABLE outbox (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          uuid NOT NULL REFERENCES events (id),
  queue             text NOT NULL CHECK (queue ~ '^[a-z][a-z0-9-]*$'),
  job_name          text NOT NULL CHECK (job_name ~ '^[a-z][a-z0-9.-]*$'),
  -- Id do job no BullMQ. Republicar o mesmo job_id não cria job duplicado.
  job_id            text NOT NULL UNIQUE,
  payload           jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  -- Tentativas de execução do job no BullMQ (1 + MAX_TASK_RETRIES).
  job_attempts      integer NOT NULL CHECK (job_attempts >= 1),
  -- Tentativas de publicação pelo dispatcher.
  dispatch_attempts integer NOT NULL DEFAULT 0 CHECK (dispatch_attempts >= 0),
  available_at      timestamptz NOT NULL DEFAULT now(),
  dispatched_at     timestamptz,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outbox_pending_idx ON outbox (available_at) WHERE dispatched_at IS NULL;
CREATE INDEX outbox_event_idx ON outbox (event_id);
