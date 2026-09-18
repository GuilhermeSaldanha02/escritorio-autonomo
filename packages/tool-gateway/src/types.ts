import type { SandboxRunRequest } from '@escritorio/tools';

/**
 * Única ferramenta governada do M3: execução de código na sandbox do M2
 * (§8.6). Novas ferramentas entram aqui e em `GOVERNED_TOOLS`
 * (packages/governor) — nunca soltas, sem registro.
 */
export interface ToolCallRequest {
  agentId: string;
  taskId?: string;
  correlationId?: string;
  tool: 'CODE_EXECUTION';
  payload: SandboxRunRequest;
}

export type ToolCallStatus = 'SUCCESS' | 'ERROR' | 'BLOCKED';

export interface ToolCallOutcome {
  status: ToolCallStatus;
  toolCallId: string;
  error?: string;
  /** Presente só quando status === 'SUCCESS'. */
  result?: {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    oomKilled: boolean;
  };
}
