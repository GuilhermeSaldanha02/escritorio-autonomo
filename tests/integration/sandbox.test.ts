import { afterAll, describe, expect, it } from 'vitest';
import { createDockerClient, DEFAULT_SANDBOX_IMAGE, SandboxConfigError, SandboxManager } from '@escritorio/tools';
import { logger } from './support.js';

/**
 * Sandbox Manager contra o Docker real (§8.6). Containers pequenos e curtos
 * de propósito — esta máquina tem pouca RAM livre; um teste por vez
 * (`vitest.integration.config.ts` já serializa arquivos de integração).
 */
const docker = createDockerClient();
const manager = new SandboxManager(docker, logger);

afterAll(async () => {
  // dockerode não expõe um "close" — o socket HTTP fecha sozinho com o processo.
});

describe('SandboxManager', () => {
  it('executa um comando e captura stdout/stderr separados', async () => {
    const result = await manager.run({
      command: ['node', '-e', "console.log('linha de saída'); console.error('linha de erro')"],
      limits: { memoryBytes: 32 * 1024 * 1024, timeoutMs: 10_000 },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('linha de saída');
    expect(result.stderr).toContain('linha de erro');
    expect(result.timedOut).toBe(false);
    expect(result.oomKilled).toBe(false);
  }, 30_000);

  it('grava os arquivos pedidos em /workspace antes do comando rodar', async () => {
    const result = await manager.run({
      command: ['node', '-e', "console.log(require('fs').readFileSync('nota.txt', 'utf8'))"],
      files: { 'nota.txt': 'conteúdo de teste\ncom acento e quebra de linha' },
      limits: { memoryBytes: 32 * 1024 * 1024, timeoutMs: 10_000 },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('conteúdo de teste');
  }, 30_000);

  it('grava em subdiretório, criando o caminho', async () => {
    const result = await manager.run({
      command: ['node', '-e', "console.log(require('fs').readFileSync('src/lib/a.txt', 'utf8'))"],
      files: { 'src/lib/a.txt': 'ok' },
      limits: { memoryBytes: 32 * 1024 * 1024, timeoutMs: 10_000 },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('ok');
  }, 30_000);

  it('propaga o código de saída do comando', async () => {
    const result = await manager.run({
      command: ['node', '-e', 'process.exit(7)'],
      limits: { memoryBytes: 32 * 1024 * 1024, timeoutMs: 10_000 },
    });
    expect(result.exitCode).toBe(7);
  }, 30_000);

  it('não tem rede: uma conexão de saída falha na hora, nunca pendura', async () => {
    // Conexão TCP direta por IP (sem DNS): com --network none o kernel nem
    // tenta rotear, então o erro é imediato (ENETUNREACH em milissegundos).
    // Um `fetch` por hostname foi descartado aqui: sem interface de rede a
    // resolução de nome trava até o AbortSignal, e por depender só do relógio
    // esse teste ficava ocasionalmente falso-negativo quando a rede do host
    // estava lenta (confirmado nesta sessão) — TCP direto não tem esse problema.
    const result = await manager.run({
      command: [
        'node',
        '-e',
        "const s = require('net').connect({ host: '8.8.8.8', port: 53, timeout: 3000 }); s.on('connect', () => { console.log('CONECTOU'); process.exit(0); }); s.on('timeout', () => { console.log('TIMEOUT'); process.exit(1); }); s.on('error', (e) => { console.log('SEM_REDE:' + e.code); process.exit(1); });",
      ],
      limits: { memoryBytes: 32 * 1024 * 1024, timeoutMs: 10_000 },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('SEM_REDE:ENETUNREACH');
  }, 30_000);

  it('não roda como root', async () => {
    const result = await manager.run({
      command: ['node', '-e', 'console.log(process.getuid())'],
      limits: { memoryBytes: 32 * 1024 * 1024, timeoutMs: 10_000 },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('65534');
  }, 30_000);

  it('estoura o teto de memória: o kernel mata o processo (OOMKilled)', async () => {
    const result = await manager.run({
      // Aloca 200 MB com um limite de 32 MB — precisa tocar as páginas (fill) para forçar o kernel a alocar de verdade.
      command: ['node', '-e', "const b = Buffer.alloc(200 * 1024 * 1024, 1); console.log('não deveria chegar aqui', b.length)"],
      limits: { memoryBytes: 32 * 1024 * 1024, timeoutMs: 10_000 },
    });
    expect(result.oomKilled).toBe(true);
    expect(result.stdout).not.toContain('não deveria chegar aqui');
  }, 30_000);

  it('estoura o teto de disco (tmpfs): grava além do tamanho e falha', async () => {
    const result = await manager.run({
      command: [
        'node',
        '-e',
        "try { require('fs').writeFileSync('grande.bin', Buffer.alloc(4 * 1024 * 1024)); console.log('ESCREVEU'); } catch (e) { console.log('FALHOU:' + e.code); process.exit(1); }",
      ],
      limits: { memoryBytes: 64 * 1024 * 1024, workspaceBytes: 1 * 1024 * 1024, timeoutMs: 10_000 },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('FALHOU:ENOSPC');
  }, 30_000);

  it('estoura o tempo máximo: mata e reporta timedOut', async () => {
    const result = await manager.run({
      command: ['node', '-e', 'setTimeout(() => {}, 60000)'],
      limits: { memoryBytes: 32 * 1024 * 1024, timeoutMs: 800 },
    });
    expect(result.timedOut).toBe(true);
  }, 30_000);

  it('limita pids: uma fork bomb de processos esbarra no teto', async () => {
    // Disparar as 40 tentativas de uma vez (spawn assíncrono, sem esperar cada
    // uma terminar) é o que de fato empilha PIDs simultâneos contra o teto —
    // com spawnSync sequencial os filhos nunca coexistem. `sleep`, não `node`,
    // como filho: um processo leve deixa o resultado nítido (custo de subir
    // outro interpretador Node por filho mascararia o que está sendo medido).
    //
    // pidsLimit=10, não um valor menor: nesta máquina (Docker Desktop/WSL2),
    // um teto abaixo de ~10 faz o próprio `spawn()` do Node travar em vez de
    // falhar — o fork() nunca retorna erro, e quem mata o processo é o nosso
    // timeout, não o teste. Limitação de ambiente registrada no M2-PLANO;
    // 10 já é um teto bem apertado e prova a contenção sem esse efeito.
    const script = [
      "const { spawn } = require('child_process');",
      'let failures = 0;',
      'const children = [];',
      'for (let i = 0; i < 40; i++) {',
      "  const child = spawn('sleep', ['5']);",
      "  child.on('error', () => { failures += 1; });",
      '  children.push(child);',
      '}',
      'setTimeout(() => {',
      "  for (const child of children) { try { child.kill('SIGKILL'); } catch {} }",
      "  console.log('FALHAS:' + failures);",
      '  process.exit(0);',
      '}, 700);',
    ].join('\n');
    const result = await manager.run({
      command: ['node', '-e', script],
      limits: { memoryBytes: 64 * 1024 * 1024, pidsLimit: 10, timeoutMs: 8_000 },
    });
    expect(result.timedOut).toBe(false);
    const failures = Number(/FALHAS:(\d+)/.exec(result.stdout)?.[1]);
    expect(failures).toBeGreaterThan(20); // ~37/40 falharam no ambiente de referência
  }, 30_000);

  it('remove o container ao final — nunca sobra sandbox órfã', async () => {
    const result = await manager.run({
      command: ['node', '-e', 'process.exit(0)'],
      limits: { memoryBytes: 32 * 1024 * 1024, timeoutMs: 10_000 },
    });
    await expect(docker.getContainer(result.sandboxId).inspect()).rejects.toMatchObject({ statusCode: 404 });
  }, 30_000);

  it('duas execuções nunca compartilham /workspace — sandboxes independentes', async () => {
    const first = await manager.run({
      command: ['node', '-e', "require('fs').writeFileSync('marca.txt', 'da-primeira')"],
      limits: { memoryBytes: 32 * 1024 * 1024, timeoutMs: 10_000 },
    });
    const second = await manager.run({
      command: [
        'node',
        '-e',
        "console.log(require('fs').existsSync('marca.txt') ? 'VAZOU' : 'ISOLADO')",
      ],
      limits: { memoryBytes: 32 * 1024 * 1024, timeoutMs: 10_000 },
    });
    expect(first.exitCode).toBe(0);
    expect(second.stdout.trim()).toBe('ISOLADO');
    expect(first.sandboxId).not.toBe(second.sandboxId);
  }, 30_000);

  it('rejeita limites inválidos antes de tocar o Docker', async () => {
    await expect(manager.run({ command: ['node', '-e', '1'], limits: { memoryBytes: -1 } })).rejects.toThrow(
      SandboxConfigError,
    );
    await expect(manager.run({ command: ['node', '-e', '1'], limits: { timeoutMs: 0 } })).rejects.toThrow(
      SandboxConfigError,
    );
  });

  it('usa a imagem padrão do stack quando nenhuma é informada', async () => {
    // Smoke test documentando a constante — a imagem já foi puxada nos testes acima.
    expect(DEFAULT_SANDBOX_IMAGE).toBe('node:24-alpine');
  });
});
