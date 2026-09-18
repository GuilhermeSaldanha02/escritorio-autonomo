import type Docker from 'dockerode';
import { describeError, type Logger } from '@escritorio/shared';

/** Prefixo dos contêineres criados pelo `SandboxManager` (sandbox.ts). */
export const SANDBOX_NAME_PREFIX = 'escritorio-sandbox-';

/**
 * Remove sandboxes órfãs: contêineres do `SandboxManager` que sobraram (o
 * processo caiu antes do `remove` no `finally`). Só remove os que têm mais de
 * `olderThanMs`, com folga sobre o tempo máximo de uma execução: uma sandbox de
 * uma execução viva é sempre mais jovem que isso. Devolve os nomes removidos.
 * Falhar em remover um contêiner não interrompe os demais.
 */
export async function reapLeakedSandboxes(docker: Docker, olderThanMs: number, now: Date, logger?: Logger): Promise<string[]> {
  const containers = await docker.listContainers({ all: true, filters: { name: [SANDBOX_NAME_PREFIX] } });
  const cutoffSeconds = Math.floor((now.getTime() - olderThanMs) / 1000);
  const removed: string[] = [];

  for (const info of containers) {
    const name = (info.Names[0] ?? '').replace(/^\//, '');
    if (!name.startsWith(SANDBOX_NAME_PREFIX)) continue; // o filtro do Docker é por substring; aqui é por prefixo
    if (info.Created > cutoffSeconds) continue;
    try {
      await docker.getContainer(info.Id).remove({ force: true });
      removed.push(name);
    } catch (error) {
      logger?.warn({ name, err: describeError(error) }, 'não foi possível remover a sandbox órfã');
    }
  }
  return removed;
}
