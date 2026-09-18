/**
 * Política de lifecycle do M6 (docs/M6-PLANO.md, critérios 17 a 19). Pura e
 * determinística: mesma entrada, mesma decisão. O M5 CALCULA `AgentPerformance`;
 * aqui só se decide se a evidência basta para uma transição, e quem aplica é o
 * `LifecycleService`, sob autorização do Governor.
 *
 * Três regras existem para o controlador ser ESTÁVEL e nunca punir o que não é
 * culpa do agente:
 *  - amostra insuficiente nunca conta como desempenho ruim (o M5 devolve
 *    INVESTIGATE tanto para amostra pequena quanto para desempenho ruim, e
 *    `sampleSize` é o que distingue os dois);
 *  - janela que se sobrepõe a uma pausa (Stop, circuito do agente) não vale para
 *    decisão nenhuma: pausa não é falha;
 *  - cooldown entre transições e janelas CONSECUTIVAS, nunca um percentual único.
 */
export type LifecycleStatus = 'PROBATION' | 'ACTIVE' | 'SLEEP';
export type PerformanceAction = 'PROMOTE' | 'KEEP' | 'INVESTIGATE';

export interface WindowAssessment {
  id: string;
  windowFrom: Date;
  windowTo: Date;
  sampleSize: number;
  recommendedAction: PerformanceAction;
}

export interface PauseInterval {
  from: Date;
  to: Date;
}

export interface LifecycleParams {
  minSample: number;
  promoteConsecutiveWindows: number;
  sleepConsecutiveBadWindows: number;
  transitionCooldownMs: number;
  sleepMinDurationMs: number;
}

export interface LifecycleInput {
  current: LifecycleStatus;
  /** Avaliações do agente, da MAIS RECENTE para a mais antiga. */
  windows: readonly WindowAssessment[];
  /** Períodos em que o agente esteve pausado (Emergency Stop, circuito do agente aberto). */
  pauses: readonly PauseInterval[];
  /** Instante da última transição do agente; ausente se nunca houve. */
  lastTransitionAt?: Date;
  /** Instante em que entrou em SLEEP (só para SLEEP). */
  sleepingSince?: Date;
  /** Há trabalho realmente atribuível a este agente esperando por ele? */
  hasEligibleDemand: boolean;
  now: Date;
  params: LifecycleParams;
}

export type LifecycleDecision =
  | { action: 'NONE'; reason: string }
  | { action: 'TRANSITION'; to: LifecycleStatus; reason: string; evidenceWindowIds: string[] };

function overlaps(window: WindowAssessment, pause: PauseInterval): boolean {
  return window.windowFrom < pause.to && pause.from < window.windowTo;
}

/** Uma janela só vale como evidência com amostra suficiente e fora de qualquer pausa. */
export function isEligibleWindow(window: WindowAssessment, pauses: readonly PauseInterval[], minSample: number): boolean {
  return window.sampleSize >= minSample && !pauses.some((pause) => overlaps(window, pause));
}

/** As `n` janelas mais recentes, todas elegíveis e todas com a mesma recomendação; senão, nenhuma evidência. */
function streak(input: LifecycleInput, n: number, action: PerformanceAction): WindowAssessment[] | undefined {
  const recent = input.windows.slice(0, n);
  if (recent.length < n) return undefined;
  const all = recent.every((w) => isEligibleWindow(w, input.pauses, input.params.minSample) && w.recommendedAction === action);
  return all ? [...recent] : undefined;
}

export function decideLifecycle(input: LifecycleInput): LifecycleDecision {
  const { params, now } = input;

  // Histerese: nenhuma transição dentro do cooldown da anterior.
  if (input.lastTransitionAt && now.getTime() - input.lastTransitionAt.getTime() < params.transitionCooldownMs) {
    return { action: 'NONE', reason: 'COOLDOWN' };
  }

  switch (input.current) {
    case 'PROBATION': {
      const evidence = streak(input, params.promoteConsecutiveWindows, 'PROMOTE');
      if (!evidence) return { action: 'NONE', reason: 'SEM_EVIDENCIA_DE_PROMOCAO' };
      return { action: 'TRANSITION', to: 'ACTIVE', reason: `${evidence.length} janelas PROMOTE consecutivas`, evidenceWindowIds: evidence.map((w) => w.id) };
    }
    case 'ACTIVE': {
      const evidence = streak(input, params.sleepConsecutiveBadWindows, 'INVESTIGATE');
      if (!evidence) return { action: 'NONE', reason: 'SEM_EVIDENCIA_DE_DESEMPENHO_RUIM' };
      return { action: 'TRANSITION', to: 'SLEEP', reason: `${evidence.length} janelas ruins consecutivas`, evidenceWindowIds: evidence.map((w) => w.id) };
    }
    case 'SLEEP': {
      // Quem dorme não gera Experience: sair de SLEEP não pode depender de novo desempenho.
      if (!input.sleepingSince || now.getTime() - input.sleepingSince.getTime() < params.sleepMinDurationMs) {
        return { action: 'NONE', reason: 'SLEEP_MIN_DURATION' };
      }
      if (!input.hasEligibleDemand) return { action: 'NONE', reason: 'SEM_DEMANDA_ELEGIVEL' };
      return { action: 'TRANSITION', to: 'ACTIVE', reason: 'cooldown vencido e demanda elegível', evidenceWindowIds: [] };
    }
  }
}

export interface TimedEvent {
  type: string;
  at: Date;
}

/**
 * Períodos de pausa a partir de uma linha do tempo de eventos: cada evento de
 * abertura inicia um período e o próximo de fechamento o encerra. Um período
 * ainda aberto vai até `now`. Eventos NA ORDEM de `seq`.
 */
export function pauseIntervals(events: readonly TimedEvent[], openTypes: readonly string[], closeTypes: readonly string[], now: Date): PauseInterval[] {
  const intervals: PauseInterval[] = [];
  let openedAt: Date | undefined;
  for (const event of events) {
    if (openTypes.includes(event.type)) {
      openedAt ??= event.at;
    } else if (closeTypes.includes(event.type) && openedAt) {
      intervals.push({ from: openedAt, to: event.at });
      openedAt = undefined;
    }
  }
  if (openedAt) intervals.push({ from: openedAt, to: now });
  return intervals;
}
