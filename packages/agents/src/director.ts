import type { GovernedCapability, Governor, GovernorDecision } from '@escritorio/governor';
import type { DirectorDecision, OpportunityFound } from './contracts.js';

/**
 * Diretor mock (§13.2). Decisão determinística e pura — nenhuma IA, nenhum
 * acesso ao Governor aqui: "o Diretor não pode alterar o Governor" (§6), e
 * decidir com base na constituição seria uma forma de alterá-lo por atalho.
 *
 * A fórmula de score é provisória para o M2 (provar o fluxo, não a
 * inteligência — §19). Quando o Caçador real trouxer dados de mercado (M4),
 * revisar os pesos com dado real, nunca com achismo.
 */

export interface DecideOptions {
  /**
   * Capacidades que a execução desta oportunidade exigiria, quando conhecidas
   * (ex.: um bug bounty pede segurança escopada). O contrato §13.1 não carrega
   * esse dado — quem descobre é quem chama, nunca inventado aqui.
   */
  requiredCapabilities?: readonly GovernedCapability[];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function decide(opportunity: OpportunityFound, options: DecideOptions = {}): DirectorDecision {
  const requiredCapabilities = options.requiredCapabilities ?? [];

  if (!opportunity.automation_allowed) {
    return {
      decision: 'REJECT',
      score: 0,
      estimated_cost: 0,
      estimated_runtime_minutes: 0,
      risk: 'HIGH',
      reasoning_summary: 'A fonte não permite automação; a empresa opera com agentes automatizados.',
      required_capabilities: [...requiredCapabilities],
    };
  }

  if (!opportunity.reward_verified) {
    return {
      decision: 'BACKLOG',
      score: clamp01(opportunity.confidence * 0.3),
      estimated_cost: 0,
      estimated_runtime_minutes: 0,
      risk: 'MEDIUM',
      reasoning_summary: 'Recompensa ainda não verificada — aguardar confirmação antes de avaliar.',
      required_capabilities: [...requiredCapabilities],
    };
  }

  // Score provisório: confiança da verificação pesa mais que o valor da
  // recompensa (um valor alto com baixa confiança é, historicamente, o perfil
  // de golpe ou má leitura das regras da fonte).
  const rewardFactor = clamp01(opportunity.reward.amount / 500);
  const score = clamp01(opportunity.confidence * 0.7 + rewardFactor * 0.3);

  const decisionKind = score >= 0.7 ? 'EXECUTE' : score >= 0.4 ? 'INVESTIGATE' : 'BACKLOG';
  const risk = opportunity.ai_allowed ? 'LOW' : 'MEDIUM';
  // Placeholder determinístico: 5 min por requisito declarado, mínimo 15.
  const estimatedRuntimeMinutes = Math.max(15, opportunity.requirements.length * 5);

  return {
    decision: decisionKind,
    score,
    estimated_cost: 0, // AI_MODE=mock: nenhuma chamada paga (Free-First).
    estimated_runtime_minutes: estimatedRuntimeMinutes,
    risk,
    reasoning_summary:
      decisionKind === 'EXECUTE'
        ? `Recompensa verificada, confiança ${opportunity.confidence.toFixed(2)}: executar.`
        : decisionKind === 'INVESTIGATE'
          ? `Sinal misto (score ${score.toFixed(2)}): investigar antes de comprometer recursos.`
          : `Score baixo (${score.toFixed(2)}): manter em backlog.`,
    required_capabilities: [...requiredCapabilities],
  };
}

/**
 * Segundo portão, obrigatório mesmo com EXECUTE (§13.2: "Mesmo que o Diretor
 * retorne EXECUTE, o Governor precisa autorizar"). O Diretor propõe; só o
 * Governor autoriza — e só ele pode negar por causa de uma proibição.
 */
export function authorizeExecution(decision: DirectorDecision, governor: Governor): GovernorDecision {
  if (decision.decision !== 'EXECUTE') {
    return { allowed: false, rule: 'NOT_EXECUTE', reason: `Diretor não decidiu EXECUTE (decisão: ${decision.decision}).` };
  }
  for (const capability of decision.required_capabilities) {
    const result = governor.evaluate({ kind: 'CAPABILITY', capability });
    if (!result.allowed) return result;
  }
  return { allowed: true };
}
