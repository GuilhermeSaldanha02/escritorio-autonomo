export interface MemoryProposal {
  id: string;
  experienceId: string;
  content: string;
  confidence: number;
  source: string;
}

export type MemoryValidationStatus = 'ACCEPTED' | 'REJECTED';

export interface MemoryValidationResult {
  status: MemoryValidationStatus;
  reason?: string;
}

const MAX_CONTENT_LENGTH = 4_000;
const MIN_CONFIDENCE = 0.5;

/**
 * Gate entre `Experience` (fato histórico) e `Memory` corporativa
 * (conhecimento selecionado) — critério 5 do M5: "experiência só vira
 * memória por MemoryProposal → MemoryValidator; nunca automaticamente".
 * Determinístico, sem IA: valida estrutura e proveniência, não "qualidade"
 * subjetiva do conteúdo.
 */
export function validateMemoryProposal(proposal: MemoryProposal): MemoryValidationResult {
  if (proposal.experienceId.trim().length === 0) {
    return { status: 'REJECTED', reason: 'sem experienceId — memória precisa de proveniência rastreável' };
  }
  if (proposal.content.trim().length === 0) {
    return { status: 'REJECTED', reason: 'conteúdo vazio' };
  }
  if (proposal.content.length > MAX_CONTENT_LENGTH) {
    return { status: 'REJECTED', reason: `conteúdo excede o limite de ${MAX_CONTENT_LENGTH} caracteres` };
  }
  if (!Number.isFinite(proposal.confidence) || proposal.confidence < 0 || proposal.confidence > 1) {
    return { status: 'REJECTED', reason: 'confidence fora do intervalo [0, 1]' };
  }
  if (proposal.confidence < MIN_CONFIDENCE) {
    return { status: 'REJECTED', reason: `confidence abaixo do mínimo (${MIN_CONFIDENCE})` };
  }
  return { status: 'ACCEPTED' };
}
