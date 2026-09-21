import type { CSSProperties } from 'react';

import { useSelection } from '../context/SelectionContext';
import { useOfficeSnapshot } from '../hooks/useOfficeSnapshot';
import { visualStateResolver } from '../util/VisualStateResolver';

export default function Inspector() {
  const snapshot = useOfficeSnapshot();
  const { selectedAgentId } = useSelection();
  if (snapshot === null) return <p className="office-loading">Carregando detalhes…</p>;

  const agent = snapshot.agents.find((candidate) => candidate.id === selectedAgentId);
  if (agent === undefined) {
    return <aside className="office-inspector empty-inspector"><p>Selecione um agente no mapa para inspecionar seu estado.</p></aside>;
  }

  const visual = visualStateResolver(agent.state);
  return (
    <aside className="office-inspector" aria-label={`Detalhes de ${agent.id}`}>
      <p className="eyebrow">Painel do agente</p>
      <h2>{agent.id}</h2>
      <p className="agent-name">{agent.displayName}</p>
      <dl>
        <div><dt>Papel</dt><dd>{agent.role}</dd></div>
        <div><dt>Lifecycle</dt><dd>{agent.lifecycleStatus}</dd></div>
        <div><dt>Estado</dt><dd className="state-value" style={{ '--state-color': visual.color } as CSSProperties}>{visual.label}</dd></div>
        <div><dt>Estação</dt><dd>{agent.workstationId ?? 'Sem estação atribuída'}</dd></div>
      </dl>
      <section className="agent-task" aria-label="Tarefa atual">
        <h3>Tarefa atual</h3>
        {agent.currentTask === null ? <p>Nenhuma tarefa ativa.</p> : <>
          <p>{agent.currentTask.objective}</p>
          <small>{agent.currentTask.status} · tentativas: {agent.currentTask.retryCount}</small>
        </>}
      </section>
    </aside>
  );
}
