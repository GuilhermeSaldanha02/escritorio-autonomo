import Docker from 'dockerode';
import type { Container } from 'dockerode';
import { describeError, type Logger, TimeoutError, withTimeout } from '@escritorio/shared';

/**
 * Sandbox Manager (especificação §8.6): código de terceiros roda em
 * containers descartáveis com limites de CPU, RAM, disco, tempo e rede.
 *
 * Cada `run()` cria um container novo, o remove ao final (sucesso, falha,
 * timeout ou erro) e nunca reaproveita estado entre chamadas — é assim que o
 * Desenvolvedor e o Revisor conseguem sandboxes independentes (§8.6: "o
 * Revisor deve poder validar em ambiente limpo independente").
 */

export interface SandboxLimits {
  /** Teto de memória do container, em bytes. Estourar aciona o OOM killer do kernel. */
  memoryBytes: number;
  /** Fração de 1 CPU (0.5 = meio núcleo). */
  cpuFraction: number;
  /** Máximo de processos/threads simultâneos — contém fork bomb. */
  pidsLimit: number;
  /** Teto do espaço gravável em /workspace, em bytes. É tmpfs (RAM), não disco real. */
  workspaceBytes: number;
  /** Tempo máximo de execução. Estourar mata o container (SIGKILL). */
  timeoutMs: number;
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  memoryBytes: 128 * 1024 * 1024,
  cpuFraction: 0.5,
  pidsLimit: 64,
  workspaceBytes: 64 * 1024 * 1024,
  timeoutMs: 30_000,
};

/** Precisa ter `sh` e `node` na imagem — é isso que o bootstrap usa para gravar arquivos e trocar de processo. */
export const DEFAULT_SANDBOX_IMAGE = 'node:24-alpine';

export interface SandboxRunRequest {
  /** Imagem já presente localmente ou puxável. */
  image?: string;
  /** Comando real a executar — vira o processo de início (PID 1) do container. */
  command: readonly [string, ...string[]];
  /** Arquivos texto a gravar em /workspace antes do comando (caminho relativo → conteúdo). */
  files?: Readonly<Record<string, string>>;
  limits?: Partial<SandboxLimits>;
  /** Encerramento controlado pedido de fora (Emergency Stop): o container é morto e removido, sem falha. */
  signal?: AbortSignal;
}

export interface SandboxRunResult {
  sandboxId: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** `true` quando o `signal` da requisição interrompeu a execução. */
  aborted?: boolean;
  oomKilled: boolean;
  durationMs: number;
}

export class SandboxConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxConfigError';
  }
}

function validateLimits(limits: SandboxLimits): void {
  const positive: Array<[string, number]> = [
    ['memoryBytes', limits.memoryBytes],
    ['pidsLimit', limits.pidsLimit],
    ['workspaceBytes', limits.workspaceBytes],
    ['timeoutMs', limits.timeoutMs],
  ];
  for (const [name, value] of positive) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new SandboxConfigError(`${name} deve ser um número finito e positivo (recebido: ${value})`);
    }
  }
  // Docker recusa NanoCpus abaixo de 1e6 (0.001 CPU) -- falha aqui, antes do Docker, com a mesma clareza das outras validacoes.
  const MIN_CPU_FRACTION = 0.001;
  if (!Number.isFinite(limits.cpuFraction) || limits.cpuFraction < MIN_CPU_FRACTION) {
    throw new SandboxConfigError(
      `cpuFraction deve ser um número finito >= ${MIN_CPU_FRACTION} (recebido: ${limits.cpuFraction})`,
    );
  }
}

/**
 * Escreve os arquivos e SÓ ENTÃO troca de processo (`exec`) para o comando
 * real, que assim vira o PID 1 do container — essencial para que o OOM
 * killer, o SIGKILL de timeout e o código de saída reflitam o comando em si,
 * não um processo intermediário nosso.
 *
 * Texto fixo, nunca interpolado com conteúdo do chamador: os dados variáveis
 * (arquivos, comando) viajam só por variável de ambiente, lidos em runtime
 * pelo `SANDBOX_WRITER` — não há injeção possível via nome de arquivo,
 * conteúdo ou argumento de comando.
 */
const SHELL_SCRIPT = 'set -e; node -e "$SANDBOX_WRITER"; exec "$0" "$@"';

const WRITER_SCRIPT = [
  "const fs = require('fs');",
  "const path = require('path');",
  "const files = JSON.parse(process.env.SANDBOX_FILES || '{}');",
  'for (const rel of Object.keys(files)) {',
  "  const dest = path.join('/workspace', rel);",
  '  fs.mkdirSync(path.dirname(dest), { recursive: true });',
  "  fs.writeFileSync(dest, Buffer.from(files[rel], 'base64'));",
  '}',
].join('\n');

function isDockerApiError(error: unknown, statusCode: number): boolean {
  return typeof error === 'object' && error !== null && (error as { statusCode?: unknown }).statusCode === statusCode;
}

/** Desmultiplexa o log não-TTY do Docker: quadros [tipo(1) + reservado(3) + tamanho BE(4) + payload]. */
function demuxDockerLog(buffer: Buffer): { stdout: string; stderr: string } {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const streamType = buffer.readUInt8(offset);
    const length = buffer.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = Math.min(start + length, buffer.length);
    (streamType === 2 ? stderr : stdout).push(buffer.subarray(start, end));
    offset = end;
  }
  return { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
}

/** No Windows, o Docker Desktop expõe a API por named pipe; nos demais, pelo socket Unix padrão. */
export function createDockerClient(): Docker {
  return process.platform === 'win32' ? new Docker({ socketPath: '//./pipe/docker_engine' }) : new Docker();
}

export class SandboxManager {
  constructor(
    private readonly docker: Docker,
    private readonly logger: Logger,
  ) {}

  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    const limits: SandboxLimits = { ...DEFAULT_SANDBOX_LIMITS, ...request.limits };
    validateLimits(limits);
    const image = request.image ?? DEFAULT_SANDBOX_IMAGE;

    const filesB64 = Object.fromEntries(
      Object.entries(request.files ?? {}).map(([rel, content]) => [rel, Buffer.from(content, 'utf8').toString('base64')]),
    );

    const name = `escritorio-sandbox-${crypto.randomUUID()}`;
    const startedAt = Date.now();
    const container = await this.createContainerWithPull(name, image, limits, filesB64, request.command);

    try {
      await container.start();
      const { timedOut, aborted } = await this.waitWithTimeout(container, limits.timeoutMs, request.signal);
      const { stdout, stderr } = await this.readLogs(container);
      const info = await container.inspect();
      return {
        sandboxId: container.id,
        exitCode: info.State.ExitCode,
        stdout,
        stderr,
        timedOut,
        aborted,
        oomKilled: info.State.OOMKilled,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      // Descartável de verdade: sempre some, mesmo se algo acima lançar.
      await container.remove({ force: true }).catch((error: unknown) => {
        this.logger.warn(
          { sandboxId: container.id, err: describeError(error) },
          'falha ao remover sandbox — pode ter ficado órfã',
        );
      });
    }
  }

  private async createContainerWithPull(
    name: string,
    image: string,
    limits: SandboxLimits,
    filesB64: Record<string, string>,
    command: readonly [string, ...string[]],
  ): Promise<Container> {
    try {
      return await this.createContainer(name, image, limits, filesB64, command);
    } catch (error) {
      if (!isDockerApiError(error, 404)) throw error;
      this.logger.info({ image }, 'imagem do sandbox ausente — puxando');
      await this.pullImage(image);
      return this.createContainer(name, image, limits, filesB64, command);
    }
  }

  private createContainer(
    name: string,
    image: string,
    limits: SandboxLimits,
    filesB64: Record<string, string>,
    command: readonly [string, ...string[]],
  ): Promise<Container> {
    return this.docker.createContainer({
      name,
      Image: image,
      Cmd: ['/bin/sh', '-c', SHELL_SCRIPT, ...command],
      Env: [`SANDBOX_WRITER=${WRITER_SCRIPT}`, `SANDBOX_FILES=${JSON.stringify(filesB64)}`],
      WorkingDir: '/workspace',
      // Nunca root: 65534 é o uid convencional de "nobody", presente na maioria das imagens.
      User: '65534:65534',
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        NetworkMode: 'none',
        Memory: limits.memoryBytes,
        MemorySwap: limits.memoryBytes, // sem swap além da própria memória
        NanoCpus: Math.round(limits.cpuFraction * 1_000_000_000),
        PidsLimit: limits.pidsLimit,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        ReadonlyRootfs: true,
        // mode=1777: sticky + world-writable, para o uid não-root conseguir escrever.
        Tmpfs: { '/workspace': `size=${limits.workspaceBytes},mode=1777` },
        AutoRemove: false, // removemos manualmente, depois de ler os logs e inspecionar o estado final.
      },
    });
  }

  private pullImage(image: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.docker.pull(image, (pullError: unknown, stream?: NodeJS.ReadableStream) => {
        if (pullError || !stream) {
          reject(pullError instanceof Error ? pullError : new Error(`Falha ao puxar a imagem ${image}`));
          return;
        }
        const modem = (this.docker as unknown as { modem: DockerModemLike }).modem;
        modem.followProgress(stream, (followError: Error | null) => (followError ? reject(followError) : resolve()));
      });
    });
  }

  private async waitWithTimeout(container: Container, timeoutMs: number, signal?: AbortSignal): Promise<{ timedOut: boolean; aborted: boolean }> {
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<'ABORTED'>((resolve) => {
      if (!signal) return;
      onAbort = () => resolve('ABORTED');
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const outcome = await Promise.race([withTimeout(container.wait(), timeoutMs, 'execução no sandbox').then(() => 'DONE' as const), aborted]);
      if (outcome === 'DONE') return { timedOut: false, aborted: false };
      await container.kill().catch(() => undefined); // encerramento controlado: pode já ter morrido sozinho
      await container.wait().catch(() => undefined);
      return { timedOut: false, aborted: true };
    } catch (error) {
      if (!(error instanceof TimeoutError)) throw error;
      await container.kill().catch(() => undefined); // pode já ter morrido sozinho entre o timeout e aqui
      await container.wait().catch(() => undefined); // espera o estado final assentar antes do inspect
      return { timedOut: true, aborted: false };
    } finally {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  private async readLogs(container: Container): Promise<{ stdout: string; stderr: string }> {
    const buffer = await container.logs({ stdout: true, stderr: true, follow: false, timestamps: false });
    return demuxDockerLog(buffer);
  }
}

/** Único método do modem que usamos; docker-modem não publica tipos próprios. */
interface DockerModemLike {
  followProgress(stream: NodeJS.ReadableStream, onFinished: (error: Error | null) => void): void;
}
