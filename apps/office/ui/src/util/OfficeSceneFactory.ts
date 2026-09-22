import Phaser from 'phaser';
import palette from '../../../../../assets/office/palette.json';
import { PixelPainter, paintOffice, paintPerson } from '../office/pixel-art';
import { art } from '../office/art-tokens';
import type { OfficeSceneModel, SceneAgent } from '../office/scene-model';

export { createOfficeSceneModel } from '../office/scene-model';

export function createOfficeScene(
  model: OfficeSceneModel,
  onAgentSelect: (id: string) => void,
  selectedAgentId: string | null,
): Phaser.Scene {
  return new (class OfficeScene extends Phaser.Scene {
    constructor() {
      super({ key: 'OfficeScene' });
    }

    private texture(
      key: string,
      w: number,
      h: number,
      draw: (p: PixelPainter) => void,
    ): string {
      const texture = this.textures.createCanvas(key, w, h);
      if (!texture) throw new Error(`Falha ao criar textura ${key}`);
      draw(new PixelPainter(texture.context));
      texture.refresh();
      return key;
    }

    private person(agent: SceneAgent, index: number) {
      for (const seated of [true, false])
        for (const direction of ['north', 'south', 'east', 'west'])
          for (let frame = 0; frame < 2; frame++) {
            this.texture(
              `${agent.id}-${seated}-${direction}-${frame}`,
              18,
              25,
              (p) => paintPerson(p, index, seated, frame, direction),
            );
          }
      const first = agent.route[0];
      const figure = this.add.container(first.x, first.y).setDepth(20);
      const sprite = this.add
        .image(0, -12, `${agent.id}-false-south-0`)
        .setScale(1.5);
      figure.add(sprite);
      const dot = this.add.rectangle(
        17,
        -19,
        3,
        3,
        Number.parseInt(agent.visual.color.slice(1), 16),
      );
      figure.add(dot);
      let selected = agent.id === selectedAgentId;
      const label = this.add
        .text(0, -43, `${agent.displayName}\n${agent.visual.label}`, {
          fontFamily: 'monospace',
          fontSize: '8px',
          align: 'center',
          color: palette.colors.textPrimary,
          backgroundColor: art.ink,
          padding: { x: 5, y: 3 },
        })
        .setOrigin(0.5, 1)
        .setVisible(selected);
      figure.add(label);
      const hit = this.add
        .zone(0, -12, 38, 47)
        .setInteractive({ cursor: 'pointer' });
      figure.add(hit);
      hit.on('pointerdown', () => onAgentSelect(agent.id));
      hit.on('pointerover', () => label.setVisible(true));
      hit.on('pointerout', () => label.setVisible(selected));
      const selectionLine = this.add
        .rectangle(
          0,
          8,
          25,
          2,
          Number.parseInt(agent.visual.color.slice(1), 16),
        )
        .setVisible(selected);
      figure.add(selectionLine);
      this.events.on('select-agent', (id: string | null) => {
        selected = id === agent.id;
        label.setVisible(selected);
        selectionLine.setVisible(selected);
      });
      let step = 0,
        walking = agent.route.length > 1,
        direction = 'south';
      const workstation = model.workstations.find(
        (ws) => ws.id === agent.workstationId,
      );
      const sit = () => {
        walking = false;
        sprite.setTexture(`${agent.id}-true-north-0`);
        if (workstation) {
          const desk = this.children.getByName(
            workstation.id,
          ) as Phaser.GameObjects.Image;
          desk.setTexture(`desk-${workstation.id}-on`);
        }
        if (agent.visual.animation === 'alert')
          this.tweens.add({
            targets: dot,
            alpha: 0.2,
            duration: 450,
            yoyo: true,
            repeat: -1,
          });
      };
      const next = (point: number) => {
        if (point >= agent.route.length) {
          sit();
          return;
        }
        const target = agent.route[point];
        direction =
          target.x !== figure.x
            ? target.x > figure.x
              ? 'east'
              : 'west'
            : target.y < figure.y
              ? 'north'
              : 'south';
        this.tweens.add({
          targets: figure,
          x: target.x,
          y: target.y,
          duration:
            (Phaser.Math.Distance.Between(
              figure.x,
              figure.y,
              target.x,
              target.y,
            ) /
              65) *
            1000,
          ease: 'Linear',
          onComplete: () => next(point + 1),
        });
      };
      this.time.addEvent({
        delay: 180,
        loop: true,
        callback: () => {
          step++;
          if (walking)
            sprite.setTexture(`${agent.id}-false-${direction}-${step % 2}`);
          else if (['type', 'scan', 'think'].includes(agent.visual.animation))
            sprite.y = -12 + (step % 4 === 0 ? 1 : 0);
        },
      });
      if (walking) next(1);
      else sit();
    }

    create(): void {
      const { canvasWidth: w, canvasHeight: h } = model.layout.grid;
      this.cameras.main
        .setBackgroundColor(art.ink)
        .setBounds(0, 0, w, h)
        .setZoom(1);
      this.add
        .image(
          0,
          0,
          this.texture('office-scenery', w, h, (p) => paintOffice(p, model)),
        )
        .setOrigin(0);
      for (const ws of model.workstations) {
        const entering = model.agents.some(
          (a) => a.workstationId === ws.id && a.route.length > 1,
        );
        for (const on of [true, false])
          this.texture(`desk-${ws.id}-${on ? 'on' : 'off'}`, 82, 83, (p) =>
            p.desk({ ...ws, x: 12, y: 12 }, on),
          );
        this.add
          .image(
            ws.x - 12,
            ws.y - 12,
            `desk-${ws.id}-${ws.status === 'OCCUPIED' && !entering ? 'on' : 'off'}`,
          )
          .setOrigin(0)
          .setName(ws.id)
          .setDepth(10);
      }
      const founders = [
        'CACADOR-001',
        'DIRETOR-001',
        'DESENVOLVEDOR-001',
        'REVISOR-001',
      ];
      model.agents.forEach((agent) =>
        this.person(agent, Math.max(0, founders.indexOf(agent.id))),
      );
      this.input.on(
        'wheel',
        (_p: Phaser.Input.Pointer, _o: unknown, _dx: number, dy: number) => {
          this.cameras.main.setZoom(
            Phaser.Math.Clamp(this.cameras.main.zoom - dy * 0.001, 1, 2),
          );
        },
      );
      this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
        if (pointer.isDown) {
          this.cameras.main.scrollX -=
            (pointer.x - pointer.prevPosition.x) / this.cameras.main.zoom;
          this.cameras.main.scrollY -=
            (pointer.y - pointer.prevPosition.y) / this.cameras.main.zoom;
        }
      });
    }
  })();
}
