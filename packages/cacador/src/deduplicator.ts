import { type Pool, type Queryable, withTransaction } from '@escritorio/database';
import type { AutomationPolicyStatus, EligibilityStatus } from './promotion-policy.js';
import { toLegacyRewardVerified, type RewardStatus } from './reward-status.js';
import type { TrustLevel } from './source-connector.js';

/**
 * Deduplicação por identidade em camadas (M4-PLANO.md): `source+externalId` é
 * a identidade forte quando a fonte fornece um id estável; `canonicalUrl` e
 * `targetIdentity` são as camadas seguintes; `content_fingerprint` nunca é
 * identidade primária, só sinal auxiliar. Pelo menos uma das três precisa
 * existir — sem identidade nenhuma, não há como decidir com segurança se é
 * a mesma oportunidade.
 */
export interface DiscoveredOpportunityInput {
  source: string;
  sourceUrl: string;
  title: string;
  externalId?: string;
  canonicalUrl?: string;
  targetIdentity?: string;
  contentFingerprint?: string;
  /** Hash do normalizedContent — muda quando o conteúdo muda; identifica revisão vs. re-descoberta. */
  contentHash: string;
  sourceUpdatedAt?: string;
  rewardAmount?: number;
  rewardCurrency?: string;
  rewardStatus: RewardStatus;
  rewardSource?: string;
  paymentMethod?: string;
  paymentConditions?: string;
  eligibilityStatus?: EligibilityStatus;
  automationPolicyStatus?: AutomationPolicyStatus;
  verifiedAt?: string;
  aiAllowed?: boolean;
  automationAllowed?: boolean;
  confidence?: number;
  trustLevel: TrustLevel;
  rawExternalContent: string;
  normalizedContent: string;
  rawHash: string;
}

export type DeduplicationOutcome = 'CREATED' | 'SEEN_AGAIN' | 'REVISED' | 'IDENTITY_MISSING';

export interface DeduplicationResult {
  outcome: DeduplicationOutcome;
  opportunityId?: string;
}

interface OpportunityIdentityRow {
  id: string;
  content_hash: string | null;
}

/** Mesma identidade lógica sempre serializa no mesmo advisory lock — nunca um lock global por tabela. */
function identityKey(input: DiscoveredOpportunityInput): string | undefined {
  const identity = input.externalId ?? input.canonicalUrl ?? input.targetIdentity;
  return identity ? `${input.source}:${identity}` : undefined;
}

async function findByLayeredIdentity(tx: Queryable, input: DiscoveredOpportunityInput): Promise<OpportunityIdentityRow | undefined> {
  const { rows } = await tx.query<OpportunityIdentityRow>(
    `SELECT id, content_hash FROM opportunities
      WHERE source = $1
        AND (
          (external_id IS NOT NULL AND external_id = $2)
          OR (canonical_url IS NOT NULL AND canonical_url = $3)
          OR (target_identity IS NOT NULL AND target_identity = $4)
        )
      LIMIT 1`,
    [input.source, input.externalId ?? null, input.canonicalUrl ?? null, input.targetIdentity ?? null],
  );
  return rows[0];
}

/**
 * Descobre-ou-revisiona uma oportunidade de forma atômica (critério 10 do M4
 * — mesma disciplina do `pg_advisory_xact_lock` do orçamento no M3). Duas
 * descobertas concorrentes da MESMA identidade serializam nesta transação:
 * a segunda só lê o estado real depois que a primeira já commitou.
 */
export async function deduplicateOpportunity(pool: Pool, input: DiscoveredOpportunityInput): Promise<DeduplicationResult> {
  const key = identityKey(input);
  if (!key) return { outcome: 'IDENTITY_MISSING' };

  return withTransaction(pool, async (tx) => {
    // Serializa por identidade — nenhuma outra descoberta da MESMA identidade
    // lê "existe ou não" enquanto esta transação não terminar (mesma
    // disciplina do pg_advisory_xact_lock do orçamento no M3).
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);

    const existing = await findByLayeredIdentity(tx, input);
    const rewardVerified = toLegacyRewardVerified(input.rewardStatus);

    if (!existing) {
      try {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO opportunities (
             source, source_url, title, reward_amount, reward_currency, reward_verified,
             payment_method, confidence, ai_allowed, automation_allowed,
             reward_status, reward_source, payment_conditions, eligibility_status, automation_policy_status, verified_at,
             external_id, canonical_url, target_identity, content_fingerprint, content_hash,
             source_updated_at, last_seen_at, trust_level, raw_external_content, normalized_content, raw_hash
           ) VALUES (
             $1, $2, $3, $4, $5, $6,
             $7, $8, $9, $10,
             $11, $12, $13, $14, $15, $16,
             $17, $18, $19, $20, $21,
             $22, clock_timestamp(), $23, $24, $25, $26
           ) RETURNING id`,
          [
            input.source,
            input.sourceUrl,
            input.title,
            input.rewardAmount ?? null,
            input.rewardCurrency ?? null,
            rewardVerified,
            input.paymentMethod ?? null,
            input.confidence ?? null,
            input.aiAllowed ?? null,
            input.automationAllowed ?? null,
            input.rewardStatus,
            input.rewardSource ?? null,
            input.paymentConditions ?? null,
            input.eligibilityStatus ?? 'UNKNOWN',
            input.automationPolicyStatus ?? 'UNKNOWN',
            input.verifiedAt ?? null,
            input.externalId ?? null,
            input.canonicalUrl ?? null,
            input.targetIdentity ?? null,
            input.contentFingerprint ?? null,
            input.contentHash,
            input.sourceUpdatedAt ?? null,
            input.trustLevel,
            input.rawExternalContent,
            input.normalizedContent,
            input.rawHash,
          ],
        );
        return { outcome: 'CREATED', opportunityId: rows[0]!.id };
      } catch (error) {
        // Segunda camada de defesa (mesmo padrão do model_calls no M3): o
        // advisory lock por identidade já deveria impedir isto, mas o índice
        // único (source, external_id) é o backstop de verdade — se ele
        // rejeitar por conflito, trata como "alguém já descobriu primeiro"
        // em vez de propagar um erro cru de Postgres para quem chamou.
        if ((error as { code?: string }).code === '23505') {
          const winner = await findByLayeredIdentity(tx, input);
          if (winner) return { outcome: 'SEEN_AGAIN', opportunityId: winner.id };
        }
        throw error;
      }
    }

    if (existing.content_hash === input.contentHash) {
      await tx.query(`UPDATE opportunities SET last_seen_at = clock_timestamp() WHERE id = $1`, [existing.id]);
      return { outcome: 'SEEN_AGAIN', opportunityId: existing.id };
    }

    await tx.query(
      `UPDATE opportunities SET
         reward_amount = $2, reward_currency = $3, reward_verified = $4,
         payment_method = $5, confidence = $6, ai_allowed = $7, automation_allowed = $8,
         reward_status = $9, reward_source = $10, payment_conditions = $11,
         eligibility_status = $12, automation_policy_status = $13, verified_at = $14,
         content_fingerprint = $15, content_hash = $16, source_updated_at = $17,
         last_seen_at = clock_timestamp(), raw_external_content = $18, normalized_content = $19, raw_hash = $20
       WHERE id = $1`,
      [
        existing.id,
        input.rewardAmount ?? null,
        input.rewardCurrency ?? null,
        rewardVerified,
        input.paymentMethod ?? null,
        input.confidence ?? null,
        input.aiAllowed ?? null,
        input.automationAllowed ?? null,
        input.rewardStatus,
        input.rewardSource ?? null,
        input.paymentConditions ?? null,
        input.eligibilityStatus ?? 'UNKNOWN',
        input.automationPolicyStatus ?? 'UNKNOWN',
        input.verifiedAt ?? null,
        input.contentFingerprint ?? null,
        input.contentHash,
        input.sourceUpdatedAt ?? null,
        input.rawExternalContent,
        input.normalizedContent,
        input.rawHash,
      ],
    );
    return { outcome: 'REVISED', opportunityId: existing.id };
  });
}
