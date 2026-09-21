import Phaser from 'phaser';

import palette from '../../../../../assets/office/palette.json';
import type { OfficeSceneModel, SceneAgent, SceneWorkstation } from '../office/scene-model';

export { createOfficeSceneModel } from '../office/scene-model';

function hexToNumber(hex: string): number {
  return Number.parseInt(hex.replace('#', ''), 16);
}

function drawFeature(scene: Phaser.Scene, feature: { id: string; position: { col: number; row: number } }, tileSize: number, color: number): void {
  const x = feature.position.col * tileSize;
  const y = feature.position.row * tileSize;
  const isRack = feature.id.includes('rack');
  const width = isRack ? tileSize * 2 : tileSize * 2.4;
  const height = isRack ? tileSize * 3 : tileSize * 1.5;

  scene.add.rectangle(x, y, width, height, hexToNumber(palette.colors.surface)).setOrigin(0).setStrokeStyle(1, color, 0.8);
  if (isRack) {
    for (let line = 0; line < 5; line += 1) {
      scene.add.rectangle(x + 5, y + 7 + line * 10, 5, 3, line % 2 === 0 ? hexToNumber(palette.categories.WORKING.color) : hexToNumber(palette.categories.SEARCHING.color)).setOrigin(0);
    }
  } else {
    scene.add.circle(x + 16, y + 8, 5, hexToNumber(palette.states.TESTING.color));
  }
}

function drawWorkstation(scene: Phaser.Scene, workstation: SceneWorkstation, selectedAgentId: string | null): void {
  const selected = workstation.assignedAgentId === selectedAgentId;
  const deskColor = workstation.status === 'EMPTY' ? hexToNumber(palette.colors.surfaceElevated) : hexToNumber(palette.colors.surface);
  const monitorColor = workstation.status === 'EMPTY' ? hexToNumber(palette.colors.textMuted) : hexToNumber(palette.categories.SEARCHING.color);

  scene.add.rectangle(workstation.x, workstation.y, 52, 30, deskColor).setOrigin(0).setStrokeStyle(selected ? 2 : 1, selected ? 0x67e8f9 : 0x64748b);
  scene.add.rectangle(workstation.x + 13, workstation.y + 4, 26, 10, hexToNumber(palette.colors.background)).setOrigin(0).setStrokeStyle(1, monitorColor);
  scene.add.rectangle(workstation.x + 15, workstation.y + 6, 22, 5, monitorColor, workstation.status === 'EMPTY' ? 0.25 : 0.9).setOrigin(0);
  scene.add.rectangle(workstation.x + 18, workstation.y + 31, 16, 6, hexToNumber(palette.colors.background)).setOrigin(0);

  if (workstation.status === 'EMPTY') {
    scene.add.text(workstation.x + 4, workstation.y + 18, 'VAGA', { fontFamily: 'monospace', fontSize: '7px', color: palette.colors.textSecondary });
  }
}

function drawAgent(scene: Phaser.Scene, agent: SceneAgent, onAgentSelect: (id: string) => void): void {
  const start = agent.route[0];
  const body = scene.add.rectangle(start.x, start.y, 14, 18, hexToNumber(agent.visual.color)).setOrigin(0.5).setStrokeStyle(1, 0xf8fafc);
  const head = scene.add.circle(start.x, start.y - 13, 7, hexToNumber(palette.colors.textPrimary)).setStrokeStyle(1, hexToNumber(agent.visual.color));
  const label = scene.add.text(start.x, start.y - 31, agent.visual.label, { fontFamily: 'monospace', fontSize: '7px', color: agent.visual.color }).setOrigin(0.5);
  const hitArea = scene.add.zone(start.x, start.y, 32, 40).setInteractive({ cursor: 'pointer' });
  hitArea.on('pointerdown', () => onAgentSelect(agent.id));

  const targets = agent.route.slice(1);
  if (targets.length > 0) {
    scene.tweens.add({ targets: [body, head, label, hitArea], x: targets[targets.length - 1].x, y: targets[targets.length - 1].y, duration: 1300, ease: 'Linear' });
  }
  if (agent.visual.animation === 'scan' || agent.visual.animation === 'type') {
    scene.tweens.add({ targets: body, alpha: { from: 0.6, to: 1 }, duration: 700, yoyo: true, repeat: -1 });
  }
  if (agent.visual.animation === 'alert') {
    scene.tweens.add({ targets: label, alpha: { from: 0.2, to: 1 }, duration: 400, yoyo: true, repeat: -1 });
  }
}

export function createOfficeScene(model: OfficeSceneModel, onAgentSelect: (id: string) => void, selectedAgentId: string | null): Phaser.Scene {
  return new (class OfficeScene extends Phaser.Scene {
    constructor() {
      super({ key: 'OfficeScene' });
    }

    create(): void {
      const { grid } = model.layout;
      this.cameras.main.setBackgroundColor(palette.colors.background);
      this.cameras.main.setBounds(0, 0, grid.canvasWidth, grid.canvasHeight);
      this.cameras.main.setZoom(0.95);

      for (let column = 0; column <= grid.columns; column += 1) {
        this.add.line(column * grid.tileSize, 0, 0, 0, 0, grid.rows * grid.tileSize, hexToNumber(palette.colors.surface), 0.45).setOrigin(0);
      }
      for (let row = 0; row <= grid.rows; row += 1) {
        this.add.line(0, row * grid.tileSize, 0, 0, grid.columns * grid.tileSize, 0, hexToNumber(palette.colors.surface), 0.45).setOrigin(0);
      }

      for (const room of model.rooms) {
        const { x, y, width, height } = room.bounds;
        const roomX = x * grid.tileSize;
        const roomY = y * grid.tileSize;
        const roomWidth = width * grid.tileSize;
        const roomHeight = height * grid.tileSize;
        const color = hexToNumber(room.themeColor);
        this.add.rectangle(roomX, roomY, roomWidth, roomHeight, hexToNumber(palette.colors.surface)).setOrigin(0).setStrokeStyle(2, color, 0.9);
        this.add.rectangle(roomX, roomY, roomWidth, 18, color, 0.16).setOrigin(0);
        this.add.text(roomX + 7, roomY + 5, room.name.toUpperCase(), { fontFamily: 'monospace', fontSize: '8px', color: room.themeColor });
        room.features?.forEach((feature) => drawFeature(this, feature, grid.tileSize, color));
      }

      model.workstations.forEach((workstation) => drawWorkstation(this, workstation, selectedAgentId));
      model.agents.forEach((agent) => drawAgent(this, agent, onAgentSelect));
      this.input.on('wheel', (_pointer: Phaser.Input.Pointer, _objects: unknown, _deltaX: number, deltaY: number) => {
        this.cameras.main.setZoom(Phaser.Math.Clamp(this.cameras.main.zoom - deltaY * 0.001, 0.72, 1.25));
      });
    }
  })();
}
