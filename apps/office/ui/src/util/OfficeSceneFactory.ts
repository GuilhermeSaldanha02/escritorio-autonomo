// src/util/OfficeSceneFactory.ts
import { visualStateResolver } from "./VisualStateResolver";

/**
 * Factory that creates a Phaser.Scene configured for the Office UI.
 * It renders the office layout (rooms, workstations) and agents.
 * Selection of an agent is communicated back via the provided callback.
 */
export const createOfficeScene = (
  snapshot: OfficeSnapshot,
  onAgentSelect: (id: string) => void
): Phaser.Scene => {
  class OfficeScene extends Phaser.Scene {
    private agentsMap: Map<string, Phaser.GameObjects.Sprite> = new Map();
    private workstations: Workstation[] = [];

    constructor() {
      super({ key: "OfficeScene" });
    }

    preload() {
      // Load layout and palette – they are JSON files that define the grid.
      this.load.json("layout", "/assets/office/layout.json");
      this.load.json("palette", "/assets/office/palette.json");
      // Load a generic sprite sheet for agents. Assume 13 frames (12 states + UNKNOWN).
      // The actual image asset should be placed at assets/office/ui/agents.png.
      this.load.spritesheet("agents", "/assets/office/ui/agents.png", {
        frameWidth: 32,
        frameHeight: 32,
      });
    }

    create() {
      const layout = this.cache.json.get("layout") as any;
      const palette = this.cache.json.get("palette") as any;
      // Simple rendering of rooms – just fill rectangles based on layout data.
      // This is a placeholder; a real implementation would iterate over layout.tiles.
      this.add.rectangle(400, 300, 800, 600, 0x2a2a2a).setStrokeStyle(2, 0xffffff);

      // Store workstations for later reference (e.g., pathfinding).
      this.workstations = snapshot.workstations;

      // Create agent sprites.
      snapshot.agents.forEach((agent) => {
        const sprite = this.add.sprite(0, 0, "agents");
        // Position based on the workstation if assigned, else random.
        const ws = this.workstations.find((w) => w.id === agent.workstationId);
        if (ws) {
          sprite.setPosition(ws.x, ws.y);
        } else {
          // Random placement within canvas bounds for unassigned agents.
          const x = Phaser.Math.Between(50, 750);
          const y = Phaser.Math.Between(50, 550);
          sprite.setPosition(x, y);
        }
        // Set frame according to visual state.
        const frame = visualStateResolver(agent.state);
        sprite.setFrame(frame);
        // Enable interaction.
        sprite.setInteractive({ useHandCursor: true }).on("pointerdown", () => {
          onAgentSelect(agent.id);
        });
        this.agentsMap.set(agent.id, sprite);
      });
    }

    update(time: number, delta: number) {
      // Placeholder: could animate agents or handle visual path‑finding.
      // No domain state changes – purely visual.
    }
  }

  return new OfficeScene();
};
