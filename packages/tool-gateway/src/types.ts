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

export type ToolCallStatus = 'SUCCESS' | 'ERROR' | 'BLOCKED' | 'PAUSED';

export interface ToolCallOutcome {
  status: ToolCallStatus;
  toolCallId: string;
  error?: string;
  /** Presente quando status === 'PAUSED': o portão de pausa que barrou a chamada. */
  pauseGate?: string;
  /** Presente só quando status === 'SUCCESS'. Mesma forma de SandboxRunResult — permite reconstruir um adapter compatível (ver governed-sandbox.ts). */
  result?: {
    sandboxId: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    oomKilled: boolean;
    durationMs: number;
  };
}
