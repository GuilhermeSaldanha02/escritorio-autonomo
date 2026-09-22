import type { OfficeAgent, OfficeSnapshot } from '../data/types';
import {
  visualStateResolver,
  type VisualState,
} from '../util/VisualStateResolver';

interface LayoutPosition {
  col: number;
  row: number;
}

interface LayoutWorkstation {
  workstationId: string;
  assignedAgentId: string | null;
  status: 'OCCUPIED' | 'EMPTY';
  position: LayoutPosition;
}

interface LayoutFeature {
  id: string;
  label: string;
  position: LayoutPosition;
}

interface LayoutRoom {
  id: string;
  name: string;
  themeColor: string;
  bounds: { x: number; y: number; width: number; height: number };
  workstations: LayoutWorkstation[];
  features?: LayoutFeature[];
}

export interface OfficeLayout {
  grid: {
    columns: number;
    rows: number;
    tileSize: number;
    canvasWidth: number;
    canvasHeight: number;
  };
  rooms: LayoutRoom[];
  defaultPlacement: Record<string, { roomId: string; workstationId: string }>;
}

export interface SceneWorkstation {
  id: string;
  roomId: string;
  x: number;
  y: number;
  status: 'OCCUPIED' | 'EMPTY';
  assignedAgentId: string | null;
}

export interface SceneAgent {
  id: string;
  displayName: string;
  x: number;
  y: number;
  workstationId?: string;
  route: Array<{ x: number; y: number }>;
  visual: VisualState;
}

export interface OfficeSceneModel {
  layout: OfficeLayout;
  rooms: LayoutRoom[];
  workstations: SceneWorkstation[];
  agents: SceneAgent[];
}

function toSceneWorkstations(layout: OfficeLayout): SceneWorkstation[] {
  const { tileSize } = layout.grid;
  return layout.rooms.flatMap((room) =>
    room.workstations.map((workstation) => ({
      id: workstation.workstationId,
      roomId: room.id,
      x: workstation.position.col * tileSize,
      y: workstation.position.row * tileSize,
      status: workstation.status,
      assignedAgentId: workstation.assignedAgentId,
    })),
  );
}

function routeTo(
  workstation: SceneWorkstation,
  isEntering: boolean,
  layout: OfficeLayout,
): Array<{ x: number; y: number }> {
  const destination = { x: workstation.x + 26, y: workstation.y + 46 };
  if (!isEntering) return [destination];

  const room = layout.rooms.find(
    (candidate) => candidate.id === workstation.roomId,
  );
  if (!room) return [destination];
  const t = layout.grid.tileSize;
  const doorX = (room.bounds.x + room.bounds.width / 2) * t;
  const top = room.bounds.y * t;
  const entrance = { x: 10, y: 230 };
  if (top < 230)
    return [
      entrance,
      { x: doorX, y: 230 },
      { x: doorX, y: destination.y + 30 },
      { x: destination.x, y: destination.y + 30 },
      destination,
    ];
  const aisleX = room.bounds.x * t + 37;
  return [
    entrance,
    { x: doorX, y: 230 },
    { x: doorX, y: top + 72 },
    { x: aisleX, y: top + 72 },
    { x: aisleX, y: destination.y + 30 },
    { x: destination.x, y: destination.y + 30 },
    destination,
  ];
}

function placeAgent(
  agent: OfficeAgent,
  workstations: SceneWorkstation[],
  layout: OfficeLayout,
): SceneAgent {
  const preferredId =
    agent.workstationId ?? layout.defaultPlacement[agent.id]?.workstationId;
  const workstation =
    workstations.find((candidate) => candidate.id === preferredId) ??
    workstations.find(
      (candidate) =>
        candidate.status === 'EMPTY' && candidate.assignedAgentId === null,
    );

  if (!workstation) {
    return {
      id: agent.id,
      displayName: agent.displayName,
      x: 400,
      y: 240,
      route: [{ x: 400, y: 240 }],
      visual: visualStateResolver(agent.state),
    };
  }

  workstation.assignedAgentId = agent.id;
  workstation.status = 'OCCUPIED';
  const route = routeTo(
    workstation,
    agent.lifecycleStatus === 'PROBATION',
    layout,
  );
  const destination = route[route.length - 1];

  return {
    id: agent.id,
    displayName: agent.displayName,
    x: destination.x,
    y: destination.y,
    workstationId: workstation.id,
    route,
    visual: visualStateResolver(agent.state),
  };
}

export function createOfficeSceneModel(input: {
  layout: OfficeLayout;
  snapshot: OfficeSnapshot;
}): OfficeSceneModel {
  const workstations = toSceneWorkstations(input.layout);
  const snapshotAssignments = new Map(
    input.snapshot.workstations.map((workstation) => [
      workstation.id,
      workstation,
    ]),
  );

  for (const workstation of workstations) {
    const snapshotWorkstation = snapshotAssignments.get(workstation.id);
    if (snapshotWorkstation) {
      workstation.status = snapshotWorkstation.status;
      workstation.assignedAgentId = snapshotWorkstation.assignedAgentId;
    }
  }

  return {
    layout: input.layout,
    rooms: input.layout.rooms,
    workstations,
    agents: input.snapshot.agents.map((agent) =>
      placeAgent(agent, workstations, input.layout),
    ),
  };
}
