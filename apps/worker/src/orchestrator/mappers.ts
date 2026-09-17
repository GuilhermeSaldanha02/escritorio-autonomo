import type { GovernedCapability } from '@escritorio/governor';
import type { DeveloperTask, OpportunityFound } from '@escritorio/agents';

export interface OpportunityRow {
  id: string;
  source: string;
  source_url: string;
  title: string;
  reward_amount: string | null;
  reward_currency: string | null;
  reward_verified: boolean;
  requirements: string[];
  deadline: Date | null;
  ai_allowed: boolean | null;
  automation_allowed: boolean | null;
  payment_method: string | null;
  evidence: string[];
  confidence: string | null;
  status: string;
  required_capabilities: string[];
}

/**
 * A tabela `opportunities` permite campos nulos que o contrato §13.1 exige
 * (o Caçador real, M4, é quem vai garanti-los na origem). Para o Diretor
 * mock decidir sobre uma linha do banco, valores ausentes viram o padrão
 * mais conservador (ex.: automation_allowed nulo -> false -> REJECT).
 */
export function opportunityRowToContract(row: OpportunityRow): OpportunityFound {
  return {
    source: row.source,
    source_url: row.source_url,
    title: row.title,
    reward: { amount: Number(row.reward_amount ?? 0), currency: row.reward_currency ?? 'BRL' },
    reward_verified: row.reward_verified,
    requirements: row.requirements,
    ai_allowed: row.ai_allowed ?? false,
    automation_allowed: row.automation_allowed ?? false,
    payment_method: row.payment_method ?? 'desconhecido',
    evidence: row.evidence,
    confidence: Number(row.confidence ?? 0),
  };
}

export function opportunityRequiredCapabilities(row: OpportunityRow): GovernedCapability[] {
  return row.required_capabilities as GovernedCapability[];
}

export interface TaskRow {
  id: string;
  opportunity_id: string | null;
  objective: string;
  acceptance_criteria: string[];
  allowed_tools: string[];
  status: string;
  retry_count: number;
  max_cost_brl: string;
  max_runtime_minutes: number | null;
}

/**
 * `repository`/`branch` não existem no schema de `tasks` (§13.3 pressupõe um
 * repositório real, que só chega com o Desenvolvedor de verdade — fora do
 * escopo do M2). Sintetizados aqui só para satisfazer o contrato; nunca
 * persistidos nem usados fora do transporte para o Desenvolvedor mock.
 */
export function taskRowToContract(row: TaskRow): DeveloperTask {
  return {
    task_id: row.id,
    objective: row.objective,
    repository: 'mock://local',
    branch: `mock/task-${row.id}`,
    acceptance_criteria: row.acceptance_criteria.length > 0 ? row.acceptance_criteria : ['critério padrão do mock'],
    allowed_tools: row.allowed_tools,
    max_cost: Number(row.max_cost_brl),
    max_runtime_minutes: row.max_runtime_minutes ?? 30,
  };
}
