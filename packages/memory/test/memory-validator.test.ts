import { describe, expect, it } from 'vitest';
import { type MemoryProposal, validateMemoryProposal } from '../src/memory-validator.js';

function proposal(overrides: Partial<MemoryProposal> = {}): MemoryProposal {
  return {
    id: 'proposal-1',
    experienceId: 'experience-1',
    content: 'Tasks de capability CODE_EXECUTION costumam falhar por timeout de sandbox acima de 5 minutos.',
    confidence: 0.8,
    source: 'ExperienceBuilder',
    ...overrides,
  };
}

describe('validateMemoryProposal', () => {
  it('aceita uma proposta bem formada com confiança suficiente', () => {
    expect(validateMemoryProposal(proposal())).toEqual({ status: 'ACCEPTED' });
  });

  it('rejeita proposta sem experienceId — nunca vira memória sem proveniência', () => {
    const result = validateMemoryProposal(proposal({ experienceId: '' }));
    expect(result.status).toBe('REJECTED');
  });

  it('rejeita conteúdo vazio', () => {
    expect(validateMemoryProposal(proposal({ content: '   ' })).status).toBe('REJECTED');
  });

  it('rejeita conteúdo acima do limite de tamanho', () => {
    expect(validateMemoryProposal(proposal({ content: 'x'.repeat(5_000) })).status).toBe('REJECTED');
  });

  it.each([-0.1, 1.1, NaN])('rejeita confidence fora de [0,1]: %s', (confidence) => {
    expect(validateMemoryProposal(proposal({ confidence })).status).toBe('REJECTED');
  });

  it('rejeita confidence abaixo do mínimo, mesmo dentro de [0,1]', () => {
    expect(validateMemoryProposal(proposal({ confidence: 0.2 })).status).toBe('REJECTED');
  });

  it('"task COMPLETED" sozinho nunca é suficiente — validação sempre passa pelas mesmas regras', () => {
    // Não existe atalho: mesmo uma proposta "óbvia" (alta confiança) só passa
    // se estrutura e proveniência também estiverem corretas.
    const result = validateMemoryProposal(proposal({ confidence: 0.99, experienceId: '' }));
    expect(result.status).toBe('REJECTED');
  });
});
