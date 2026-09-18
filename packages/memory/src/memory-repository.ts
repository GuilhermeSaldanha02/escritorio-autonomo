import type { Pool } from '@escritorio/database';
import type { EmbeddingProvider } from './embedding-provider.js';
import { type MemoryProposal, validateMemoryProposal } from './memory-validator.js';

export type MemoryTrustLevel = 'INTERNAL' | 'UNTRUSTED_EXTERNAL';

/** Escopo de uma memória (ou de uma consulta). Campo ausente = sem restrição naquele eixo. */
export interface MemoryScope {
  agentId?: string;
  taskId?: string;
  capability?: string;
}

export interface StoreMemoryOptions {
  scope?: MemoryScope;
  trustLevel: MemoryTrustLevel;
}

export type StoreMemoryResult =
  | { status: 'STORED'; memoryId: string }
  | { status: 'ALREADY_STORED'; memoryId: string }
  | { status: 'REJECTED'; reason: string };

export interface MemoryMatch {
  id: string;
  experienceId: string;
  content: string;
  confidence: number;
  trustLevel: MemoryTrustLevel;
  distance: number;
}

export interface SearchMemoriesOptions {
  /** Escopo do consultante: só enxerga memórias sem restrição ou restritas a ESTE escopo. */
  scope?: MemoryScope;
  k?: number;
  /** Conteúdo UNTRUSTED_EXTERNAL nunca é devolvido como conhecimento da empresa, salvo pedido explícito. */
  includeUntrusted?: boolean;
}

function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

/**
 * Grava uma memória corporativa — só se o `MemoryValidator` aceitar (critério
 * 5: experiência nunca vira memória sozinha). Guarda proveniência (experiência
 * de origem), confiança, nível de confiança da origem e a identidade do
 * embedding (provider/model/version/dimensions — critério 9). Reentrega da
 * mesma proposta devolve a memória existente (índice único de deduplicação).
 */
export async function storeMemory(
  pool: Pool,
  provider: EmbeddingProvider,
  proposal: MemoryProposal,
  options: StoreMemoryOptions,
): Promise<StoreMemoryResult> {
  const verdict = validateMemoryProposal(proposal);
  if (verdict.status === 'REJECTED') return { status: 'REJECTED', reason: verdict.reason ?? 'rejeitada' };

  const embedding = provider.embed(proposal.content);
  const scope = options.scope ?? {};

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO memories (experience_id, content, confidence, source, scope_agent_id, scope_capability, scope_task_id,
                           trust_level, embedding, embedding_provider, embedding_model, embedding_version, embedding_dimensions)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, $10, $11, $12, $13)
     ON CONFLICT (experience_id, md5(content), COALESCE(scope_agent_id, ''), COALESCE(scope_capability, ''), COALESCE(scope_task_id::text, ''))
     DO NOTHING
     RETURNING id`,
    [
      proposal.experienceId,
      proposal.content,
      proposal.confidence,
      proposal.source,
      scope.agentId ?? null,
      scope.capability ?? null,
      scope.taskId ?? null,
      options.trustLevel,
      toVectorLiteral(embedding.vector),
      embedding.provider,
      embedding.model,
      embedding.version,
      embedding.dimensions,
    ],
  );
  if (inserted.rows[0]) return { status: 'STORED', memoryId: inserted.rows[0].id };

  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM memories
      WHERE experience_id = $1 AND md5(content) = md5($2)
        AND COALESCE(scope_agent_id, '') = $3 AND COALESCE(scope_capability, '') = $4 AND COALESCE(scope_task_id::text, '') = $5`,
    [proposal.experienceId, proposal.content, scope.agentId ?? '', scope.capability ?? '', scope.taskId ?? ''],
  );
  return { status: 'ALREADY_STORED', memoryId: existing.rows[0]!.id };
}

/**
 * Recuperação top-K por distância de cosseno (`<=>`, operador do pgvector —
 * critérios 8 a 10). Só compara vetores do MESMO espaço (provider/model/
 * version/dimensions iguais ao do consultante) e só devolve memórias visíveis
 * ao escopo pedido: uma memória restrita a outro agente/task/capability nunca
 * vaza.
 *
 * A busca é exata, não aproximada: não há índice ANN sobre `embedding`. Um
 * ivfflat truncaria o top-K silenciosamente (medido: 53 de 300 linhas com o
 * padrão), e o desempate por `id` que torna a ordem determinística o
 * impediria de ser usado de qualquer forma. Indexação aproximada fica para
 * quando houver volume e um EmbeddingProvider real.
 */
export async function searchMemories(
  pool: Pool,
  provider: EmbeddingProvider,
  queryText: string,
  options: SearchMemoriesOptions = {},
): Promise<MemoryMatch[]> {
  const scope = options.scope ?? {};
  const query = provider.embed(queryText);

  const { rows } = await pool.query<{
    id: string;
    experience_id: string;
    content: string;
    confidence: string;
    trust_level: MemoryTrustLevel;
    distance: string;
  }>(
    `SELECT id, experience_id, content, confidence::text, trust_level, (embedding <=> $1::vector)::text AS distance
       FROM memories
      WHERE embedding_provider = $2 AND embedding_model = $3 AND embedding_version = $4 AND embedding_dimensions = $5
        AND (scope_agent_id IS NULL OR scope_agent_id = $6)
        AND (scope_capability IS NULL OR scope_capability = $7)
        AND (scope_task_id IS NULL OR scope_task_id = $8)
        AND ($9::boolean OR trust_level = 'INTERNAL')
      ORDER BY embedding <=> $1::vector, id
      LIMIT $10`,
    [
      toVectorLiteral(query.vector),
      query.provider,
      query.model,
      query.version,
      query.dimensions,
      scope.agentId ?? null,
      scope.capability ?? null,
      scope.taskId ?? null,
      options.includeUntrusted ?? false,
      options.k ?? 5,
    ],
  );
  return rows.map((row) => ({
    id: row.id,
    experienceId: row.experience_id,
    content: row.content,
    confidence: Number(row.confidence),
    trustLevel: row.trust_level,
    distance: Number(row.distance),
  }));
}
