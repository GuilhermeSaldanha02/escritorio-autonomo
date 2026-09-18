-- 0005 — Reserva de orçamento (M3, revisão externa do fechamento do M2).
--
-- Critério 5 do M3 (a mais delicada): duas operações concorrentes não podem
-- individualmente passar no budget check e, juntas, ultrapassar o orçamento
-- por condição de corrida. Um `if (saldo >= custo)` em memória não resolve
-- isso — a leitura do saldo e a decisão de gastar precisam ser atômicas.
--
-- A tabela registra o ciclo de vida de cada reserva: RESERVED (estimativa
-- reservada antes da execução) -> SETTLED (custo real confirmado) ou
-- RELEASED (a chamada não ocorreu ou falhou, a reserva é devolvida). O
-- "já gasto" de uma finalidade (packages/governor SpendPurpose) é a soma de
-- RESERVED + SETTLED — nunca RELEASED. A atomicidade entre "ler o já gasto"
-- e "inserir a reserva" vem de packages/budget/src/ledger.ts, que serializa
-- por finalidade com pg_advisory_xact_lock dentro da mesma transação.
CREATE TABLE budget_reservations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose               text NOT NULL,
  status                text NOT NULL CHECK (status IN ('RESERVED', 'SETTLED', 'RELEASED')),
  estimated_amount_brl  numeric(14, 6) NOT NULL CHECK (estimated_amount_brl >= 0),
  actual_amount_brl     numeric(14, 6) CHECK (actual_amount_brl IS NULL OR actual_amount_brl >= 0),
  task_id               uuid REFERENCES tasks (id),
  correlation_id        uuid,
  idempotency_key       text NOT NULL UNIQUE,
  created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Custo real só existe quando a reserva foi de fato liquidada.
  CHECK (status = 'SETTLED' OR actual_amount_brl IS NULL)
);
CREATE INDEX budget_reservations_purpose_idx ON budget_reservations (purpose, status);
