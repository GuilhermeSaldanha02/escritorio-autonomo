-- 0006 — Auditoria completa de model_calls (M3, critério 9: agent_id,
-- task_id/correlation_id, decisão de autorização relacionada).
--
-- correlation_id liga a chamada ao mesmo fio da timeline dos eventos.
-- budget_reservation_id liga a chamada à reserva de orçamento (0005) que a
-- autorizou — a decisão do Governor fica rastreável sem duplicar a política
-- de orçamento numa segunda tabela.
ALTER TABLE model_calls
  ADD COLUMN correlation_id uuid,
  ADD COLUMN budget_reservation_id uuid REFERENCES budget_reservations (id);
