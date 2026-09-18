import { createHash } from 'node:crypto';

/** Hash do conteúdo bruto de um `RawCandidate` — calculado sempre, mesmo quando o conteúdo é truncado/recusado (rastro de auditoria nunca se perde, ajuste 2 da revisão externa do M4). */
export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
