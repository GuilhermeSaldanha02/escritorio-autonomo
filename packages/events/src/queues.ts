import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { GOVERNED_CAPABILITY_NAMES } from '@escritorio/governor';

export const QUEUE_NAMES = { SYSTEM: 'system' } as const;
export const JOB_NAMES = { DIAGNOSTIC: 'diagnostic' } as const;

export const diagnosticJobSchema = z
  .object({
    requestEventId: z.uuid(),
    correlationId: z.uuid(),
    message: z.string().min(1).max(280),
    requestedCapability: z.enum(GOVERNED_CAPABILITY_NAMES).optional(),
  })
  .strict();
export type DiagnosticJobData = z.infer<typeof diagnosticJobSchema>;

/**
 * Produtor (API) falha rápido quando o Redis cai, para o /health e as rotas
 * responderem em vez de pendurar. Consumidor (Worker) espera o Redis voltar:
 * é o padrão exigido pelo BullMQ para Workers.
 */
export function createRedisConnection(url: string, role: 'producer' | 'consumer', name: string): Redis {
  return new Redis(url, {
    connectionName: name,
    maxRetriesPerRequest: role === 'consumer' ? null : 1,
    enableOfflineQueue: role === 'consumer',
  });
}

export function createSystemQueue(connection: Redis, prefix: string): Queue {
  return new Queue(QUEUE_NAMES.SYSTEM, { connection, prefix });
}
