import { z } from 'zod';
import { GOVERNED_CAPABILITY_NAMES } from '@escritorio/governor';
import type { JsonObject } from '@escritorio/shared';

/**
 * Catálogo de eventos (especificação §8.2). Todos já são aceitos pelo store;
 * só os que o M1 emite têm payload validado. Os demais ganham esquema quando
 * o milestone que os emite for implementado.
 */
export const EVENT_TYPES = [
  'OPPORTUNITY_FOUND',
  'OPPORTUNITY_VERIFYING',
  'OPPORTUNITY_VERIFIED',
  'OPPORTUNITY_EVALUATING',
  'OPPORTUNITY_APPROVED',
  'OPPORTUNITY_REJECTED',
  'TASK_CREATED',
  'TASK_ASSIGNED',
  'TASK_STARTED',
  'TASK_WAITING_SLOT',
  'TASK_COMPLETED',
  'TASK_BLOCKED',
  'AGENT_STATE_CHANGED',
  'AI_CALL_RECORDED',
  'TOOL_CALL_RECORDED',
  'IMPLEMENTATION_READY',
  'REVIEW_STARTED',
  'REVIEW_FAILED',
  'REVIEW_PASSED',
  'SUBMISSION_READY',
  'ACTION_BLOCKED',
  'BUDGET_EXHAUSTED',
  'CIRCUIT_OPENED',
  // M6 (docs/M6-PLANO.md): autonomia. Só o Emergency Stop de um humano gera
  // ENGAGED/RELEASED; componentes determinísticos só podem RECOMENDAR.
  'CIRCUIT_HALF_OPEN',
  'CIRCUIT_CLOSED',
  'EMERGENCY_STOP_ENGAGED',
  'EMERGENCY_STOP_RELEASED',
  'EMERGENCY_STOP_RECOMMENDED',
  'SCHEDULE_TICK_DISPATCHED',
  'SCHEDULE_TICK_SKIPPED',
  'RECONCILIATION_REPORTED',
  'WORK_PAUSED',
  'WORK_RESUMED',
  'RECOVERY_ACTION_TAKEN',
  'AGENT_ACTIVATED',
  'AGENT_WOKE',
  'PAYMENT_CONFIRMED',
  'AGENT_CREATION_REQUESTED',
  'AGENT_CREATED',
  'AGENT_SLEEP',
  'AGENT_ARCHIVED',
  // Diagnóstico do M1: prova que um job atravessa API → fila → Worker → banco.
  'TEST_JOB_REQUESTED',
  'TEST_JOB_COMPLETED',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];
export const eventTypeSchema = z.enum(EVENT_TYPES);

const jsonObject = z.record(z.string(), z.json());

export const EVENT_PAYLOAD_SCHEMAS = {
  TEST_JOB_REQUESTED: z
    .object({
      message: z.string().min(1).max(280),
      durationMs: z.number().int().min(0).max(5_000).optional(),
      requestedCapability: z.enum(GOVERNED_CAPABILITY_NAMES).optional(),
    })
    .strict(),
  TEST_JOB_COMPLETED: z
    .object({
      jobId: z.string().min(1),
      message: z.string(),
      attempt: z.number().int().min(1),
      workerPid: z.number().int(),
    })
    .strict(),
  ACTION_BLOCKED: z
    .object({
      rule: z.string().min(1),
      reason: z.string().min(1),
      action: jsonObject,
      source: z.object({ queue: z.string(), jobId: z.string() }).strict(),
    })
    .strict(),
  // Revisão externa do M2 (fechamento): negativa temporária do Governor em
  // TASK_START é espera operacional, não falha — este evento não muda o
  // status da task (continua ASSIGNED) e não consome MAX_TASK_RETRIES.
  TASK_WAITING_SLOT: z
    .object({
      rule: z.string().min(1),
      reason: z.string().min(1),
      runningTasks: z.number().int().min(0),
    })
    .strict(),
} satisfies Partial<Record<EventType, z.ZodType>>;

type SchemaMap = typeof EVENT_PAYLOAD_SCHEMAS;
export type EventPayload<T extends EventType> = T extends keyof SchemaMap ? z.infer<SchemaMap[T]> : JsonObject;
