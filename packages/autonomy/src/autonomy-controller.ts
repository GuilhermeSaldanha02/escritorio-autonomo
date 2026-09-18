import type { Pool } from '@escritorio/database';
import type { GovernedAction, Governor } from '@escritorio/governor';
import type { BreakerGate } from './circuit-breaker-store.js';
import type { CircuitScope } from './circuit-breaker.js';
import { readStopState, type StopState } from './emergency-stop.js';

/** De onde a ação nasceu. Só `SCHEDULED` (um tick do Scheduler) exige `AUTONOMY_ENABLED`. */
export type ActionOrigin = 'SCHEDULED' | 'DIRECT';

export interface AuthorizeRequest {
  origin: ActionOrigin;
  /** Escopos de circuito que a ação toca (uma fonte, um agente). Circuito aberto de um escopo nega só as ações dele. */
  scopes?: readonly CircuitScope[];
  /** A ação governada, quando existe uma. É a ÚNICA fonte da decisão final de permissão. */
  governed?: GovernedAction;
}

export type AutonomyGateName =
  | 'STOP_UNVERIFIABLE'
  | 'EMERGENCY_STOP'
  | 'AUTONOMY_DISABLED'
  | 'CIRCUIT_UNVERIFIABLE'
  | 'CIRCUIT_OPEN'
  | 'GOVERNOR';

export type AutonomyDecision = { allowed: true } | { allowed: false; gate: AutonomyGateName; rule: string; reason: string };

/** Negações que são PAUSA (o trabalho espera e volta), não falha: nunca contam como falha de nada. */
export const PAUSE_GATES: readonly AutonomyGateName[] = ['STOP_UNVERIFIABLE', 'EMERGENCY_STOP', 'AUTONOMY_DISABLED', 'CIRCUIT_UNVERIFIABLE', 'CIRCUIT_OPEN'];

export function isPause(decision: AutonomyDecision): boolean {
  return !decision.allowed && PAUSE_GATES.includes(decision.gate);
}

export interface StopReader {
  read(): Promise<StopState>;
}

export function stopReaderFor(pool: Pool): StopReader {
  return { read: () => readStopState(pool) };
}

export interface AutonomyControllerDeps {
  governor: Governor;
  stop: StopReader;
  breakers: BreakerGate;
  now?: () => Date;
}

const ALLOWED: AutonomyDecision = Object.freeze({ allowed: true });

function deny(gate: AutonomyGateName, rule: string, reason: string): AutonomyDecision {
  return { allowed: false, gate, rule, reason };
}

/**
 * O ÚNICO ponto de decisão de autonomia (M6-PLANO.md, política de autonomia).
 * A ordem é fixa, e o primeiro portão que nega encerra:
 *
 *   1. Emergency Stop engajado, ou impossível de verificar  -> NEGA (fail-safe)
 *   2. autonomia desligada (só para ação agendada)          -> NEGA
 *   3. circuito aberto no escopo                            -> NEGA
 *   4. o Governor                                           -> a decisão dele
 *
 * INVARIANTE (critério 21): este módulo só ACRESCENTA portões. O único caminho
 * até "permitido" para uma ação governada é `governor.evaluate(action)`, então
 * uma decisão autônoma permitida implica uma decisão manual permitida, por
 * construção, e `AUTONOMY_ENABLED=true` nunca amplia permissão nenhuma.
 * O Governor continua síncrono e puro: Stop e circuito são leituras assíncronas
 * e por isso vivem aqui, não dentro dele.
 */
export class AutonomyController {
  constructor(private readonly deps: AutonomyControllerDeps) {}

  async authorize(request: AuthorizeRequest): Promise<AutonomyDecision> {
    const { governor, stop, breakers } = this.deps;
    const now = (this.deps.now ?? (() => new Date()))();

    const stopState = await stop.read();
    if (stopState.status === 'UNVERIFIABLE') {
      return deny('STOP_UNVERIFIABLE', 'EMERGENCY_STOP', `Não foi possível verificar o Emergency Stop (${stopState.error}). Nenhuma ação mutável começa.`);
    }
    if (stopState.status === 'ENGAGED') {
      return deny('EMERGENCY_STOP', 'EMERGENCY_STOP', `Emergency Stop engajado por ${stopState.actor}: ${stopState.reason}`);
    }

    if (request.origin === 'SCHEDULED' && !governor.autonomy.AUTONOMY_ENABLED) {
      return deny('AUTONOMY_DISABLED', 'AUTONOMY_ENABLED', 'Autonomia desligada na Constituição (AUTONOMY_ENABLED=false).');
    }

    for (const scope of request.scopes ?? []) {
      let admitted;
      try {
        admitted = await breakers.admit(scope, now);
      } catch (error) {
        return deny('CIRCUIT_UNVERIFIABLE', 'CIRCUIT_BREAKER', `Não foi possível ler o circuito ${scope.type}:${scope.key} (${error instanceof Error ? error.message : String(error)}).`);
      }
      if (admitted === 'DENY') {
        return deny('CIRCUIT_OPEN', 'CIRCUIT_BREAKER', `Circuito aberto em ${scope.type}:${scope.key}.`);
      }
    }

    if (request.governed) {
      const decision = governor.evaluate(request.governed);
      return decision.allowed ? ALLOWED : deny('GOVERNOR', decision.rule, decision.reason);
    }
    return ALLOWED;
  }
}
