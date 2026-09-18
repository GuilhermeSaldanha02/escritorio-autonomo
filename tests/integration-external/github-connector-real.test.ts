import { GitHubConnector } from '@escritorio/cacador';
import { SafeHttpClient } from '@escritorio/http-safe';
import { describe, expect, it } from 'vitest';

/**
 * Critério 18 do M4 (Real Source Connectivity): consulta a API pública real
 * do GitHub, pelo mesmo SafeHttpClient/GitHubConnector usado em produção,
 * sem navegador nem input manual. Zero candidatos é resultado válido — o
 * que esta prova demonstra é conectividade e schema, não a existência de
 * uma bounty específica num instante arbitrário. Custo externo: R$0 (API
 * pública do GitHub, sem token, bem abaixo do limite de 10/min do Search).
 */
describe('GitHubConnector — conectividade real com a internet', () => {
  it(
    'consulta a busca de issues real do GitHub e devolve um schema válido (zero ou N candidatos)',
    async () => {
      const connector = new GitHubConnector({
        httpClient: new SafeHttpClient(),
        userAgent: 'escritorio-autonomo-cacador-m4-teste-integracao',
        queries: ['label:bounty is:issue is:open'],
        perPage: 5,
      });

      const result = await connector.discover();

      // Aceita SOURCE_RATE_LIMITED como resultado válido também: rodar este
      // teste repetidas vezes em sequência (ou em CI compartilhado) pode
      // esbarrar no limite de 10/min do Search sem token — o que este teste
      // prova é que o connector INTERPRETA corretamente a resposta real do
      // GitHub, não que sempre há orçamento de requisição disponível.
      expect(['OK', 'SOURCE_RATE_LIMITED']).toContain(result.status);

      if (result.status === 'OK') {
        for (const candidate of result.candidates) {
          expect(candidate.source).toBe('github');
          expect(candidate.externalId.length).toBeGreaterThan(0);
          expect(candidate.url).toMatch(/^https:\/\/github\.com\//);
          expect(candidate.trustLevel).toBe('UNTRUSTED_EXTERNAL');
        }
      }
    },
    20_000,
  );
});
