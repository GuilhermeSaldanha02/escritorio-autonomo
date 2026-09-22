import { TIMELINE_TYPES, type OfficeTimelineEvent } from '@escritorio/office-contract';

export interface OfficeSourceEvent {
  id: string;
  type: string;
  occurredAt: string;
  agentId?: string | null;
  taskId?: string | null;
  opportunityId?: string | null;
  newState?: string;
  applied?: boolean;
  payload?: unknown;
}

const publicId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const allowed = new Set<string>(TIMELINE_TYPES);

export function projectTimeline(events: readonly OfficeSourceEvent[]): OfficeTimelineEvent[] {
  return events.filter(event => allowed.has(event.type) && publicId.test(event.id) &&
    !Number.isNaN(Date.parse(event.occurredAt)) &&
    (event.agentId == null || publicId.test(event.agentId)))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id))
    .slice(0, 50).map(event => ({
      id: event.id,
      type: event.type as OfficeTimelineEvent['type'],
      occurredAt: event.occurredAt,
      ...(event.agentId ? { agentId: event.agentId } : {}),
      summary: `Evento ${event.type.replaceAll('_', ' ').toLowerCase()} registrado.`,
    }));
}
