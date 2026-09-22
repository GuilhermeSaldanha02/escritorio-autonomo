import { useEffect, useMemo, useRef } from 'react';
import Phaser from 'phaser';

import layout from '../../../../../assets/office/layout.json';
import { useSelection } from '../context/SelectionContext';
import { useOfficeSnapshot } from '../hooks/useOfficeSnapshot';
import {
  createOfficeSceneModel,
  type OfficeLayout,
} from '../office/scene-model';
import { createOfficeScene } from '../util/OfficeSceneFactory';

export default function OfficeCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const snapshot = useOfficeSnapshot();
  const { selectedAgentId, setSelectedAgentId } = useSelection();
  const model = useMemo(
    () =>
      snapshot === null
        ? null
        : createOfficeSceneModel({ layout: layout as OfficeLayout, snapshot }),
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
      pixelArt: true,
      roundPixels: true,
      scene: createOfficeScene(model, setSelectedAgentId, null),
    });
    gameRef.current = game;
    const resizeObserver = new ResizeObserver(() => game.scale.refresh());
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      gameRef.current = null;
      game.destroy(true);
    };
  }, [model, setSelectedAgentId]);

  useEffect(() => {
    gameRef.current?.scene
      .getScene('OfficeScene')
      ?.events.emit('select-agent', selectedAgentId);
  }, [selectedAgentId]);

  return (
    <section className="office-canvas-shell" aria-label="Mapa 2D do escritório">
      <div className="office-canvas-toolbar">
        <span>Office 2D · roda: zoom · arraste para explorar</span>
        <span>
          {model === null
            ? 'Sincronizando fixture'
            : `${model.agents.length} agentes · ${model.workstations.filter((workstation) => workstation.status === 'EMPTY').length} mesas vagas`}
        </span>
      </div>
      <div ref={containerRef} className="office-canvas" />
    </section>
  );
}
