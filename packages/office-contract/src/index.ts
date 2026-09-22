import { z } from 'zod';

export const CONTRACT_VERSION = '2.0.0' as const;
export const publicIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
export const timestampSchema = z.iso.datetime({ offset: true });
export const revisionSchema = z.string().max(19).regex(/^(0|[1-9][0-9]*)$/).refine(value => BigInt(value) <= 9_223_372_036_854_775_807n);
const epochSchema = z.uuid().refine(value => value === value.toLowerCase());

/** Opaco ao consumidor: somente estes helpers conhecem a representação. */
export function encodeCursor({ epoch, revision }: { epoch: string; revision: string }): string {
  return `v2.${epochSchema.parse(epoch)}.${revisionSchema.parse(revision)}`;
}
export function decodeCursor(cursor: string): { version: typeof CONTRACT_VERSION; epoch: string; revision: string } {
  if (typeof cursor !== 'string' || cursor.length > 128) throw new Error('Invalid office cursor');
  const parts = cursor.split('.');
  if (parts.length !== 3 || parts[0] !== 'v2') throw new Error('Invalid office cursor');
  const epoch = epochSchema.parse(parts[1]);
  const revision = revisionSchema.parse(parts[2]);
  if (encodeCursor({ epoch, revision }) !== cursor) throw new Error('Noncanonical office cursor');
  return { version: CONTRACT_VERSION, epoch, revision };
}
export const cursorSchema = z.string().max(128).refine(value => {
  try { decodeCursor(value); return true; } catch { return false; }
}, 'Invalid office cursor');

export const AGENT_STATES = ['IDLE', 'SEARCHING', 'ANALYZING', 'THINKING', 'CODING', 'TESTING', 'REVIEWING', 'WAITING', 'BLOCKED', 'SUCCESS', 'FAILED', 'SLEEP', 'UNKNOWN'] as const;
export const agentStateSchema = z.string().transform(value => AGENT_STATES.find(state => state === value) ?? 'UNKNOWN');
export const agentRoleSchema = z.enum(['CACADOR', 'DIRETOR', 'DESENVOLVEDOR', 'REVISOR', 'OUTRO']);
export const lifecycleStatusSchema = z.enum(['PROBATION', 'ACTIVE', 'SLEEP', 'ARCHIVED']);
export const qualitySchema = z.enum(['REPORTED', 'AMBIGUOUS', 'UNAVAILABLE']);
export const availabilitySchema = z.enum(['REPORTED', 'PAUSED', 'UNAVAILABLE']);
export const connectionSchema = z.enum(['DEMO', 'CONNECTING', 'LIVE', 'RECONNECTING', 'STALE', 'DISCONNECTED']);
export const currentTaskSchema = z.strictObject({
  id: publicIdSchema, objective: z.string().max(256), status: publicIdSchema,
  retryCount: z.number().int().nonnegative(), startedAt: timestampSchema.nullable(),
});
export const officeAgentSchema = z.strictObject({
  id: publicIdSchema, displayName: z.string().max(128), role: agentRoleSchema,
  responsibility: z.string().max(256), lifecycleStatus: lifecycleStatusSchema,
  state: agentStateSchema, stateSince: timestampSchema.nullable(),
  workstationId: publicIdSchema.optional(), currentTask: currentTaskSchema.nullable(),
  metadata: z.strictObject({ quality: qualitySchema, availability: availabilitySchema }).default({ quality: 'REPORTED', availability: 'REPORTED' }),
});
export const officeWorkstationSchema = z.strictObject({
  id: publicIdSchema, roomId: publicIdSchema, status: z.enum(['OCCUPIED', 'EMPTY']), assignedAgentId: publicIdSchema.nullable(),
}).refine(value => (value.status === 'EMPTY') === (value.assignedAgentId === null));
export const financialScopeSchema = z.strictObject({
  cashCents: z.number().int(), reserveCents: z.number().int(), operationsCents: z.number().int(), expansionCents: z.number().int(),
});
export const financialSchema = z.strictObject({ real: financialScopeSchema.nullable(), simulation: financialScopeSchema.nullable() });
export const breakerSchema = z.strictObject({ scopeType: z.enum(['SOURCE', 'AGENT']), scopeKey: publicIdSchema, state: z.enum(['CLOSED', 'OPEN', 'HALF_OPEN']) });
export const governanceSchema = z.strictObject({
  autonomyEnabled: z.boolean().nullable(), autoSpendEnabled: z.boolean().nullable(),
  emergencyStop: z.boolean().nullable(), circuitBreaker: z.enum(['CLOSED', 'OPEN', 'HALF_OPEN', 'PLANNED']).nullable(),
  breakers: z.array(breakerSchema).nullable().optional(), configurationSource: z.literal('API').optional(),
});
export const TIMELINE_TYPES = [
  'OPPORTUNITY_FOUND', 'OPPORTUNITY_VERIFYING', 'OPPORTUNITY_VERIFIED', 'OPPORTUNITY_EVALUATING', 'OPPORTUNITY_APPROVED', 'OPPORTUNITY_REJECTED',
  'TASK_CREATED', 'TASK_ASSIGNED', 'TASK_STARTED', 'TASK_WAITING_SLOT', 'TASK_COMPLETED', 'TASK_BLOCKED', 'AGENT_STATE_CHANGED', 'IMPLEMENTATION_READY',
  'REVIEW_STARTED', 'REVIEW_FAILED', 'REVIEW_PASSED', 'ACTION_BLOCKED', 'CIRCUIT_OPENED', 'CIRCUIT_HALF_OPEN', 'CIRCUIT_CLOSED',
  'EMERGENCY_STOP_ENGAGED', 'EMERGENCY_STOP_RELEASED', 'EMERGENCY_STOP_RECOMMENDED', 'EMERGENCY_QUIESCENCE_EXCEEDED',
  'WORK_PAUSED', 'WORK_RESUMED', 'AGENT_ACTIVATED', 'AGENT_WOKE', 'AGENT_SLEEP', 'RECOVERY_ACTION_TAKEN', 'RECONCILIATION_REPORTED',
] as const;
export const timelineEventSchema = z.strictObject({
  id: publicIdSchema, type: z.enum(TIMELINE_TYPES), occurredAt: timestampSchema,
  agentId: publicIdSchema.optional(), summary: z.string().max(256),
  // Compatibilidade da fixture DEMO; nunca preenchido pelo projector LIVE.
  untrustedExternal: z.string().max(4096).optional(),
});
export const metadataSchema = z.strictObject({
  observedAt: timestampSchema.nullable().default(null), connection: connectionSchema.default('DEMO'),
  sections: z.strictObject({ agents: qualitySchema, workstations: qualitySchema, financial: qualitySchema, governance: qualitySchema, timeline: qualitySchema })
    .default({ agents: 'REPORTED', workstations: 'REPORTED', financial: 'REPORTED', governance: 'REPORTED', timeline: 'REPORTED' }),
});
export const officeSnapshotSchema = z.strictObject({
  mode: z.enum(['DEMO', 'LIVE']), generatedAt: timestampSchema,
  agents: z.array(officeAgentSchema), workstations: z.array(officeWorkstationSchema),
  financial: financialSchema, governance: governanceSchema, timeline: z.array(timelineEventSchema).max(50),
  metadata: metadataSchema.prefault({}),
});
export const officeEnvelopeSchema = z.strictObject({
  contractVersion: z.literal(CONTRACT_VERSION), streamCursor: cursorSchema, revision: revisionSchema, snapshot: officeSnapshotSchema,
}).refine(value => decodeCursor(value.streamCursor).revision === value.revision, 'Cursor/revision mismatch');
/** Cada chave fornecida substitui a seção inteira. */
export const officeChangesSchema = officeSnapshotSchema.pick({ agents: true, workstations: true, financial: true, governance: true, timeline: true }).partial()
  .refine(value => Object.keys(value).length > 0, 'Empty changes');
export const fullResyncReasonSchema = z.enum(['VERSION_MISMATCH', 'INVALID_CURSOR', 'EPOCH_MISMATCH', 'CURSOR_EXPIRED', 'CURSOR_AHEAD', 'REVISION_GAP', 'UNAVAILABLE']);
export const officeStreamMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('SUBSCRIBE'), clientVersion: z.literal(CONTRACT_VERSION), afterCursor: cursorSchema }),
  z.strictObject({ type: z.literal('SYNC_START'), throughCursor: cursorSchema }),
  z.strictObject({ type: z.literal('OFFICE_UPDATED'), baseCursor: cursorSchema, cursor: cursorSchema, revision: revisionSchema, changes: officeChangesSchema }),
  z.strictObject({ type: z.literal('SYNC_COMPLETE'), cursor: cursorSchema }),
  z.strictObject({ type: z.literal('FULL_RESYNC_REQUIRED'), reason: fullResyncReasonSchema }),
  z.strictObject({ type: z.literal('HEARTBEAT'), metadata: z.strictObject({ observedAt: timestampSchema.nullable() }) }),
]).refine(message => {
  if (message.type !== 'OFFICE_UPDATED') return true;
  const base = decodeCursor(message.baseCursor);
  const next = decodeCursor(message.cursor);
  return base.epoch === next.epoch && next.revision === message.revision && BigInt(next.revision) === BigInt(base.revision) + 1n;
}, 'Nonconsecutive office update');

export type OfficeSnapshot = z.infer<typeof officeSnapshotSchema>;
export type OfficeEnvelope = z.infer<typeof officeEnvelopeSchema>;
export type OfficeStreamMessage = z.infer<typeof officeStreamMessageSchema>;
export type OfficeChanges = z.infer<typeof officeChangesSchema>;
export type OfficeAgent = z.infer<typeof officeAgentSchema>;
export type OfficeWorkstation = z.infer<typeof officeWorkstationSchema>;
export type OfficeTimelineEvent = z.infer<typeof timelineEventSchema>;
export type FinancialScopeSnapshot = z.infer<typeof financialScopeSchema>;
export type OfficeGovernance = z.infer<typeof governanceSchema>;
export type AgentRole = z.infer<typeof agentRoleSchema>;
export type AgentState = z.infer<typeof agentStateSchema>;
export type AgentLifecycleStatus = z.infer<typeof lifecycleStatusSchema>;
