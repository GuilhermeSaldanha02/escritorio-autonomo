// src/components/Inspector.tsx
import React from "react";
import { useOfficeDataSource } from "../context/OfficeDataContext";
import { useSelection } from "../context/SelectionContext";
import type { OfficeSnapshot, Agent } from "../data/types";

const Inspector: React.FC = () => {
  const dataSource = useOfficeDataSource();
  const { selectedAgentId } = useSelection();
  const [snapshot, setSnapshot] = React.useState<OfficeSnapshot | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    dataSource.getSnapshot().then((snap) => {
      if (!cancelled) setSnapshot(snap);
    });
    const unsub = dataSource.subscribe(() => {
      dataSource.getSnapshot().then((snap) => {
        if (!cancelled) setSnapshot(snap);
      });
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [dataSource]);

  if (!snapshot) return <div>Loading inspector...</div>;

  const agent: Agent | undefined = snapshot.agents.find((a) => a.id === selectedAgentId);

  if (!agent) {
    return <div>Select an agent to inspect.</div>;
  }

  return (
    <div className="inspector">
      <h2>Agent Inspector</h2>
      <p><strong>ID:</strong> {agent.id}</p>
      <p><strong>Name:</strong> {agent.name}</p>
      <p><strong>State:</strong> {agent.state}</p>
      <p><strong>Workstation:</strong> {agent.workstationId ?? "None"}</p>
    </div>
  );
};

export default Inspector;
