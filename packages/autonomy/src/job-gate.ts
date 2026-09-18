import type { Pool } from '@escritorio/database';
import { EventStore, JOB_NAMES } from '@escritorio/events';
import type { AutonomyController } from './autonomy-controller.js';
import { isPause } from './autonomy-controller.js';
import type { CircuitScope } from './circuit-breaker.js';
import { isResumableJob, RESUMABLE_JOBS, recordPausedWork, type ResumableJobName } from './paused-work.js';

/** Único agente cujo circuito barra o INÍCIO de trabalho novo no M6: quem executa as tasks. */
export const DEVELOPER_AGENT = 'DESENVOLVEDOR-001';

export interface JobLike {
  name: string;
  data: Record<string, unknown>;
}

export interface JobGateDeps {
  pool: Pool;
  controller: AutonomyController;
  /** Chave da fonte do Caçador (ex.: `github`), escopo do circuito da descoberta. */
  sourceKey: string;
}

export type JobGateResult = { admitted: true } | { admitted: false; gate: string; reason: string };

/** Jobs que começam ou avançam trabalho e por isso passam pelo portão. `record-experience` não: só registra fatos. */
const GATED_JOBS = new Set<string>([
  JOB_NAMES.DISCOVER_OPPORTUNITIES,
  JOB_NAMES.DECIDE_OPPORTUNITY,
  JOB_NAMES.DEVELOP_TASK,
  JOB_NAMES.REVIEW_TASK,
]);

/**
 * Portão de jobs do orquestrador: UM ponto para toda ação de trabalho, em vez
 * da mesma lógica repetida em cada handler. Aplica o Emergency Stop a todo
 * job, e o circuito só a trabalho NOVO:
 *
 *  - descoberta -> circuito da fonte;
 *  - primeira tentativa de uma task (`ASSIGNED`) -> circuito do agente que a executa.
 *
 * Um job de CONTINUAÇÃO (revisar, tentar de novo, retomar) não passa pelo
 * circuito do agente: uma task tem vários jobs e a sonda `HALF_OPEN` é uma só,
 * então barrar a continuação travaria a task que serve de sonda.
 *
 * Barrado, o job NÃO lança: grava o trabalho pausado (idempotente) e o worker
 * retorna normalmente, sem consumir tentativa. O RELEASE (ou o recovery) o
 * re-despacha.
 */
export function createJobGate({ pool, controller, sourceKey }: JobGateDeps) {
  async function scopesFor(job: JobLike): Promise<CircuitScope[]> {
    if (job.name === JOB_NAMES.DISCOVER_OPPORTUNITIES) return [{ type: 'SOURCE', key: sourceKey }];
    if (job.name === JOB_NAMES.DEVELOP_TASK && typeof job.data.taskId === 'string') {
      const { rows } = await pool.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [job.data.taskId]);
      if (rows[0]?.status === 'ASSIGNED') return [{ type: 'AGENT', key: DEVELOPER_AGENT }];
    }
    return [];
  }

  /** Agente que executa o job. O `SLEEP` dele pausa o trabalho: um agente dormindo não pega trabalho. */
  async function agentFor(job: JobLike): Promise<string | undefined> {
    switch (job.name) {
      case JOB_NAMES.DEVELOP_TASK: {
        if (typeof job.data.taskId !== 'string') return DEVELOPER_AGENT;
        const { rows } = await pool.query<{ assigned_agent_id: string | null }>('SELECT assigned_agent_id FROM tasks WHERE id = $1', [job.data.taskId]);
        return rows[0]?.assigned_agent_id ?? DEVELOPER_AGENT;
      }
      case JOB_NAMES.REVIEW_TASK:
        return 'REVISOR-001';
      case JOB_NAMES.DECIDE_OPPORTUNITY:
        return 'DIRETOR-001';
      case JOB_NAMES.DISCOVER_OPPORTUNITIES:
        return 'CACADOR-001';
      default:
        return undefined;
    }
  }

  /** Grava o trabalho como pausado (idempotente) e emite WORK_PAUSED só numa pausa nova. */
  async function pause(job: JobLike, gate: string, reason: string): Promise<void> {
    if (!isResumableJob(job.name)) return;
    const entityId = job.data[RESUMABLE_JOBS[job.name as ResumableJobName]];
    if (typeof entityId !== 'string') return;
    const correlationId = typeof job.data.correlationId === 'string' ? job.data.correlationId : undefined;
    const newlyPaused = await recordPausedWork(pool, { jobName: job.name as ResumableJobName, entityId, correlationId, reason });
    if (newlyPaused) {
      await new EventStore(pool).append({
        type: 'WORK_PAUSED',
        payload: { jobName: job.name, entityId, gate, reason },
        correlationId,
      });
    }
  }

  async function admit(job: JobLike): Promise<JobGateResult> {
    if (!GATED_JOBS.has(job.name)) return { admitted: true };

    const decision = await controller.authorize({ origin: 'DIRECT', scopes: await scopesFor(job) });
    if (decision.allowed) return { admitted: true };
    // Só portões de pausa chegam aqui (o job não carrega ação governada): nunca é uma falha.
    if (!isPause(decision)) return { admitted: true };

    await pause(job, decision.gate, decision.reason);
    return { admitted: false, gate: decision.gate, reason: decision.reason };
  }

  async function admitWithLifecycle(job: JobLike): Promise<JobGateResult> {
    const decision = await admit(job);
    if (!decision.admitted) return decision;
    const agentId = await agentFor(job);
    if (!agentId) return decision;
    const { rows } = await pool.query<{ lifecycle_status: string }>('SELECT lifecycle_status FROM agents WHERE id = $1', [agentId]);
    if (rows[0]?.lifecycle_status !== 'SLEEP') return decision;
    const reason = `Agente ${agentId} está em SLEEP: o trabalho espera até ele acordar.`;
    await pause(job, 'AGENT_SLEEPING', reason);
    return { admitted: false, gate: 'AGENT_SLEEPING', reason };
  }

  return { admit: admitWithLifecycle, pause };
}
