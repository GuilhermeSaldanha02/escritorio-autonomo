import { art as c } from './art-tokens';
import type { OfficeSceneModel, SceneWorkstation } from './scene-model';

// All assets are hand-drawn here on an integer pixel grid; no third-party art.
export class PixelPainter {
  readonly ctx: CanvasRenderingContext2D;
  constructor(ctx: CanvasRenderingContext2D) {
    this.ctx = ctx;
    ctx.imageSmoothingEnabled = false;
  }
  rect(x: number, y: number, w: number, h: number, color: string) {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(Math.round(x), Math.round(y), w, h);
  }
  box(
    x: number,
    y: number,
    w: number,
    h: number,
    top: string,
    face: string,
    depth = 5,
  ) {
    this.rect(x + 4, y + depth + 3, w, h, c.shadow);
    this.rect(x, y + depth, w, h, face);
    this.rect(x, y, w, h, top);
    this.rect(x, y, w, 1, c.steelLight);
  }
  plant(x: number, y: number) {
    this.rect(x - 7, y + 8, 20, 6, c.shadow);
    this.rect(x - 6, y, 13, 11, c.potShade);
    this.rect(x - 8, y - 2, 16, 4, c.pot);
    this.rect(x - 4, y + 2, 8, 6, c.pot);
    this.rect(x - 1, y - 20, 2, 21, c.leafShade);
    for (const [dx, dy, w, h] of [
      [-11, -17, 8, 7],
      [3, -22, 9, 6],
      [-6, -29, 7, 12],
      [-12, -8, 10, 5],
      [1, -12, 11, 7],
      [-3, -18, 7, 9],
    ]) {
      this.rect(x + dx, y + dy, w, h, c.leaf);
      this.rect(x + dx, y + dy, w - 2, 2, c.leafLight);
      this.rect(x + dx + 2, y + dy + h - 2, w - 2, 2, c.leafShade);
    }
  }
  shelf(x: number, y: number, w = 36) {
    this.box(x, y, w, 38, c.woodShade, c.ink, 6);
    for (let row = 0; row < 3; row++) {
      for (let i = 0; i < (w - 6) / 5; i++) {
        this.rect(
          x + 4 + i * 5,
          y + 3 + row * 11,
          3,
          8,
          [c.paperShade, c.coats[0], c.coats[3], c.sofaLight][i % 4],
        );
        this.rect(x + 4 + i * 5, y + 5 + row * 11, 3, 1, c.paper);
      }
      this.rect(x + 2, y + 11 + row * 11, w - 4, 2, c.woodLight);
    }
  }
  cabinet(x: number, y: number, w = 32) {
    this.box(x, y, w, 29, c.steel, c.ink);
    for (let row = 0; row < 2; row++) {
      this.rect(x + 2, y + 3 + row * 13, w - 4, 11, c.steelLight);
      this.rect(x + w / 2 - 4, y + 6 + row * 13, 8, 2, c.ink);
      this.rect(x + 4, y + 8 + row * 13, 5, 3, c.paper);
    }
  }
  monitor(x: number, y: number, on: boolean, w = 24) {
    this.rect(x + w / 2 - 5, y + 21, 10, 3, c.steel);
    this.rect(x + w / 2 - 1, y + 14, 3, 8, c.ink);
    this.rect(x, y, w, 17, c.ink);
    this.rect(x + 2, y + 2, w - 4, 12, on ? c.screen : c.screenDark);
    this.rect(x + 2, y + 2, w - 4, 2, c.steel);
    if (on) {
      for (let i = 0; i < 3; i++)
        this.rect(x + 4, y + 6 + i * 3, w - 10 - i * 3, 1, c.screenLine);
      this.rect(x + w - 6, y + 6, 2, 6, c.screenDark);
    }
    this.rect(x + w - 4, y + 15, 1, 1, on ? c.leafLight : c.steel);
  }
  chair(x: number, y: number) {
    this.rect(x - 1, y + 4, 3, 16, c.ink);
    this.rect(x - 11, y + 15, 24, 2, c.steel);
    this.rect(x - 10, y + 14, 3, 5, c.ink);
    this.rect(x + 9, y + 14, 3, 5, c.ink);
    this.rect(x - 10, y - 8, 21, 18, c.ink);
    this.rect(x - 8, y - 7, 17, 15, c.chairLight);
    this.rect(x - 7, y - 3, 15, 10, c.chair);
    this.rect(x - 13, y - 3, 3, 13, c.ink);
    this.rect(x + 11, y - 3, 3, 13, c.ink);
  }
  desk(ws: SceneWorkstation, on: boolean) {
    const { x, y } = ws;
    this.chair(x + 26, y + 44);
    this.rect(x - 5, y + 25, 7, 17, c.deskShade);
    this.rect(x + 51, y + 25, 7, 17, c.deskShade);
    this.box(x - 7, y - 2, 66, 34, c.desk, c.deskShade, 6);
    this.rect(x - 5, y, 62, 1, c.deskLight);
    for (let i = 0; i < 4; i++)
      this.rect(x - 4, y + 5 + i * 7, 59, 1, c.woodLight);
    const dual = ws.roomId === 'room-engineering';
    this.monitor(x + (dual ? 0 : 12), y - 8, on, dual ? 25 : 29);
    if (dual) this.monitor(x + 28, y - 8, on, 25);
    this.rect(x + 15, y + 21, 24, 7, c.ink);
    for (let row = 0; row < 2; row++)
      for (let col = 0; col < 8; col++)
        this.rect(x + 16 + col * 3, y + 22 + row * 3, 2, 2, c.paperShade);
    this.rect(x + 43, y + 21, 5, 7, c.steelLight);
    this.rect(x - 3, y + 18, 10, 9, c.paperShade);
    this.rect(x - 2, y + 17, 8, 8, c.paper);
    this.rect(x + 51, y + 14, 6, 6, c.paper);
    this.rect(x + 52, y + 14, 4, 2, c.woodShade);
    this.rect(x + 49, y + 35, 8, 14, c.ink);
    this.rect(x + 51, y + 37, 4, 1, c.steel);
  }
  rack(x: number, y: number) {
    this.box(x, y, 37, 62, c.steel, c.ink, 7);
    this.rect(x + 3, y + 3, 31, 56, c.ink);
    for (let i = 0; i < 6; i++) {
      this.rect(x + 5, y + 5 + i * 9, 27, 7, c.chair);
      for (let slot = 0; slot < 5; slot++)
        this.rect(x + 7 + slot * 3, y + 7 + i * 9, 1, 3, c.steel);
      this.rect(x + 26, y + 7 + i * 9, 2, 2, i % 2 ? c.screen : c.leafLight);
    }
  }
  board(x: number, y: number, w = 72) {
    this.box(x, y, w, 29, c.steel, c.ink, 3);
    this.rect(x + 3, y + 3, w - 6, 22, c.paperShade);
    for (let i = 0; i < 4; i++) {
      this.rect(
        x + 6 + i * 15,
        y + 6,
        11,
        7,
        [c.paper, c.screen, c.coatsLight[3], c.paper][i],
      );
      this.rect(x + 7 + i * 15, y + 17, 8, 1, c.steel);
      this.rect(x + 7 + i * 15, y + 20, 6, 1, c.steel);
    }
    this.rect(x + 4, y + 27, w - 8, 3, c.steelLight);
  }
}

export function paintOffice(p: PixelPainter, model: OfficeSceneModel) {
  const { tileSize: t, canvasWidth: w, canvasHeight: h } = model.layout.grid;
  p.rect(0, 0, w, h, c.ink);
  // One continuous circulation floor, visible between the enclosed rooms.
  for (let y = 10; y < h - 10; y += 10)
    for (let x = 10; x < w - 10; x += 20) {
      p.rect(x, y, 19, 9, c.corridor);
      p.rect(x + 2, y + 1, 16, 1, c.steelLight);
    }
  for (const room of model.rooms) {
    const { x: col, y: row, width, height } = room.bounds;
    const x = col * t,
      y = row * t,
      rw = width * t,
      rh = height * t;
    const wood = room.id === 'room-boardroom' || room.id === 'room-breakroom';
    p.rect(x, y, rw, rh, c.seam);
    for (let dy = 0; dy < rh; dy += 10)
      for (let dx = 0; dx < rw; dx += 20) {
        p.rect(
          x + dx,
          y + dy,
          19,
          9,
          wood
            ? (dy / 10) % 2
              ? c.wood
              : c.woodShade
            : (dx / 20 + dy / 10) % 2
              ? c.floor
              : c.floorAlt,
        );
        if (wood) p.rect(x + dx + 2, y + dy + 2, 13, 1, c.woodLight);
      }
    // Raised rear walls, cutaway sides and low front wall. No status-color outlines.
    p.rect(x + 8, y + 24, rw - 8, 8, c.shadow);
    p.rect(x, y, rw, 25, c.wall);
    p.rect(x, y, rw, 5, c.wallTop);
    p.rect(x, y + 5, rw, 2, c.wallLight);
    p.rect(x, y + 22, rw, 4, c.skirting);
    for (let i = 16; i < rw; i += 40) p.rect(x + i, y + 8, 1, 13, c.wallShade);
    p.rect(x, y, 7, rh, c.wallShade);
    p.rect(x, y, 3, rh, c.wallTop);
    p.rect(x + rw - 7, y, 7, rh, c.wallShade);
    p.rect(x + rw - 3, y, 3, rh, c.wallTop);
    const doorX = x + rw / 2,
      doorTop = y > 200;
    p.rect(x, y + rh - 7, rw, 7, c.wallShade);
    p.rect(x, y + rh - 7, rw, 2, c.wallTop);
    const doorY = doorTop ? y : y + rh - 7;
    p.rect(doorX - 18, doorY, 36, doorTop ? 26 : 7, c.corridor);
    p.rect(doorX - 21, doorY, 3, doorTop ? 26 : 7, c.wallLight);
    p.rect(doorX + 18, doorY, 3, doorTop ? 26 : 7, c.wallLight);
    p.rect(doorX - 16, doorY + 4, 3, 18, c.woodLight);
    p.rect(doorX - 14, doorY + 14, 2, 2, c.lamp);
    // Light fixture, clock and wall plate read as architecture at normal zoom.
    p.rect(x + rw - 62, y + 10, 34, 3, c.lamp);
    p.rect(x + rw - 60, y + 13, 30, 2, c.wallLight);
    p.rect(x + 15, y + 9, 11, 11, c.ink);
    p.rect(x + 17, y + 10, 7, 8, c.paper);
    p.rect(x + 20, y + 11, 1, 4, c.ink);
    p.rect(x + 20, y + 15, 3, 1, c.ink);
    if (room.id === 'room-prospecting') {
      p.board(x + 42, y + 34, 78);
      p.shelf(x + rw - 48, y + 33);
      p.plant(x + 22, y + 80);
      p.cabinet(x + 12, y + rh - 48, 37);
      p.rect(x + 14, y + rh - 54, 15, 6, c.paper);
    } else if (room.id === 'room-boardroom') {
      p.rect(x + 43, y + 30, 104, 35, c.ink);
      for (let i = 0; i < 3; i++) p.monitor(x + 47 + i * 33, y + 34, true, 29);
      p.plant(x + rw - 23, y + 79);
      p.cabinet(x + 12, y + rh - 48, 40);
      p.shelf(x + rw - 49, y + rh - 55, 34);
    } else if (room.id === 'room-breakroom') {
      p.box(x + 18, y + 39, 82, 25, c.deskLight, c.deskShade, 15);
      p.box(x + 23, y + 29, 23, 20, c.ink, c.steel);
      p.rect(x + 27, y + 32, 15, 8, c.steel);
      p.rect(x + 32, y + 44, 6, 5, c.paper);
      p.rect(x + 56, y + 45, 6, 5, c.paper);
      p.box(x + 73, y + 27, 20, 23, c.paperShade, c.steel);
      p.rect(x + 75, y + 34, 16, 2, c.steel);
      p.plant(x + rw - 23, y + 68);
      p.box(x + 83, y + 91, 104, 49, c.sofaShade, c.ink, 5);
      p.rect(x + 86, y + 88, 98, 13, c.sofaLight);
      for (let i = 0; i < 3; i++) {
        p.rect(x + 89 + i * 30, y + 104, 27, 24, c.sofa);
        p.rect(x + 89 + i * 30, y + 104, 27, 2, c.sofaLight);
      }
      p.rect(x + 82, y + 100, 8, 34, c.sofaLight);
      p.rect(x + 180, y + 100, 8, 34, c.sofaLight);
      p.box(x + 29, y + 122, 39, 27, c.desk, c.deskShade, 9);
      p.rect(x + 37, y + 127, 15, 10, c.paper);
      p.rect(x + 54, y + 133, 5, 5, c.paperShade);
      p.plant(x + rw - 25, y + rh - 22);
    } else if (room.id === 'room-engineering') {
      for (let i = 0; i < 3; i++) p.monitor(x + 40 + i * 43, y + 35, true, 36);
      p.cabinet(x + rw - 53, y + 34, 36);
      p.plant(x + 22, y + 75);
      p.box(x + 13, y + rh - 45, 49, 21, c.steel, c.ink);
      p.rect(x + 18, y + rh - 42, 12, 10, c.ink);
      p.rect(x + 38, y + rh - 40, 16, 2, c.screen);
      p.rect(x + rw - 47, y + rh - 37, 23, 18, c.woodShade);
      p.rect(x + rw - 44, y + rh - 34, 17, 2, c.woodLight);
    } else if (room.id === 'room-qa-review') {
      p.shelf(x + 16, y + 33, 51);
      p.board(x + rw - 87, y + 35, 66);
      p.plant(x + rw - 20, y + rh - 22);
      p.cabinet(x + 12, y + rh - 44, 38);
    } else {
      for (let i = 0; i < 3; i++) p.rack(x + 17 + i * 55, y + 42);
      for (let i = 0; i < 2; i++) p.rack(x + 27 + i * 62, y + 127);
      p.rect(x + 17, y + 114, 143, 3, c.steel);
      p.rect(x + 17, y + 118, 143, 1, c.screenDark);
      p.box(x + rw - 39, y + rh - 57, 24, 35, c.steelLight, c.steel);
      for (let i = 0; i < 5; i++)
        p.rect(x + rw - 36, y + rh - 51 + i * 5, 18, 2, c.ink);
    }
    if (room.workstations.length) {
      p.rect(x + rw - 23, y + rh - 49, 11, 15, c.ink);
      p.rect(x + rw - 24, y + rh - 50, 13, 3, c.steel);
    }
  }
}

// 16x24 original humanoid sprite. Back-facing seated frame looks into the screen.
export function paintPerson(
  p: PixelPainter,
  index: number,
  seated: boolean,
  frame = 0,
  direction = 'south',
) {
  const hair = c.hair[index % 4],
    coat = c.coats[index % 4],
    light = c.coatsLight[index % 4];
  const r = (x: number, y: number, w: number, h: number, color: string) =>
    p.rect(x, y, w, h, color);
  r(3, 22, 11, 2, c.shadow);
  r(4, 16, 4, seated ? 5 : 7, c.pants);
  r(9, 16, 4, seated ? 5 : 7, c.pants);
  r(3, 22 - (frame % 2), 5, 2, c.shoes);
  r(9, 21 + (frame % 2), 5, 2, c.shoes);
  r(3, 10, 11, 9, coat);
  r(4, 10, 3, 8, light);
  r(4, 18, 9, 1, c.ink);
  r(1, 11, 3, 7, coat);
  r(13, 11, 3, 7, coat);
  r(1, seated ? 10 : 17, 3, 3, c.skin);
  r(13, seated ? 10 : 17, 3, 3, c.skinLight);
  r(5, 8, 7, 3, c.skinShade);
  r(3, 2, 11, 7, c.skin);
  r(4, 1, 9, 9, c.skinLight);
  r(4, 0, 9, 2, hair);
  r(2, 2, 13, 4, hair);
  r(3, 5, 2, 3, hair);
  if (seated || direction === 'north') {
    r(3, 4, 11, 4, hair);
    r(5, 7, 7, 2, hair);
    r(5, 2, 6, 1, c.woodLight);
  } else if (direction === 'east' || direction === 'west') {
    const eye = direction === 'east' ? 12 : 5;
    r(direction === 'east' ? 3 : 10, 4, 4, 5, hair);
    r(eye, 6, 1, 1, c.ink);
    r(direction === 'east' ? 14 : 2, 7, 2, 2, c.skin);
  } else {
    r(6, 6, 1, 1, c.ink);
    r(11, 6, 1, 1, c.ink);
    r(8, 8, 3, 1, c.skinShade);
  }
  if (index === 0) {
    r(2, 3, 1, 6, c.steelLight);
    r(1, 5, 3, 3, c.ink);
  }
  if (index === 1) {
    r(8, 11, 2, 6, c.paper);
    r(9, 12, 1, 4, c.sofaShade);
  }
  if (index === 2) {
    r(5, 10, 7, 2, c.chair);
    r(6, 12, 5, 1, light);
  }
  if (index === 3) {
    r(12, 14, 4, 5, c.paper);
    r(13, 15, 2, 1, c.woodShade);
  }
  if (seated) {
    r(3, 18, 11, 4, c.chair);
    r(4, 18, 9, 1, c.chairLight);
  }
}
