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
  'OPPORTUNITY_VERIFIED',
  'OPPORTUNITY_REJECTED',
  'TASK_CREATED',
  'TASK_ASSIGNED',
  'TASK_STARTED',
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
} satisfies Partial<Record<EventType, z.ZodType>>;

type SchemaMap = typeof EVENT_PAYLOAD_SCHEMAS;
export type EventPayload<T extends EventType> = T extends keyof SchemaMap ? z.infer<SchemaMap[T]> : JsonObject;
