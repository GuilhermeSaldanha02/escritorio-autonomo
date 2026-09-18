import type { Pool } from '@escritorio/database';
import { deduplicateOpportunity, type DeduplicationOutcome } from './deduplicator.js';
import type { GitHubIssuePayload } from './github-evidence.js';
import { extractGitHubEvidence } from './github-evidence.js';
import { sha256Hex } from './hash.js';
import { normalizeCandidate, type NormalizerOptions } from './normalizer.js';
import { canPromoteToOpportunityFound } from './promotion-policy.js';
import type { RewardStatus } from './reward-status.js';
import type { SourceConnector, SourceDiscoveryStatus } from './source-connector.js';
import { verifyReward } from './verifier.js';

export interface DiscoveryCycleDeps {
  pool: Pool;
  connector: SourceConnector;
  normalizerOptions?: NormalizerOptions;
}

export type DiscoveryCycleItemOutcome =
  | { kind: 'PROMOTED'; opportunityId: string; dedup: DeduplicationOutcome; rewardStatus: RewardStatus }
  | { kind: 'STORED_NOT_PROMOTED'; opportunityId: string; dedup: DeduplicationOutcome; rewardStatus: RewardStatus }
  | { kind: 'SKIPPED'; reason: string };

export interface DiscoveryCycleResult {
  sourceStatus: SourceDiscoveryStatus;
  items: DiscoveryCycleItemOutcome[];
  retryAfterMs?: number;
  sourceError?: string;
}

/**
 * Um ciclo completo do Caçador (M4-PLANO.md):
 * SourceConnector → RawCandidate → Normalizer → Deduplicator → Verifier →
 * Promotion Policy. Emitir `OPPORTUNITY_FOUND` e disparar o job
 * `decide-opportunity` fica para a integração com o Orquestrador (passo
 * seguinte) — esta função só decide e persiste, não publica evento.
 *
 * Falha da fonte (rate limit, indisponibilidade, schema drift) interrompe o
 * ciclo inteiro e devolve o estado, em vez de processar parcialmente e
 * esconder o problema.
 */
export async function runDiscoveryCycle(deps: DiscoveryCycleDeps): Promise<DiscoveryCycleResult> {
  const discovery = await deps.connector.discover();
  if (discovery.status !== 'OK') {
    return { sourceStatus: discovery.status, items: [], retryAfterMs: discovery.retryAfterMs, sourceError: discovery.error };
  }

  const items: DiscoveryCycleItemOutcome[] = [];
  for (const raw of discovery.candidates) {
    const normalized = normalizeCandidate(raw, deps.normalizerOptions);
    if (normalized.status !== 'OK') {
      items.push({ kind: 'SKIPPED', reason: 'SOURCE_PAYLOAD_TOO_LARGE' });
      continue;
    }

    let issue: GitHubIssuePayload;
    try {
      issue = JSON.parse(normalized.rawExternalContent) as GitHubIssuePayload;
    } catch {
      items.push({ kind: 'SKIPPED', reason: 'conteúdo do candidato não é JSON interpretável' });
      continue;
    }

    const evidence = extractGitHubEvidence(issue);
    const rewardStatus = verifyReward(evidence.checks);

    const dedupResult = await deduplicateOpportunity(deps.pool, {
      source: normalized.source,
      sourceUrl: normalized.url,
      title: issue.title ?? normalized.url,
      externalId: normalized.externalId,
      canonicalUrl: normalized.url,
      contentHash: sha256Hex(normalized.normalizedContent),
      sourceUpdatedAt: normalized.sourceUpdatedAt,
      rewardStatus,
      rewardAmount: evidence.rewardAmount,
      rewardCurrency: evidence.rewardCurrency,
      eligibilityStatus: evidence.eligibilityStatus,
      automationPolicyStatus: evidence.automationPolicyStatus,
      // Compatibilidade com o contrato legado M1-M3 (decide() do Diretor lê
      // estas duas colunas, não automationPolicyStatus): omitir deixaria NULL,
      // e opportunity-handler.ts trata NULL como INVALID antes do Diretor ver
      // a oportunidade. Mesma regra de "UNKNOWN nunca é permissão": só ALLOWED
      // vira true.
      aiAllowed: evidence.automationPolicyStatus === 'ALLOWED',
      automationAllowed: evidence.automationPolicyStatus === 'ALLOWED',
      trustLevel: normalized.trustLevel,
      rawExternalContent: normalized.rawExternalContent,
      normalizedContent: normalized.normalizedContent,
      rawHash: normalized.rawHash,
    });

    if (dedupResult.outcome === 'IDENTITY_MISSING') {
      items.push({ kind: 'SKIPPED', reason: 'IDENTITY_MISSING' });
      continue;
    }

    const canPromote = canPromoteToOpportunityFound({
      rewardStatus,
      eligibilityStatus: evidence.eligibilityStatus,
      automationPolicyStatus: evidence.automationPolicyStatus,
    });
    items.push({
      kind: canPromote ? 'PROMOTED' : 'STORED_NOT_PROMOTED',
      opportunityId: dedupResult.opportunityId!,
      dedup: dedupResult.outcome,
      rewardStatus,
    });
  }

  return { sourceStatus: 'OK', items };
}
