import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Pool } from '@escritorio/database';
import type { Governor } from '@escritorio/governor';
import type { ToolGateway } from '@escritorio/tool-gateway';
import { createLogger } from '@escritorio/shared';
import { createDevelopmentHandler } from '../src/orchestrator/development-handler.js';

describe('develop-task durante indisponibilidade do PostgreSQL', () => {
  it('propaga falha da escrita e não declara implementação pronta nem conclui a task', async () => {
    const outage = Object.assign(new Error('connection terminated unexpectedly'), { code: '57P01' });
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: 'task-1', opportunity_id: 'opportunity-1', objective: 'simulada', acceptance_criteria: [],
        allowed_tools: [], status: 'IN_PROGRESS', retry_count: 0, max_cost_brl: '0', max_runtime_minutes: 1,
      }] })
      .mockRejectedValueOnce(outage);
    const handle = createDevelopmentHandler({
      pool: { query } as unknown as Pool,
      governor: {} as Governor,
      toolGateway: {} as ToolGateway,
      logger: createLogger('pg-outage-test', 'silent'),
    });
    const job = { id: 'develop-task-1', data: { taskId: 'task-1', correlationId: 'correlation-1' } } as Job;

    await expect(handle(job)).rejects.toBe(outage);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[0]).toContain('UPDATE agents');
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE tasks'))).toBe(false);
  });
});
