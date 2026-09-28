import { useOfficeSnapshot } from '../hooks/useOfficeSnapshot';

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
}

function circuitBreakerLabel(status: 'CLOSED' | 'OPEN' | 'HALF_OPEN' | 'PLANNED'): string {
  const labels = {
    CLOSED: 'Circuit Breaker fechado',
    OPEN: 'Circuit Breaker aberto',
    HALF_OPEN: 'Circuit Breaker em teste',
    PLANNED: 'Circuit Breaker planejado',
  } as const;
  return labels[status];
}

export default function Dashboard() {
  const snapshot = useOfficeSnapshot();
  if (snapshot === null) return <p className="office-loading">Carregando painel do Office…</p>;

  const { financial, governance } = snapshot;
  return (
    <section className="office-dashboard" aria-label="Painel de métricas e governança">
      <div className="office-dashboard-heading">
        <div>
          <p className="eyebrow">{snapshot.mode === 'LIVE' ? 'Modo LIVE' : 'Modo demonstração'}</p>
          <h2>Visão operacional</h2>
        </div>
        <span className="demo-badge">{snapshot.mode === 'LIVE' ? snapshot.metadata.connection : 'FIXTURE LOCAL'}</span>
      </div>
      <div className="financial-grid">
        <article className="metric-card metric-card-real">
          <span>Caixa REAL</span>
          <strong>{financial.real === null ? 'Indisponível' : formatCurrency(financial.real.cashCents)}</strong>
          <small>Alocação acumulada de reserva: {financial.real === null ? 'indisponível' : formatCurrency(financial.real.reserveCents)}</small>
        </article>
        <article className="metric-card metric-card-simulation">
          <span>Caixa SIMULATION</span>
          <strong>{financial.simulation === null ? 'Indisponível' : formatCurrency(financial.simulation.cashCents)}</strong>
          <small>Alocação acumulada de reserva: {financial.simulation === null ? 'indisponível' : formatCurrency(financial.simulation.reserveCents)}</small>
        </article>
      </div>
      <div className="governance-row" aria-label="Sinais de governança">
        <span className={governance.autonomyEnabled ? 'status-chip is-on' : 'status-chip'}>{governance.autonomyEnabled === null ? 'Configuração de autonomia indisponível' : governance.autonomyEnabled ? 'Autonomia configurada ativa' : 'Autonomia configurada desativada'}</span>
        <span className={governance.autoSpendEnabled ? 'status-chip is-on' : 'status-chip'}>{governance.autoSpendEnabled === null ? 'Auto-spend indisponível' : governance.autoSpendEnabled ? 'Auto-spend configurado ativo' : 'Auto-spend configurado desativado'}</span>
        <span className={governance.emergencyStop ? 'status-chip is-stop' : 'status-chip'}>{governance.emergencyStop === null ? 'Emergency Stop indisponível' : governance.emergencyStop ? 'Emergency Stop ativo' : 'Emergency Stop inativo'}</span>
        <span className={governance.circuitBreaker === 'OPEN' ? 'status-chip is-stop' : 'status-chip'}>{governance.circuitBreaker === null ? 'Circuit Breaker indisponível' : circuitBreakerLabel(governance.circuitBreaker)}</span>
      </div>
    </section>
  );
}
