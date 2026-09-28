import { readFileSync } from 'node:fs';
import type { OfficeWorkstation } from '@escritorio/office-contract';

interface Layout {
  rooms: Array<{ id: string; workstations: Array<{ workstationId: string }> }>;
  defaultPlacement: Record<string, { workstationId: string }>;
}

const layout = JSON.parse(readFileSync(new URL('../../../../assets/office/layout.json', import.meta.url), 'utf8')) as Layout;

export function projectWorkstations(activeAgentIds: ReadonlySet<string>): OfficeWorkstation[] {
  const occupants = new Map<string, string>();
  for (const [agentId, placement] of Object.entries(layout.defaultPlacement)) {
    if (activeAgentIds.has(agentId)) occupants.set(placement.workstationId, agentId);
  }
  return layout.rooms.flatMap(room => room.workstations.map(desk => {
    const assignedAgentId = occupants.get(desk.workstationId) ?? null;
    return {
      id: desk.workstationId,
      roomId: room.id,
      status: assignedAgentId === null ? 'EMPTY' as const : 'OCCUPIED' as const,
      assignedAgentId,
    };
  }));
}
