// src/components/Dashboard.tsx
import React from "react";
import { useOfficeDataSource } from "../context/OfficeDataContext";
import type { OfficeSnapshot } from "../data/types";

const Dashboard: React.FC = () => {
  const dataSource = useOfficeDataSource();
  const [snapshot, setSnapshot] = React.useState<OfficeSnapshot | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    dataSource.getSnapshot().then((snap) => {
      if (!cancelled) setSnapshot(snap);
    });
    const unsubscribe = dataSource.subscribe(() => {
      // Re‑fetch full snapshot on any event (demo source is static).
      dataSource.getSnapshot().then((snap) => {
        if (!cancelled) setSnapshot(snap);
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [dataSource]);

  if (!snapshot) return <div>Loading dashboard...</div>;

  const { metrics, autonomyEnabled, autoSpendEnabled, emergencyStop, circuitBreakerActive } = snapshot;

  return (
    <div className="dashboard">
      <h2>Metrics</h2>
      <table className="metrics-table">
        <tbody>
          <tr><td>Cash (Real)</td><td>{metrics.cashReal}</td></tr>
          <tr><td>Cash (Simulated)</td><td>{metrics.cashSimulated}</td></tr>
          <tr><td>Reserve (Real)</td><td>{metrics.reserveReal}</td></tr>
          <tr><td>Reserve (Simulated)</td><td>{metrics.reserveSimulated}</td></tr>
          <tr><td>Operations (Real)</td><td>{metrics.operationsReal}</td></tr>
          <tr><td>Operations (Simulated)</td><td>{metrics.operationsSimulated}</td></tr>
          <tr><td>Expansion (Real)</td><td>{metrics.expansionReal}</td></tr>
          <tr><td>Expansion (Simulated)</td><td>{metrics.expansionSimulated}</td></tr>
        </tbody>
      </table>
      <h3>Status Flags</h3>
      <ul className="flags-list">
        <li>Autonomy Enabled: {autonomyEnabled ? "YES" : "NO"}</li>
        <li>Auto‑Spend Enabled: {autoSpendEnabled ? "YES" : "NO"}</li>
        <li>Emergency Stop: {emergencyStop ? "ACTIVE" : "OFF"}</li>
        <li>Circuit Breaker: {circuitBreakerActive ? "ACTIVE" : "OFF"}</li>
      </ul>
    </div>
  );
};

export default Dashboard;
