import type { AgentRole } from '@escritorio/shared';
import type { Queryable } from './pool.js';

export interface InitialAgent {
  id: string;
  role: AgentRole;
  displayName: string;
  responsibility: string;
}

/** Os quatro agentes fundadores (especificação §6). Sem IA no M1: só identidade persistente. */
export const INITIAL_AGENTS: readonly InitialAgent[] = [
  {
    id: 'CACADOR-001',
    role: 'CACADOR',
    displayName: 'Caçador',
    responsibility: 'Pesquisar e verificar oportunidades públicas',
  },
  {
    id: 'DIRETOR-001',
    role: 'DIRETOR',
    displayName: 'Diretor',
    responsibility: 'Priorizar, rejeitar/aprovar e criar tarefas',
  },
  {
    id: 'DESENVOLVEDOR-001',
    role: 'DESENVOLVEDOR',
    displayName: 'Desenvolvedor',
    responsibility: 'Executar tarefas técnicas em sandbox',
  },
  {
    id: 'REVISOR-001',
    role: 'REVISOR',
    displayName: 'Revisor',
    responsibility: 'Validar independentemente implementações',
  },
];

/**
 * Idempotente: roda quantas vezes for preciso e nunca sobrescreve o estado
 * que um agente já tenha acumulado. Devolve só os ids realmente inseridos.
 */
export async function seedInitialAgents(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agents (id, role, display_name, responsibility, lifecycle_status, state)
     SELECT id, role, display_name, responsibility, 'ACTIVE', 'IDLE'
       FROM jsonb_to_recordset($1::jsonb)
         AS seed(id text, role text, display_name text, responsibility text)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [
      JSON.stringify(
        INITIAL_AGENTS.map((agent) => ({
          id: agent.id,
          role: agent.role,
          display_name: agent.displayName,
          responsibility: agent.responsibility,
        })),
      ),
    ],
  );
  return rows.map((row) => row.id);
}
