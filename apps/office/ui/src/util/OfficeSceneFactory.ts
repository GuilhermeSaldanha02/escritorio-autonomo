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
    private currentModel = model;
    private readonly views = new Map<string, {
      agent: SceneAgent;
      figure: Phaser.GameObjects.Container;
      dot: Phaser.GameObjects.Rectangle;
      label: Phaser.GameObjects.Text;
      selectionLine: Phaser.GameObjects.Rectangle;
      timer: Phaser.Time.TimerEvent;
      selectHandler: (id: string | null) => void;
      alerting: boolean;
      walking: boolean;
    }>();

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
      const selectHandler = (id: string | null) => {
        selected = id === agent.id;
        label.setVisible(selected);
        selectionLine.setVisible(selected);
      };
      this.events.on('select-agent', selectHandler);
      let step = 0,
        walking = agent.route.length > 1,
        direction = 'south';
      const sit = () => {
        walking = false;
        const view = this.views.get(agent.id);
        if (view) view.walking = false;
        sprite.setTexture(`${agent.id}-true-north-0`);
        const workstation = this.currentModel.workstations.find(
          ws => ws.id === view?.agent.workstationId,
        );
        if (workstation) {
          const desk = this.children.getByName(
            workstation.id,
          ) as Phaser.GameObjects.Image;
          desk.setTexture(`desk-${workstation.id}-on`);
        }
        this.syncAlert(agent.id);
      };
      const next = (point: number) => {
        if (!this.views.has(agent.id)) return;
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
      const timer = this.time.addEvent({
        delay: 180,
        loop: true,
        callback: () => {
          step++;
          if (walking)
            sprite.setTexture(`${agent.id}-false-${direction}-${step % 2}`);
          else if (['type', 'scan', 'think'].includes(this.views.get(agent.id)?.agent.visual.animation ?? ''))
            sprite.y = -12 + (step % 4 === 0 ? 1 : 0);
        },
      });
      this.views.set(agent.id, { agent, figure, dot, label, selectionLine, timer, selectHandler, alerting: false, walking });
      if (walking) next(1);
      else sit();
    }

    private syncAlert(id: string): void {
      const view = this.views.get(id);
      if (!view) return;
      const alert = view.agent.visual.animation === 'alert';
      if (alert && !view.alerting) {
        this.tweens.add({ targets: view.dot, alpha: 0.2, duration: 450, yoyo: true, repeat: -1 });
        view.alerting = true;
      } else if (!alert && view.alerting) {
        this.tweens.killTweensOf(view.dot);
        view.dot.setAlpha(1);
        view.alerting = false;
      }
    }

    private updateModel(next: OfficeSceneModel): void {
      this.currentModel = next;
      const nextIds = new Set(next.agents.map(agent => agent.id));
      for (const [id, view] of this.views) {
        if (nextIds.has(id)) continue;
        view.timer.remove();
        this.tweens.killTweensOf(view.figure);
        this.tweens.killTweensOf(view.dot);
        this.events.off('select-agent', view.selectHandler);
        view.figure.destroy(true);
        this.views.delete(id);
      }
      const founders = ['CACADOR-001', 'DIRETOR-001', 'DESENVOLVEDOR-001', 'REVISOR-001'];
      for (const agent of next.agents) {
        const view = this.views.get(agent.id);
        if (!view) { this.person(agent, Math.max(0, founders.indexOf(agent.id))); continue; }
        if (view.agent.workstationId !== agent.workstationId) {
          this.tweens.killTweensOf(view.figure);
          view.figure.setPosition(agent.x, agent.y);
        }
        view.agent = agent;
        const color = Number.parseInt(agent.visual.color.slice(1), 16);
        view.dot.setFillStyle(color);
        view.selectionLine.setFillStyle(color);
        view.label.setText(`${agent.displayName}\n${agent.visual.label}`);
        this.syncAlert(agent.id);
      }
      for (const workstation of next.workstations) {
        const desk = this.children.getByName(workstation.id) as Phaser.GameObjects.Image | null;
        const entering = next.agents.some(agent => agent.workstationId === workstation.id && this.views.get(agent.id)?.walking);
        desk?.setTexture(`desk-${workstation.id}-${workstation.status === 'OCCUPIED' && !entering ? 'on' : 'off'}`);
      }
    }

    create(): void {
      this.events.on('update-office-model', (next: OfficeSceneModel) => this.updateModel(next));
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
