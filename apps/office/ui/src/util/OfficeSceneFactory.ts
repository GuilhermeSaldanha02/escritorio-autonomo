import Phaser from 'phaser';

import palette from '../../../../../assets/office/palette.json';
import { getAgentVisualProfile, getRoomVisualBlueprint, type RoomDecor } from '../office/visual-blueprint';
import type { OfficeSceneModel, SceneAgent, SceneWorkstation } from '../office/scene-model';

export { createOfficeSceneModel } from '../office/scene-model';

type SceneRoom = OfficeSceneModel['rooms'][number];

function hexToNumber(hex: string): number {
  return Number.parseInt(hex.replace('#', ''), 16);
}

function accentColor(accent: 'cyan' | 'violet' | 'teal' | 'green' | 'gold' | 'slate'): number {
  const colors = {
    cyan: palette.categories.SEARCHING.color,
    violet: palette.categories.ANALYZING.color,
    teal: palette.states.TESTING.color,
    green: palette.categories.WORKING.color,
    gold: palette.categories.WAITING.color,
    slate: palette.colors.border,
  };
  return hexToNumber(colors[accent]);
}

function drawFloor(scene: Phaser.Scene, room: SceneRoom, tileSize: number, pattern: 'tile' | 'wood' | 'technical'): void {
  const { x, y, width, height } = room.bounds;
  const px = x * tileSize;
  const py = y * tileSize;
  const pw = width * tileSize;
  const ph = height * tileSize;
  const floorColor = pattern === 'wood' ? palette.colors.surfaceElevated : palette.colors.surface;
  scene.add.rectangle(px, py, pw, ph, hexToNumber(floorColor)).setOrigin(0).setDepth(0);

  const step = pattern === 'wood' ? tileSize * 2 : tileSize;
  for (let row = 0; row < ph; row += step) {
    for (let column = 0; column < pw; column += step) {
      const shade = (row / step + column / step) % 2 === 0 ? 0.08 : 0.03;
      scene.add.rectangle(px + column, py + row, step - 1, step - 1, hexToNumber(palette.colors.background), shade).setOrigin(0).setDepth(1);
    }
  }
  if (pattern === 'technical') {
    for (let row = 0; row <= ph; row += tileSize) {
      scene.add.line(px, py + row, 0, 0, pw, 0, hexToNumber(palette.colors.border), 0.22).setOrigin(0).setDepth(2);
    }
  }
}

function drawWalls(scene: Phaser.Scene, room: SceneRoom, tileSize: number, color: number): void {
  const { x, y, width, height } = room.bounds;
  const px = x * tileSize;
  const py = y * tileSize;
  const pw = width * tileSize;
  const ph = height * tileSize;
  scene.add.rectangle(px, py, pw, ph, 0, 0).setOrigin(0).setStrokeStyle(3, color, 0.9).setDepth(3);
  scene.add.line(px, py + 18, 0, 0, pw, 0, color, 0.25).setOrigin(0).setDepth(3);
  scene.add.rectangle(px + 6, py + 6, pw - 12, 3, color, 0.22).setOrigin(0).setDepth(3);
}

function drawDoor(scene: Phaser.Scene, x: number, y: number, width: number, color: number): void {
  scene.add.rectangle(x, y, width, 5, hexToNumber(palette.colors.background)).setOrigin(0.5).setDepth(4);
  scene.add.rectangle(x, y, width - 8, 2, color, 0.75).setOrigin(0.5).setDepth(4);
}

function drawPlant(scene: Phaser.Scene, x: number, y: number, scale = 1): void {
  const green = hexToNumber(palette.categories.WORKING.color);
  scene.add.rectangle(x, y + 12 * scale, 12 * scale, 8 * scale, hexToNumber(palette.colors.surfaceElevated)).setOrigin(0.5).setDepth(8);
  scene.add.rectangle(x, y + 6 * scale, 4 * scale, 10 * scale, green).setOrigin(0.5).setDepth(9);
  scene.add.rectangle(x - 5 * scale, y + 2 * scale, 5 * scale, 10 * scale, green, 0.85).setOrigin(0.5).setDepth(9);
  scene.add.rectangle(x + 5 * scale, y + 1 * scale, 5 * scale, 11 * scale, hexToNumber(palette.categories.SEARCHING.color), 0.75).setOrigin(0.5).setDepth(9);
}

function drawBookshelf(scene: Phaser.Scene, x: number, y: number): void {
  scene.add.rectangle(x, y, 34, 48, hexToNumber(palette.colors.background)).setOrigin(0).setStrokeStyle(1, hexToNumber(palette.colors.border)).setDepth(7);
  for (let row = 0; row < 3; row += 1) {
    scene.add.rectangle(x + 4, y + 8 + row * 13, 26, 2, hexToNumber(palette.colors.border)).setOrigin(0).setDepth(8);
    for (let book = 0; book < 5; book += 1) {
      scene.add.rectangle(x + 5 + book * 5, y + 3 + row * 13, 3, 7, book % 2 === 0 ? hexToNumber(palette.categories.ANALYZING.color) : hexToNumber(palette.categories.SEARCHING.color)).setOrigin(0).setDepth(8);
    }
  }
}

function drawWhiteboard(scene: Phaser.Scene, x: number, y: number, color: number): void {
  scene.add.rectangle(x, y, 56, 24, hexToNumber(palette.colors.surfaceElevated)).setOrigin(0).setStrokeStyle(2, color, 0.75).setDepth(7);
  scene.add.line(x + 8, y + 8, 0, 0, 34, 0, hexToNumber(palette.colors.textSecondary), 0.8).setOrigin(0).setDepth(8);
  scene.add.line(x + 8, y + 15, 0, 0, 23, 0, color, 0.85).setOrigin(0).setDepth(8);
  scene.add.circle(x + 46, y + 12, 3, color).setDepth(8);
}

function drawCommandPanel(scene: Phaser.Scene, x: number, y: number, model: OfficeSceneModel): void {
  const cyan = hexToNumber(palette.categories.SEARCHING.color);
  scene.add.rectangle(x, y, 70, 34, hexToNumber(palette.colors.background)).setOrigin(0).setStrokeStyle(1, cyan, 0.85).setDepth(7);
  scene.add.text(x + 6, y + 4, 'OPS // LIVE', { fontFamily: 'monospace', fontSize: '7px', color: palette.colors.textPrimary }).setDepth(8);
  scene.add.text(x + 6, y + 15, `AGENTES ${String(model.agents.length).padStart(2, '0')}`, { fontFamily: 'monospace', fontSize: '6px', color: palette.colors.textSecondary }).setDepth(8);
  scene.add.text(x + 6, y + 24, `POSTOS ${String(model.workstations.length).padStart(2, '0')}`, { fontFamily: 'monospace', fontSize: '6px', color: palette.categories.WORKING.color }).setDepth(8);
}

function drawCoffee(scene: Phaser.Scene, x: number, y: number): void {
  scene.add.rectangle(x, y, 28, 20, hexToNumber(palette.colors.surfaceElevated)).setOrigin(0).setStrokeStyle(1, hexToNumber(palette.colors.border)).setDepth(7);
  scene.add.rectangle(x + 8, y + 4, 12, 8, hexToNumber(palette.colors.background)).setOrigin(0).setStrokeStyle(1, hexToNumber(palette.categories.WAITING.color)).setDepth(8);
  scene.add.rectangle(x + 11, y + 15, 6, 2, hexToNumber(palette.categories.WAITING.color)).setOrigin(0).setDepth(8);
}

function drawCouch(scene: Phaser.Scene, x: number, y: number): void {
  const violet = hexToNumber(palette.categories.ANALYZING.color);
  scene.add.rectangle(x, y, 62, 20, violet, 0.8).setOrigin(0).setStrokeStyle(1, hexToNumber(palette.colors.textSecondary)).setDepth(7);
  scene.add.rectangle(x + 5, y - 9, 52, 12, violet, 0.9).setOrigin(0).setStrokeStyle(1, hexToNumber(palette.colors.textSecondary)).setDepth(7);
  scene.add.rectangle(x + 27, y, 2, 20, hexToNumber(palette.colors.background), 0.5).setOrigin(0).setDepth(8);
}

function drawTable(scene: Phaser.Scene, x: number, y: number): void {
  scene.add.ellipse(x, y, 42, 22, hexToNumber(palette.colors.surfaceElevated)).setStrokeStyle(1, hexToNumber(palette.states.TESTING.color)).setDepth(7);
  scene.add.rectangle(x - 2, y + 9, 4, 10, hexToNumber(palette.colors.border)).setOrigin(0.5).setDepth(6);
  scene.add.circle(x - 8, y - 2, 3, hexToNumber(palette.categories.WAITING.color)).setDepth(8);
  scene.add.circle(x + 8, y + 2, 3, hexToNumber(palette.categories.SEARCHING.color)).setDepth(8);
}

function drawRack(scene: Phaser.Scene, x: number, y: number): void {
  scene.add.rectangle(x, y, 24, 56, hexToNumber(palette.colors.background)).setOrigin(0).setStrokeStyle(2, hexToNumber(palette.colors.border)).setDepth(7);
  for (let row = 0; row < 5; row += 1) {
    scene.add.rectangle(x + 4, y + 5 + row * 10, 16, 5, hexToNumber(palette.colors.surfaceElevated)).setOrigin(0).setDepth(8);
    scene.add.circle(x + 7, y + 7 + row * 10, 1.5, row % 2 === 0 ? hexToNumber(palette.categories.WORKING.color) : hexToNumber(palette.categories.SEARCHING.color)).setDepth(9);
  }
}

function drawCable(scene: Phaser.Scene, x: number, y: number): void {
  scene.add.line(x, y, 0, 0, 40, 0, hexToNumber(palette.categories.ANALYZING.color), 0.45).setOrigin(0).setDepth(6);
  scene.add.line(x + 12, y, 0, 0, 0, 14, hexToNumber(palette.categories.ANALYZING.color), 0.45).setOrigin(0).setDepth(6);
  scene.add.circle(x + 40, y, 2, hexToNumber(palette.categories.ANALYZING.color)).setDepth(7);
}

function drawDecor(scene: Phaser.Scene, room: SceneRoom, decor: RoomDecor[], tileSize: number, model: OfficeSceneModel, color: number): void {
  const { x, y, width, height } = room.bounds;
  const px = x * tileSize;
  const py = y * tileSize;
  const right = (x + width) * tileSize;
  const bottom = (y + height) * tileSize;
  const anchors: Record<RoomDecor, [number, number]> = {
    whiteboard: [px + 18, py + 28], plant: [px + 18, py + 56], bookshelf: [right - 40, py + 28],
    'command-panel': [right - 84, py + 28], coffee: [px + 24, bottom - 64], couch: [right - 80, bottom - 64],
    table: [px + width * tileSize * 0.55, bottom - 58], rack: [right - 62, py + 48], cable: [right - 92, bottom - 32],
    'server-light': [right - 34, bottom - 28],
  };
  for (const item of decor) {
    const [anchorX, anchorY] = anchors[item];
    if (item === 'plant') drawPlant(scene, anchorX, anchorY, 0.85);
    if (item === 'whiteboard') drawWhiteboard(scene, anchorX, anchorY, color);
    if (item === 'bookshelf') drawBookshelf(scene, anchorX, anchorY);
    if (item === 'command-panel') drawCommandPanel(scene, anchorX, anchorY, model);
    if (item === 'coffee') drawCoffee(scene, anchorX, anchorY);
    if (item === 'couch') drawCouch(scene, anchorX, anchorY);
    if (item === 'table') drawTable(scene, anchorX, anchorY);
    if (item === 'rack') drawRack(scene, anchorX, anchorY);
    if (item === 'cable') drawCable(scene, anchorX, anchorY);
    if (item === 'server-light') scene.add.circle(anchorX, anchorY, 4, hexToNumber(palette.categories.SEARCHING.color)).setDepth(8);
  }
}

function drawChair(scene: Phaser.Scene, x: number, y: number): void {
  scene.add.rectangle(x, y, 18, 7, hexToNumber(palette.colors.surfaceElevated)).setOrigin(0.5).setStrokeStyle(1, hexToNumber(palette.colors.border)).setDepth(8);
  scene.add.rectangle(x, y - 7, 14, 9, hexToNumber(palette.colors.surfaceElevated)).setOrigin(0.5).setStrokeStyle(1, hexToNumber(palette.colors.border)).setDepth(8);
  scene.add.rectangle(x, y + 6, 2, 8, hexToNumber(palette.colors.border)).setOrigin(0.5).setDepth(7);
}

function drawWorkstation(scene: Phaser.Scene, workstation: SceneWorkstation, selectedAgentId: string | null): void {
  const selected = workstation.assignedAgentId === selectedAgentId;
  const deskColor = workstation.status === 'EMPTY' ? palette.colors.surfaceElevated : palette.colors.surface;
  const monitorColor = workstation.status === 'EMPTY' ? palette.colors.textMuted : palette.categories.SEARCHING.color;
  const x = workstation.x;
  const y = workstation.y;
  scene.add.rectangle(x + 2, y + 4, 52, 30, hexToNumber(palette.colors.background), 0.45).setOrigin(0).setDepth(5);
  scene.add.rectangle(x, y, 52, 30, hexToNumber(deskColor)).setOrigin(0).setStrokeStyle(selected ? 2 : 1, selected ? hexToNumber(palette.colors.textPrimary) : hexToNumber(palette.colors.border), selected ? 1 : 0.9).setDepth(6);
  scene.add.rectangle(x + 13, y + 4, 26, 12, hexToNumber(palette.colors.background)).setOrigin(0).setStrokeStyle(1, hexToNumber(monitorColor)).setDepth(8);
  scene.add.rectangle(x + 16, y + 7, 20, 5, hexToNumber(monitorColor), workstation.status === 'EMPTY' ? 0.2 : 0.85).setOrigin(0).setDepth(9);
  scene.add.rectangle(x + 17, y + 20, 18, 3, hexToNumber(palette.colors.textSecondary), workstation.status === 'EMPTY' ? 0.3 : 0.75).setOrigin(0).setDepth(8);
  scene.add.rectangle(x + 8, y + 25, 8, 2, hexToNumber(palette.categories.WAITING.color), 0.7).setOrigin(0).setDepth(8);
  drawChair(scene, x + 26, y + 43);
  if (workstation.status === 'EMPTY') scene.add.circle(x + 46, y + 6, 2, hexToNumber(palette.colors.textMuted)).setDepth(10);
}

function drawAgent(scene: Phaser.Scene, agent: SceneAgent, onAgentSelect: (id: string) => void): void {
  const profile = getAgentVisualProfile(agent.id);
  const accent = accentColor(profile.accent);
  const start = agent.route[0];
  const shadow = scene.add.ellipse(start.x, start.y + 12, 20, 7, hexToNumber(palette.colors.background), 0.55).setDepth(10);
  const legs = scene.add.rectangle(start.x, start.y + 5, 11, 8, hexToNumber(palette.colors.background)).setOrigin(0.5).setDepth(12);
  const body = scene.add.rectangle(start.x, start.y - 3, 14, 16, accent).setOrigin(0.5).setStrokeStyle(1, hexToNumber(palette.colors.textPrimary)).setDepth(13);
  const head = scene.add.rectangle(start.x, start.y - 16, 10, 9, hexToNumber(palette.colors.textPrimary)).setOrigin(0.5).setStrokeStyle(1, accent).setDepth(14);
  const hair = scene.add.rectangle(start.x, start.y - 21, 10, 3, hexToNumber(palette.colors.background)).setOrigin(0.5).setDepth(15);
  const accessory = scene.add.rectangle(start.x + 7, start.y - 15, 4, 3, accent).setOrigin(0.5).setDepth(15);
  const label = scene.add.text(start.x, start.y - 31, agent.visual.label, { fontFamily: 'monospace', fontSize: '7px', color: palette.colors.textPrimary, backgroundColor: palette.colors.background }).setOrigin(0.5).setDepth(20);
  const hitArea = scene.add.zone(start.x, start.y - 5, 34, 48).setInteractive({ cursor: 'pointer' }).setDepth(21);
  hitArea.on('pointerdown', () => onAgentSelect(agent.id));

  const movingParts = [shadow, legs, body, head, hair, accessory, label, hitArea];
  const targets = agent.route.slice(1);
  if (targets.length > 0) scene.tweens.add({ targets: movingParts, x: targets[targets.length - 1].x, y: targets[targets.length - 1].y, duration: 1500, ease: 'Linear' });
  if (agent.visual.animation === 'scan' || agent.visual.animation === 'type') scene.tweens.add({ targets: [body, accessory], alpha: { from: 0.55, to: 1 }, duration: 700, yoyo: true, repeat: -1 });
  if (agent.visual.animation === 'alert') scene.tweens.add({ targets: label, alpha: { from: 0.25, to: 1 }, duration: 400, yoyo: true, repeat: -1 });
}

export function createOfficeScene(model: OfficeSceneModel, onAgentSelect: (id: string) => void, selectedAgentId: string | null): Phaser.Scene {
  return new (class OfficeScene extends Phaser.Scene {
    constructor() { super({ key: 'OfficeScene' }); }

    create(): void {
      const { grid } = model.layout;
      this.cameras.main.setBackgroundColor(palette.colors.background);
      this.cameras.main.setBounds(0, 0, grid.canvasWidth, grid.canvasHeight);
      this.cameras.main.setZoom(0.95);

      for (let column = 0; column <= grid.columns; column += 1) this.add.line(column * grid.tileSize, 0, 0, 0, 0, grid.rows * grid.tileSize, hexToNumber(palette.colors.border), 0.12).setOrigin(0).setDepth(0);
      for (let row = 0; row <= grid.rows; row += 1) this.add.line(0, row * grid.tileSize, 0, 0, grid.columns * grid.tileSize, 0, hexToNumber(palette.colors.border), 0.12).setOrigin(0).setDepth(0);

      const corridorColor = hexToNumber(palette.colors.surfaceElevated);
      this.add.rectangle(0, 220, grid.canvasWidth, 20, corridorColor).setOrigin(0).setDepth(1);
      this.add.rectangle(260, 0, 20, grid.canvasHeight, corridorColor).setOrigin(0).setDepth(1);
      this.add.rectangle(540, 0, 20, grid.canvasHeight, corridorColor).setOrigin(0).setDepth(1);
      this.add.text(12, 226, 'CORREDOR PRINCIPAL', { fontFamily: 'monospace', fontSize: '6px', color: palette.colors.textMuted }).setDepth(2);

      for (const room of model.rooms) {
        const blueprint = getRoomVisualBlueprint(room.id);
        const color = accentColor(blueprint.wallAccent);
        drawFloor(this, room, grid.tileSize, blueprint.floorPattern);
        drawWalls(this, room, grid.tileSize, color);
        drawDecor(this, room, blueprint.decor, grid.tileSize, model, color);
        const centerX = (room.bounds.x + room.bounds.width / 2) * grid.tileSize;
        const bottomY = (room.bounds.y + room.bounds.height) * grid.tileSize;
        drawDoor(this, centerX, bottomY, 28, color);
        this.add.text(room.bounds.x * grid.tileSize + 9, room.bounds.y * grid.tileSize + 5, room.name.toUpperCase(), { fontFamily: 'monospace', fontSize: '8px', color: palette.colors.textPrimary, backgroundColor: palette.colors.background }).setDepth(12);
      }

      model.workstations.forEach((workstation) => drawWorkstation(this, workstation, selectedAgentId));
      model.agents.forEach((agent) => drawAgent(this, agent, onAgentSelect));
      this.input.on('wheel', (_pointer: Phaser.Input.Pointer, _objects: unknown, _deltaX: number, deltaY: number) => {
        this.cameras.main.setZoom(Phaser.Math.Clamp(this.cameras.main.zoom - deltaY * 0.001, 0.72, 1.25));
      });
    }
  })();
}
