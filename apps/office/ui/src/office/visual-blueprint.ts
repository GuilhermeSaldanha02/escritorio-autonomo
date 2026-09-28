export type RoomDecor = 'whiteboard' | 'plant' | 'bookshelf' | 'command-panel' | 'coffee' | 'couch' | 'table' | 'rack' | 'cable' | 'server-light';

export interface RoomVisualBlueprint {
  floorPattern: 'tile' | 'wood' | 'technical';
  decor: RoomDecor[];
  wallAccent: 'cyan' | 'violet' | 'teal' | 'green' | 'gold' | 'slate';
}

export interface AgentVisualProfile {
  accent: 'cyan' | 'violet' | 'green' | 'gold';
  outfit: 'field' | 'executive' | 'technical' | 'audit';
  accessory: 'headset' | 'badge' | 'terminal' | 'clipboard';
}

const ROOM_BLUEPRINTS: Record<string, RoomVisualBlueprint> = {
  'room-prospecting': { floorPattern: 'tile', decor: ['whiteboard', 'plant', 'bookshelf'], wallAccent: 'cyan' },
  'room-boardroom': { floorPattern: 'wood', decor: ['whiteboard', 'plant', 'command-panel'], wallAccent: 'violet' },
  'room-breakroom': { floorPattern: 'tile', decor: ['coffee', 'couch', 'table', 'plant'], wallAccent: 'teal' },
  'room-engineering': { floorPattern: 'technical', decor: ['command-panel', 'plant', 'rack', 'cable'], wallAccent: 'green' },
  'room-qa-review': { floorPattern: 'tile', decor: ['whiteboard', 'plant', 'bookshelf'], wallAccent: 'gold' },
  'room-servers': { floorPattern: 'technical', decor: ['rack', 'cable', 'server-light'], wallAccent: 'slate' },
};

const AGENT_PROFILES: Record<string, AgentVisualProfile> = {
  'CACADOR-001': { accent: 'cyan', outfit: 'field', accessory: 'headset' },
  'DIRETOR-001': { accent: 'violet', outfit: 'executive', accessory: 'badge' },
  'DESENVOLVEDOR-001': { accent: 'green', outfit: 'technical', accessory: 'terminal' },
  'REVISOR-001': { accent: 'gold', outfit: 'audit', accessory: 'clipboard' },
};

const FALLBACK_ROOM: RoomVisualBlueprint = { floorPattern: 'tile', decor: ['plant'], wallAccent: 'slate' };
const FALLBACK_AGENT: AgentVisualProfile = { accent: 'cyan', outfit: 'field', accessory: 'badge' };

export function getRoomVisualBlueprint(roomId: string): RoomVisualBlueprint {
  return ROOM_BLUEPRINTS[roomId] ?? FALLBACK_ROOM;
}

export function getAgentVisualProfile(agentId: string): AgentVisualProfile {
  return AGENT_PROFILES[agentId] ?? FALLBACK_AGENT;
}
