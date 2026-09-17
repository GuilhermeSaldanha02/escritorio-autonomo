import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { GOVERNED_CAPABILITY_NAMES } from '@escritorio/governor';

export const QUEUE_NAMES = { SYSTEM: 'system', ORCHESTRATOR: 'orchestrator' } as const;
export const JOB_NAMES = {
  DIAGNOSTIC: 'diagnostic',
  // Um job por transição do ciclo (§8.1 / revisão externa do M2): cada
  // handler faz sua transição atômica e enfileira o próximo passo, nunca o
  // ciclo inteiro num job só — um crash retoma do outbox, não perde a task.
  DECIDE_OPPORTUNITY: 'decide-opportunity',
  DEVELOP_TASK: 'develop-task',
  REVIEW_TASK: 'review-task',
} as const;

export const diagnosticJobSchema = z
  .object({
    requestEventId: z.uuid(),
    correlationId: z.uuid(),
    message: z.string().min(1).max(280),
    /** Tempo que o job de diagnóstico leva para concluir — usado para provar encerramento gracioso. */
    durationMs: z.number().int().min(0).max(5_000).optional(),
    requestedCapability: z.enum(GOVERNED_CAPABILITY_NAMES).optional(),
  })
  .strict();
export type DiagnosticJobData = z.infer<typeof diagnosticJobSchema>;

/** Cada job do Orquestrador só carrega o id da entidade — o handler lê o estado atual do banco, nunca confia em dado velho do payload. */
export const decideOpportunityJobSchema = z.object({ opportunityId: z.uuid(), correlationId: z.uuid() }).strict();
export type DecideOpportunityJobData = z.infer<typeof decideOpportunityJobSchema>;

export const developTaskJobSchema = z.object({ taskId: z.uuid(), correlationId: z.uuid() }).strict();
export type DevelopTaskJobData = z.infer<typeof developTaskJobSchema>;

export const reviewTaskJobSchema = z.object({ taskId: z.uuid(), correlationId: z.uuid() }).strict();
export type ReviewTaskJobData = z.infer<typeof reviewTaskJobSchema>;

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

/** Todas as filas conhecidas, por nome — o que o `OutboxDispatcher` usa para publicar. */
export function createQueues(connection: Redis, prefix: string): Map<string, Queue> {
  return new Map(Object.values(QUEUE_NAMES).map((name) => [name, new Queue(name, { connection, prefix })]));
}
