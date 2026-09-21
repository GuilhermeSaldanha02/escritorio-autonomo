import { useEffect, useMemo, useRef } from 'react';
import Phaser from 'phaser';

import layout from '../../../../../assets/office/layout.json';
import { useSelection } from '../context/SelectionContext';
import { useOfficeSnapshot } from '../hooks/useOfficeSnapshot';
import { createOfficeSceneModel, type OfficeLayout } from '../office/scene-model';
import { createOfficeScene } from '../util/OfficeSceneFactory';

export default function OfficeCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const snapshot = useOfficeSnapshot();
  const { selectedAgentId, setSelectedAgentId } = useSelection();
  const model = useMemo(
    () => snapshot === null ? null : createOfficeSceneModel({ layout: layout as OfficeLayout, snapshot }),
    [snapshot],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (container === null || model === null) return undefined;

    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: container,
      width: model.layout.grid.canvasWidth,
      height: model.layout.grid.canvasHeight,
      scene: createOfficeScene(model, setSelectedAgentId, selectedAgentId),
    });

    return () => game.destroy(true);
  }, [model, selectedAgentId, setSelectedAgentId]);

  return (
    <section className="office-canvas-shell" aria-label="Mapa 2D do escritório">
      <div className="office-canvas-toolbar">
        <span>Office 2D · zoom com a roda do mouse</span>
        <span>{model === null ? 'Sincronizando fixture' : `${model.agents.length} agentes · ${model.workstations.filter((workstation) => workstation.status === 'EMPTY').length} mesas vagas`}</span>
      </div>
      <div ref={containerRef} className="office-canvas" />
    </section>
  );
}
