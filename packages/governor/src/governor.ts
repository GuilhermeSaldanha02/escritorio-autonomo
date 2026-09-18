import type { Constitution } from './constitution.js';

/**
 * Capacidades que a V1 proíbe, cada uma ligada à flag da constituição que a
 * governa. Nomes técnicos em inglês; a razão exibida é em português.
 */
export const GOVERNED_CAPABILITIES = {
  DIRECT_OUTREACH: { flag: 'DIRECT_OUTREACH', label: 'prospecção direta (WhatsApp, Instagram, cold email)' },
  TAKE_DEBT: { flag: 'ALLOW_DEBT', label: 'contrair dívida ou empréstimo' },
  TRADING: { flag: 'ALLOW_TRADING', label: 'operar trading' },
  CRYPTO_MINING: { flag: 'ALLOW_CRYPTO_MINING', label: 'minerar criptomoeda' },
  UNSCOPED_SECURITY_TESTING: { flag: 'ALLOW_UNSCOPED_SECURITY_TESTING', label: 'teste de segurança fora de escopo' },
  SECRET_ACCESS: { flag: 'ALLOW_SECRET_ACCESS', label: 'acessar segredos' },
  SELF_MODIFICATION: { flag: 'ALLOW_SELF_MODIFICATION', label: 'alterar Governor ou Constituição' },
} as const satisfies Record<string, { flag: keyof Constitution['permissoes']; label: string }>;

export type GovernedCapability = keyof typeof GOVERNED_CAPABILITIES;
export const GOVERNED_CAPABILITY_NAMES = Object.keys(GOVERNED_CAPABILITIES) as [
  GovernedCapability,
  ...GovernedCapability[],
];

export type SpendPurpose = 'DEVELOPMENT_EXTERNAL_SERVICE' | 'EXPERIMENTAL_BOOTSTRAP';

/**
 * Ferramentas que o Tool Gateway (M3) pode invocar. Uma ferramenta fora
 * desta lista é negada por padrão — o Tool Gateway nunca executa algo que
 * o Governor não conhece. `requiredCapability` é opcional: `CODE_EXECUTION`
 * já é isolada pelo Sandbox Manager (§8.6), então não exige nenhuma
 * capacidade adicional além de existir no registro.
 */
export const GOVERNED_TOOLS = {
  CODE_EXECUTION: { requiredCapability: undefined },
} as const satisfies Record<string, { requiredCapability: GovernedCapability | undefined }>;

export type GovernedTool = keyof typeof GOVERNED_TOOLS;
export const GOVERNED_TOOL_NAMES = Object.keys(GOVERNED_TOOLS) as [GovernedTool, ...GovernedTool[]];

export type GovernedAction =
  | { kind: 'CAPABILITY'; capability: GovernedCapability }
  | {
      kind: 'SPEND';
      purpose: SpendPurpose;
      amountBrl: number;
      /** Total já gasto nesse propósito, derivado do ledger. */
      alreadySpentBrl: number;
      approvedByFounder: boolean;
    }
  | { kind: 'TASK_RETRY'; /** Número da nova tentativa extra (1 = primeiro retry). */ retryNumber: number }
  | { kind: 'TASK_START'; runningTasks: number }
  | { kind: 'TOOL_CALL'; tool: string };

export type GovernorDecision =
  | { allowed: true }
  | { allowed: false; rule: string; reason: string };

const allow: GovernorDecision = Object.freeze({ allowed: true });

function deny(rule: string, reason: string): GovernorDecision {
  return { allowed: false, rule, reason };
}

/**
 * Governor determinístico: mesma constituição + mesma ação = mesma decisão.
 * Não é um agente, não usa IA e não tem nenhum método que altere as regras.
 */
export class Governor {
  readonly #constitution: Readonly<Constitution>;

  constructor(constitution: Readonly<Constitution>) {
    this.#constitution = constitution;
  }

  get limits(): Readonly<Constitution['limites']> {
    return this.#constitution.limites;
  }

  evaluate(action: GovernedAction): GovernorDecision {
    switch (action.kind) {
      case 'CAPABILITY':
        return this.#evaluateCapability(action.capability);
      case 'SPEND':
        return this.#evaluateSpend(action);
      case 'TASK_RETRY':
        return this.#evaluateRetry(action.retryNumber);
      case 'TASK_START':
        return this.#evaluateStart(action.runningTasks);
      case 'TOOL_CALL':
        return this.#evaluateToolCall(action.tool);
    }
  }

  #evaluateToolCall(tool: string): GovernorDecision {
    const rule = (GOVERNED_TOOLS as Record<string, { requiredCapability: GovernedCapability | undefined } | undefined>)[tool];
    if (!rule) {
      return deny('UNKNOWN_TOOL', `Ferramenta desconhecida: ${tool}. Negado por padrão.`);
    }
    if (rule.requiredCapability) {
      return this.#evaluateCapability(rule.requiredCapability);
    }
    return allow;
  }

  #evaluateCapability(capability: GovernedCapability): GovernorDecision {
    const rule = GOVERNED_CAPABILITIES[capability];
    if (!rule) {
      return deny('UNKNOWN_CAPABILITY', `Capacidade desconhecida: ${String(capability)}. Negado por padrão.`);
    }
    if (!this.#constitution.permissoes[rule.flag]) {
      return deny(rule.flag, `Ação proibida pela Constituição: ${rule.label} (${rule.flag}=false).`);
    }
    return allow;
  }

  #evaluateSpend(action: Extract<GovernedAction, { kind: 'SPEND' }>): GovernorDecision {
    const { amountBrl, alreadySpentBrl } = action;
    if (!Number.isFinite(amountBrl) || amountBrl < 0 || !Number.isFinite(alreadySpentBrl) || alreadySpentBrl < 0) {
      return deny('INVALID_AMOUNT', 'Valores de gasto devem ser números finitos e não negativos.');
    }
    if (amountBrl === 0) return allow;

    if (!this.#constitution.permissoes.AUTO_SPEND && !action.approvedByFounder) {
      return deny('AUTO_SPEND', 'Gasto automático desligado: exige aprovação explícita do fundador (AUTO_SPEND=false).');
    }

    const { free_first: policy } = this.#constitution;
    const [rule, cap] =
      action.purpose === 'DEVELOPMENT_EXTERNAL_SERVICE'
        ? ['DEVELOPMENT_EXTERNAL_SERVICES_TARGET_BRL', policy.DEVELOPMENT_EXTERNAL_SERVICES_TARGET_BRL]
        : ['EXPERIMENTAL_BOOTSTRAP_MAX_BRL', policy.EXPERIMENTAL_BOOTSTRAP_MAX_BRL];

    if (alreadySpentBrl + amountBrl > cap) {
      return deny(rule, `Gasto de R$${amountBrl} ultrapassa o teto de R$${cap} (já gasto: R$${alreadySpentBrl}).`);
    }
    return allow;
  }

  #evaluateRetry(retryNumber: number): GovernorDecision {
    const max = this.#constitution.limites.MAX_TASK_RETRIES;
    if (!Number.isInteger(retryNumber) || retryNumber < 1) {
      return deny('INVALID_RETRY', 'O número do retry deve ser um inteiro a partir de 1.');
    }
    if (retryNumber > max) {
      return deny('MAX_TASK_RETRIES', `Limite de ${max} retries atingido; a tarefa deve ser bloqueada.`);
    }
    return allow;
  }

  #evaluateStart(runningTasks: number): GovernorDecision {
    const max = this.#constitution.limites.MAX_PARALLEL_TASKS;
    if (!Number.isInteger(runningTasks) || runningTasks < 0) {
      return deny('INVALID_CONCURRENCY', 'A contagem de tarefas em execução deve ser um inteiro não negativo.');
    }
    if (runningTasks >= max) {
      return deny('MAX_PARALLEL_TASKS', `Já existem ${runningTasks} tarefas em execução (máximo ${max}).`);
    }
    return allow;
  }
}
