import { WorkPausedError } from '@escritorio/autonomy';
import type { SandboxRunRequest, SandboxRunResult } from '@escritorio/tools';
import type { ToolGateway } from './gateway.js';

/**
 * Adapter que satisfaz a mesma forma de `SandboxManager` (`run(request):
 * Promise<SandboxRunResult>`) mas passa toda execução pelo Tool Gateway
 * primeiro — por tipagem estrutural, serve exatamente onde um
 * `SandboxManager` cru servia antes (`packages/agents/src/developer.ts`,
 * `reviewer.ts`), sem precisar mudar a assinatura desses módulos.
 *
 * Critério 12 do M3 (bypass): a partir daqui, todo o caminho
 * Desenvolvedor/Revisor → sandbox passa pelo Governor (capacidade +
 * orçamento) antes de tocar o Docker — o Orquestrador nunca mais entrega um
 * `SandboxManager` cru a essas funções.
 */
export class GovernedSandbox {
  constructor(
    private readonly gateway: ToolGateway,
    private readonly agentId: string,
    private readonly context: { taskId?: string; correlationId?: string } = {},
  ) {}

  async run(payload: SandboxRunRequest): Promise<SandboxRunResult> {
    const outcome = await this.gateway.execute({
      agentId: this.agentId,
      taskId: this.context.taskId,
      correlationId: this.context.correlationId,
      tool: 'CODE_EXECUTION',
      payload,
    });
    // Pausa nao e falha: quem captura (o worker) registra o trabalho pausado e nao consome tentativa.
    if (outcome.status === 'PAUSED') throw new WorkPausedError(outcome.pauseGate ?? 'EMERGENCY_STOP', outcome.error ?? 'pausado');
    if (outcome.status !== 'SUCCESS' || !outcome.result) {
      throw new Error(`Tool Gateway não executou (${outcome.status}): ${outcome.error ?? 'sem detalhe'}`);
    }
    return outcome.result;
  }
}
