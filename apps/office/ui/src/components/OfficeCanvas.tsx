// src/components/OfficeCanvas.tsx
import React, { useEffect, useRef } from "react";
import Phaser from "phaser";
import { useOfficeDataSource } from "../context/OfficeDataContext";
import { useSelection } from "../context/SelectionContext";
import type { OfficeSnapshot, Agent } from "../data/types";
import { createOfficeScene } from "../util/OfficeSceneFactory";

const OfficeCanvas: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const dataSource = useOfficeDataSource();
  const { setSelectedAgentId } = useSelection();

  useEffect(() => {
    let cancelled = false;
    let game: Phaser.Game | null = null;

    dataSource.getSnapshot().then((snapshot) => {
      if (cancelled) return;
      const scene = createOfficeScene(snapshot, setSelectedAgentId);
      const config: Phaser.Types.Core.GameConfig = {
        type: Phaser.AUTO,
        parent: containerRef.current as HTMLDivElement,
        width: 800,
        height: 600,
        scene,
        backgroundColor: "#1d1d1d",
      };
      game = new Phaser.Game(config);
    });

    return () => {
      cancelled = true;
      if (game) {
        game.destroy(true);
      }
    };
  }, [dataSource, setSelectedAgentId]);

  return <div ref={containerRef} className="office-canvas" />;
};

export default OfficeCanvas;
