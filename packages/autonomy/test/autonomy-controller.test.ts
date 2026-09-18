import { describe, expect, it } from 'vitest';
import {
  GOVERNED_CAPABILITY_NAMES,
  type GovernedAction,
  Governor,
  loadConstitution,
  parseConstitution,
} from '@escritorio/governor';
import { AutonomyController, isPause, type StopReader, type AutonomyDecision } from '../src/autonomy-controller.js';
import type { BreakerGate } from '../src/circuit-breaker-store.js';
import type { Admission, CircuitScope } from '../src/circuit-breaker.js';
import type { StopState } from '../src/emergency-stop.js';

function governor(autonomyEnabled: boolean): Governor {
  const raw = structuredClone(loadConstitution()) as unknown as { autonomia: { AUTONOMY_ENABLED: boolean } };
  raw.autonomia.AUTONOMY_ENABLED = autonomyEnabled;
  return new Governor(parseConstitution(raw));
}

const CLEAR: StopReader = { read: async () => ({ status: 'CLEAR' }) };
const stopping = (state: StopState): StopReader => ({ read: async () => state });
const breakers = (decide: (scope: CircuitScope) => Admission): BreakerGate => ({ admit: async (scope) => decide(scope) });
const ADMIT_ALL = breakers(() => 'ADMIT');

const SOURCE: CircuitScope = { type: 'SOURCE', key: 'github' };
const AGENT: CircuitScope = { type: 'AGENT', key: 'DESENVOLVEDOR-001' };

function controller(deps: { enabled?: boolean; stop?: StopReader; breakers?: BreakerGate }) {
  return new AutonomyController({
    governor: governor(deps.enabled ?? true),
    stop: deps.stop ?? CLEAR,
    breakers: deps.breakers ?? ADMIT_ALL,
  });
}

describe('AutonomyController: a ordem dos portões', () => {
  it('sem nada contra, permite', async () => {
    expect(await controller({}).authorize({ origin: 'SCHEDULED' })).toEqual({ allowed: true });
  });

  it('Emergency Stop engajado nega, mesmo com autonomia ligada e circuito fechado', async () => {
    const decision = await controller({
      stop: stopping({ status: 'ENGAGED', since: new Date(), reason: 'teste', actor: 'FOUNDER_CLI' }),
    }).authorize({ origin: 'SCHEDULED', scopes: [SOURCE] });
    expect(decision).toMatchObject({ allowed: false, gate: 'EMERGENCY_STOP' });
  });

  it('FAIL-SAFE: estado do Stop impossível de verificar nega, não permite', async () => {
    const decision = await controller({ stop: stopping({ status: 'UNVERIFIABLE', error: 'db fora' }) }).authorize({ origin: 'DIRECT' });
    expect(decision).toMatchObject({ allowed: false, gate: 'STOP_UNVERIFIABLE' });
  });

  it('o Stop vale também para ação DIRETA, não só para a agendada', async () => {
    const decision = await controller({
      stop: stopping({ status: 'ENGAGED', since: new Date(), reason: 'x', actor: 'FOUNDER_API' }),
    }).authorize({ origin: 'DIRECT' });
    expect(decision.allowed).toBe(false);
  });

  it('autonomia desligada nega só a ação AGENDADA; a direta segue', async () => {
    const off = controller({ enabled: false });
    expect(await off.authorize({ origin: 'SCHEDULED' })).toMatchObject({ allowed: false, gate: 'AUTONOMY_DISABLED' });
    expect(await off.authorize({ origin: 'DIRECT' })).toEqual({ allowed: true });
  });

  it('circuito aberto nega só o escopo dele: outro escopo, e ação sem escopo, seguem', async () => {
    const c = controller({ breakers: breakers((scope) => (scope.type === 'SOURCE' ? 'DENY' : 'ADMIT')) });
    expect(await c.authorize({ origin: 'DIRECT', scopes: [SOURCE] })).toMatchObject({ allowed: false, gate: 'CIRCUIT_OPEN' });
    expect(await c.authorize({ origin: 'DIRECT', scopes: [AGENT] })).toEqual({ allowed: true });
    expect(await c.authorize({ origin: 'DIRECT' })).toEqual({ allowed: true });
  });

  it('circuito que não pode ser lido nega (fail-safe), em vez de lançar', async () => {
    const broken: BreakerGate = { admit: async () => { throw new Error('leitura falhou'); } };
    expect(await controller({ breakers: broken }).authorize({ origin: 'DIRECT', scopes: [SOURCE] })).toMatchObject({
      allowed: false,
      gate: 'CIRCUIT_UNVERIFIABLE',
    });
  });

  it('a precedência é fixa: Stop antes de autonomia, autonomia antes de circuito, circuito antes do Governor', async () => {
    const everythingWrong = controller({
      enabled: false,
      stop: stopping({ status: 'ENGAGED', since: new Date(), reason: 'x', actor: 'FOUNDER_CLI' }),
      breakers: breakers(() => 'DENY'),
    });
    const request = { origin: 'SCHEDULED' as const, scopes: [SOURCE], governed: { kind: 'CAPABILITY', capability: 'DIRECT_OUTREACH' } as GovernedAction };
    expect(await everythingWrong.authorize(request)).toMatchObject({ gate: 'EMERGENCY_STOP' });

    const noStop = controller({ enabled: false, breakers: breakers(() => 'DENY') });
    expect(await noStop.authorize(request)).toMatchObject({ gate: 'AUTONOMY_DISABLED' });

    const noAutonomyProblem = controller({ enabled: true, breakers: breakers(() => 'DENY') });
    expect(await noAutonomyProblem.authorize(request)).toMatchObject({ gate: 'CIRCUIT_OPEN' });

    const onlyGovernor = controller({ enabled: true });
    expect(await onlyGovernor.authorize(request)).toMatchObject({ gate: 'GOVERNOR' });
  });

  it('pausa é distinta de falha: os portões de pausa são reconhecidos, o do Governor não', async () => {
    const pausedByStop = await controller({ stop: stopping({ status: 'ENGAGED', since: new Date(), reason: 'x', actor: 'FOUNDER_CLI' }) }).authorize({ origin: 'DIRECT' });
    const deniedByGovernor = await controller({}).authorize({ origin: 'DIRECT', governed: { kind: 'CAPABILITY', capability: 'DIRECT_OUTREACH' } });
    expect(isPause(pausedByStop)).toBe(true);
    expect(isPause(deniedByGovernor)).toBe(false);
  });
});

describe('INVARIANTE (critério 21): autonomia não aumenta autoridade', () => {
  const actions: GovernedAction[] = [
    ...GOVERNED_CAPABILITY_NAMES.map((capability): GovernedAction => ({ kind: 'CAPABILITY', capability })),
    ...[0, 1, 2, 3, 4, 5].map((retryNumber): GovernedAction => ({ kind: 'TASK_RETRY', retryNumber })),
    ...[0, 1, 2, 3].map((runningTasks): GovernedAction => ({ kind: 'TASK_START', runningTasks })),
    { kind: 'TOOL_CALL', tool: 'CODE_EXECUTION' },
    { kind: 'TOOL_CALL', tool: 'FERRAMENTA_INEXISTENTE' },
    { kind: 'SPEND', purpose: 'EXPERIMENTAL_BOOTSTRAP', amountBrl: 3, alreadySpentBrl: 0, approvedByFounder: true },
    { kind: 'SPEND', purpose: 'EXPERIMENTAL_BOOTSTRAP', amountBrl: 3, alreadySpentBrl: 0, approvedByFounder: false },
    { kind: 'SPEND', purpose: 'DEVELOPMENT_EXTERNAL_SERVICE', amountBrl: 1, alreadySpentBrl: 0, approvedByFounder: true },
  ];

  it('para toda ação governada, decisão autônoma permitida implica decisão direta permitida', async () => {
    const autonomous = controller({ enabled: true });
    const direct = controller({ enabled: true });
    let allowedCount = 0;
    let deniedCount = 0;
    for (const governed of actions) {
      const a: AutonomyDecision = await autonomous.authorize({ origin: 'SCHEDULED', governed });
      const d: AutonomyDecision = await direct.authorize({ origin: 'DIRECT', governed });
      if (a.allowed) {
        expect(d.allowed, JSON.stringify(governed)).toBe(true);
        allowedCount += 1;
      } else {
        deniedCount += 1;
      }
    }
    // A matriz precisa ter os dois lados, senão a propriedade passaria no vazio.
    expect(allowedCount).toBeGreaterThan(0);
    expect(deniedCount).toBeGreaterThan(0);
  });

  it('AUTONOMY_ENABLED=true nunca permite o que o Governor nega: cada negação dele continua negada', async () => {
    const reference = new Governor(loadConstitution());
    const enabled = controller({ enabled: true });
    for (const governed of actions) {
      const g = reference.evaluate(governed);
      if (!g.allowed) {
        expect(await enabled.authorize({ origin: 'SCHEDULED', governed }), JSON.stringify(governed)).toMatchObject({ allowed: false });
      }
    }
  });

  it('ligar ou desligar a autonomia não muda nenhuma decisão do Governor para ação direta', async () => {
    const on = controller({ enabled: true });
    const off = controller({ enabled: false });
    for (const governed of actions) {
      expect((await on.authorize({ origin: 'DIRECT', governed })).allowed, JSON.stringify(governed)).toBe(
        (await off.authorize({ origin: 'DIRECT', governed })).allowed,
      );
    }
  });
});
