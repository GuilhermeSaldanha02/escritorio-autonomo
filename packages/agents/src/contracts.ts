import { z } from 'zod';
import { GOVERNED_CAPABILITY_NAMES } from '@escritorio/governor';

/**
 * Contratos dos agentes (especificação §13). São o formato de payload que
 * cada evento carrega — validados aqui, persistidos pelo Event Bus.
 */

// --- 13.1 Caçador ---------------------------------------------------------

export const opportunityFoundSchema = z
  .object({
    source: z.string().min(1),
    source_url: z.url(),
    title: z.string().min(1).max(280),
    reward: z.object({ amount: z.number().min(0), currency: z.string().length(3) }).strict(),
    reward_verified: z.boolean(),
    requirements: z.array(z.string().min(1)),
    deadline: z.iso.datetime().optional(),
    ai_allowed: z.boolean(),
    automation_allowed: z.boolean(),
    payment_method: z.string().min(1),
    evidence: z.array(z.string().min(1)),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type OpportunityFound = z.infer<typeof opportunityFoundSchema>;

// --- 13.2 Diretor ----------------------------------------------------------

export const DIRECTOR_DECISIONS = ['REJECT', 'BACKLOG', 'INVESTIGATE', 'EXECUTE'] as const;
export type DirectorDecisionKind = (typeof DIRECTOR_DECISIONS)[number];

export const directorDecisionSchema = z
  .object({
    decision: z.enum(DIRECTOR_DECISIONS),
    score: z.number().min(0).max(1),
    estimated_cost: z.number().min(0),
    estimated_runtime_minutes: z.number().min(0),
    risk: z.enum(['LOW', 'MEDIUM', 'HIGH']),
    reasoning_summary: z.string().min(1),
    required_capabilities: z.array(z.enum(GOVERNED_CAPABILITY_NAMES)),
  })
  .strict();
export type DirectorDecision = z.infer<typeof directorDecisionSchema>;

// --- 13.3 Desenvolvedor ------------------------------------------------------

export const developerTaskSchema = z
  .object({
    task_id: z.uuid(),
    objective: z.string().min(1),
    repository: z.string().min(1),
    branch: z.string().min(1),
    acceptance_criteria: z.array(z.string().min(1)).min(1),
    allowed_tools: z.array(z.string().min(1)),
    max_cost: z.number().min(0),
    max_runtime_minutes: z.number().positive(),
  })
  .strict();
export type DeveloperTask = z.infer<typeof developerTaskSchema>;

export const implementationReadySchema = z
  .object({
    changed_files: z.array(z.string().min(1)),
    diff: z.string(),
    tests: z.object({ total: z.number().int().min(0), passed: z.number().int().min(0), failed: z.number().int().min(0) }).strict(),
    build: z.boolean(),
    elapsed_time: z.number().min(0),
    cost: z.number().min(0),
    dependencies_added: z.array(z.string().min(1)),
    notes: z.string(),
    /**
     * Extensao ao parag. 13.3 original (decisao registrada em docs/M2-PLANO.md):
     * o Revisor precisa reconstruir o estado candidato numa sandbox nova e
     * independente. O diff sozinho nao basta (a imagem de sandbox nao tem
     * git/patch nem rede) -- o transporte real e o snapshot de arquivos
     * pos-mudanca, com hash para o Revisor provar que analisou exatamente
     * o artefato que saiu do Desenvolvedor. O diff continua existindo so
     * como auditoria.
     */
    resulting_files: z.record(z.string().min(1), z.string()),
    resulting_snapshot_hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type ImplementationReady = z.infer<typeof implementationReadySchema>;

// --- 13.4 Revisor -----------------------------------------------------------

export const reviewCompletedSchema = z
  .object({
    decision: z.enum(['PASSED', 'FAILED']),
    build: z.boolean(),
    tests: z.object({ total: z.number().int().min(0), passed: z.number().int().min(0), failed: z.number().int().min(0) }).strict(),
    requirements: z.array(z.object({ description: z.string().min(1), met: z.boolean() }).strict()),
    security_flags: z.array(z.string().min(1)),
    reason: z.string().min(1),
  })
  .strict();
export type ReviewCompleted = z.infer<typeof reviewCompletedSchema>;
