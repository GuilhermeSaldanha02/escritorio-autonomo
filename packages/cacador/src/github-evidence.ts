import type { AutomationPolicyStatus, EligibilityStatus } from './promotion-policy.js';
import type { RewardVerificationChecks } from './verifier.js';

/**
 * Formato mínimo de uma issue do GitHub que o extrator precisa — subconjunto
 * do que `GET /search/issues` devolve, já desserializado do JSON bruto do
 * `RawCandidate`.
 */
export interface GitHubIssuePayload {
  title?: string;
  body?: string | null;
  state?: string;
  labels?: Array<{ name?: string } | string>;
  html_url?: string;
  repository_url?: string;
  node_id?: string;
}

export interface GitHubEvidenceResult {
  checks: RewardVerificationChecks;
  eligibilityStatus: EligibilityStatus;
  automationPolicyStatus: AutomationPolicyStatus;
  rewardAmount?: number;
  rewardCurrency?: string;
}

const BOUNTY_LABEL_PATTERN = /bounty/i;
const BOUNTY_COMMAND_PATTERN = /\/bounty\s+\$?[\d,.]+/i;
const ALGORA_REFERENCE_PATTERN = /algora\.io/i;
const AMOUNT_PATTERN = /\$\s?([\d,]+(?:\.\d+)?)/;
const ELIGIBLE_PATTERN = /(open to (all|everyone|external contributors)|no cla required)/i;
const INELIGIBLE_PATTERN = /(not accepting external contributions|internal use only|no external contributors)/i;
const AUTOMATION_ALLOWED_PATTERN = /(ai agents?|bots?|automation)\s+(welcome|allowed)/i;
const AUTOMATION_DISALLOWED_PATTERN = /no\s+(ai|bots?|automation)/i;

function labelsText(labels: GitHubIssuePayload['labels']): string {
  return (labels ?? []).map((label) => (typeof label === 'string' ? label : (label.name ?? ''))).join(' ');
}

/** owner/repo do html_url e do repository_url precisam bater — sinal barato de consistência entre identificadores. */
function repositoryMatchesUrl(issue: GitHubIssuePayload): boolean {
  if (!issue.repository_url || !issue.html_url) return false;
  const repoMatch = /repos\/([^/]+\/[^/]+)$/.exec(issue.repository_url);
  const urlMatch = /github\.com\/([^/]+\/[^/]+)\/issues\//.exec(issue.html_url);
  if (!repoMatch || !urlMatch) return false;
  return repoMatch[1] === urlMatch[1];
}

/**
 * Extrai evidência determinística de uma issue do GitHub — nunca chama IA,
 * nunca interpreta o corpo como instrução (o conteúdo é dado, sempre
 * UNTRUSTED_EXTERNAL). GitHub prova que a issue existe; sozinho ele nunca
 * confirma elegibilidade ou política de automação por omissão — só quando o
 * texto contém um sinal explícito. Ausência de sinal fica `UNKNOWN`, nunca
 * `ELIGIBLE`/`ALLOWED` por padrão (M4-PLANO.md, Promotion Policy).
 */
export function extractGitHubEvidence(
  issue: GitHubIssuePayload,
  options: { hasConflictingEvidence?: boolean } = {},
): GitHubEvidenceResult {
  const labels = labelsText(issue.labels);
  const text = `${issue.title ?? ''} ${labels} ${issue.body ?? ''}`;

  const bountyExistsAtSource = BOUNTY_LABEL_PATTERN.test(labels) || BOUNTY_COMMAND_PATTERN.test(text) || ALGORA_REFERENCE_PATTERN.test(text);
  const amountMatch = AMOUNT_PATTERN.exec(text);
  const rewardAmount = amountMatch ? Number(amountMatch[1]!.replace(/,/g, '')) : undefined;
  const rewardAmountPositive = typeof rewardAmount === 'number' && rewardAmount > 0;

  let eligibilityStatus: EligibilityStatus = 'UNKNOWN';
  if (ELIGIBLE_PATTERN.test(text)) eligibilityStatus = 'ELIGIBLE';
  else if (INELIGIBLE_PATTERN.test(text)) eligibilityStatus = 'INELIGIBLE';

  let automationPolicyStatus: AutomationPolicyStatus = 'UNKNOWN';
  if (AUTOMATION_ALLOWED_PATTERN.test(text)) automationPolicyStatus = 'ALLOWED';
  else if (AUTOMATION_DISALLOWED_PATTERN.test(text)) automationPolicyStatus = 'DISALLOWED';

  const checks: RewardVerificationChecks = {
    bountyExistsAtSource,
    externalIdValid: typeof issue.node_id === 'string' && issue.node_id.length > 0,
    rewardAmountPositive,
    currencyRecognized: rewardAmountPositive,
    targetExists: typeof issue.html_url === 'string' && issue.html_url.length > 0,
    targetOpenIfRequired: issue.state === 'open',
    identifiersConsistent: repositoryMatchesUrl(issue),
    // GitHub não expõe deadline de bounty — ausência de prazo não é evidência de expiração.
    notExpired: true,
    paymentConditionsFound: BOUNTY_COMMAND_PATTERN.test(text),
    eligibilityKnownCompatible: eligibilityStatus === 'ELIGIBLE',
    hasConflictingEvidence: options.hasConflictingEvidence ?? false,
  };

  return {
    checks,
    eligibilityStatus,
    automationPolicyStatus,
    rewardAmount: rewardAmountPositive ? rewardAmount : undefined,
    rewardCurrency: rewardAmountPositive ? 'USD' : undefined,
  };
}
