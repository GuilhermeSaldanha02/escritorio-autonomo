import { createHash } from 'node:crypto';

/**
 * Hash determinístico de um snapshot de arquivos (caminho relativo → conteúdo).
 *
 * Usado para provar que o Revisor analisou exatamente o artefato que saiu da
 * sandbox do Desenvolvedor, sem depender de estado ou processo compartilhado
 * (revisão externa do M2, critério 5): o Desenvolvedor calcula o hash do
 * snapshot resultante, o Orquestrador leva o hash junto do snapshot até a
 * sandbox do Revisor, e o Revisor recalcula e confere antes de revisar.
 *
 * Ordena as chaves para que a mesma árvore de arquivos sempre produza o
 * mesmo hash, independente da ordem de inserção.
 */
export function hashFileSnapshot(files: Readonly<Record<string, string>>): string {
  const hash = createHash('sha256');
  for (const path of Object.keys(files).sort()) {
    hash.update(path);
    hash.update('\0');
    hash.update(files[path]!);
    hash.update('\0');
  }
  return hash.digest('hex');
}
