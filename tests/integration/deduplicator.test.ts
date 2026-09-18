import { deduplicateOpportunity, type DiscoveredOpportunityInput } from '@escritorio/cacador';
import type { Pool } from '@escritorio/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestPool, resetDatabase } from './support.js';

let pool: Pool;

beforeAll(async () => {
  pool = createTestPool();
});

beforeEach(async () => {
  await resetDatabase(pool);
});

afterAll(async () => {
  await pool.end();
});

function candidate(overrides: Partial<DiscoveredOpportunityInput> = {}): DiscoveredOpportunityInput {
  return {
    source: 'algora',
    sourceUrl: 'https://algora.io/bounty/1',
    title: 'Corrigir bug no parser',
    externalId: 'bounty-1',
    rewardStatus: 'VERIFIED',
    contentHash: 'hash-v1',
    trustLevel: 'UNTRUSTED_EXTERNAL',
    rawExternalContent: 'conteudo bruto',
    normalizedContent: 'conteudo bruto',
    rawHash: 'raw-hash-v1',
    ...overrides,
  };
}

async function opportunityCount(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM opportunities`);
  return Number(rows[0]?.count ?? 0);
}

async function opportunityRow(id: string) {
  const { rows } = await pool.query<{
    content_hash: string | null;
    reward_verified: boolean;
    reward_status: string | null;
    last_seen_at: Date | null;
    title: string;
  }>(`SELECT content_hash, reward_verified, reward_status, last_seen_at, title FROM opportunities WHERE id = $1`, [id]);
  return rows[0];
}

describe('deduplicateOpportunity', () => {
  it('sem nenhuma identidade em camadas, devolve IDENTITY_MISSING e não escreve nada', async () => {
    const result = await deduplicateOpportunity(pool, candidate({ externalId: undefined }));
    expect(result.outcome).toBe('IDENTITY_MISSING');
    expect(await opportunityCount()).toBe(0);
  });

  it('cria a oportunidade na primeira descoberta e deriva reward_verified de reward_status', async () => {
    const result = await deduplicateOpportunity(pool, candidate());
    expect(result.outcome).toBe('CREATED');
    const row = await opportunityRow(result.opportunityId!);
    expect(row?.reward_status).toBe('VERIFIED');
    expect(row?.reward_verified).toBe(true);
    expect(await opportunityCount()).toBe(1);
  });

  it('reprocessar a mesma oportunidade (mesmo content_hash) não cria duplicata — critério 8', async () => {
    const first = await deduplicateOpportunity(pool, candidate());
    const second = await deduplicateOpportunity(pool, candidate());
    expect(second.outcome).toBe('SEEN_AGAIN');
    expect(second.opportunityId).toBe(first.opportunityId);
    expect(await opportunityCount()).toBe(1);
  });

  it('conteúdo mudou (content_hash diferente) revisiona o registro existente, não cria oportunidade nova — critério 9', async () => {
    const first = await deduplicateOpportunity(pool, candidate({ contentHash: 'hash-v1', rewardStatus: 'PARTIALLY_VERIFIED' }));
    const second = await deduplicateOpportunity(
      pool,
      candidate({ contentHash: 'hash-v2', rewardStatus: 'VERIFIED', rewardAmount: 200, rewardCurrency: 'USD' }),
    );

    expect(second.outcome).toBe('REVISED');
    expect(second.opportunityId).toBe(first.opportunityId);
    expect(await opportunityCount()).toBe(1);

    const row = await opportunityRow(second.opportunityId!);
    expect(row?.content_hash).toBe('hash-v2');
    expect(row?.reward_status).toBe('VERIFIED');
    expect(row?.reward_verified).toBe(true);
  });

  it('identifica pela camada canonical_url quando external_id não está presente', async () => {
    const first = await deduplicateOpportunity(pool, candidate({ externalId: undefined, canonicalUrl: 'https://algora.io/bounty/1' }));
    const second = await deduplicateOpportunity(pool, candidate({ externalId: undefined, canonicalUrl: 'https://algora.io/bounty/1' }));
    expect(second.outcome).toBe('SEEN_AGAIN');
    expect(second.opportunityId).toBe(first.opportunityId);
  });

  it(
    'concorrência real: 8 descobertas simultâneas da MESMA identidade criam só UMA oportunidade — critério 10',
    async () => {
      // Diferente da corrida de orçamento do M3 (nenhuma constraint de banco
      // impedia dois RESERVED simultâneos ali — só a lógica de soma), aqui
      // existe um índice único (source, external_id) como backstop: mesmo com
      // o pg_advisory_xact_lock desligado (testado manualmente até N=100
      // concorrentes), nunca se observou uma segunda linha nem um erro cru de
      // Postgres propagando — o índice único mais o catch de 23505 seguram a
      // garantia de qualquer forma. O advisory lock fica como defesa primária
      // (evita a viagem extra ao banco que o catch cobriria) e mantém a
      // mesma disciplina arquitetural do M3, mesmo sem uma falha reproduzível
      // localmente para prová-lo isoladamente — honestidade sobre o que este
      // teste prova: nenhuma duplicata é criada sob concorrência real.
      const results = await Promise.all(Array.from({ length: 8 }, () => deduplicateOpportunity(pool, candidate())));
      const created = results.filter((r) => r.outcome === 'CREATED').length;
      const seenAgain = results.filter((r) => r.outcome === 'SEEN_AGAIN').length;
      expect(created).toBe(1);
      expect(seenAgain).toBe(7);
      expect(await opportunityCount()).toBe(1);
    },
    20_000,
  );
});
