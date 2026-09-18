import { describe, expect, it } from 'vitest';
import { FakeSourceConnector } from '../src/fake-source-connector.js';
import { withSourcePolicy } from '../src/source-policy.js';

function fakeSleep() {
  const calls: number[] = [];
  return { sleep: async (ms: number) => void calls.push(ms), calls };
}

describe('withSourcePolicy', () => {
  it('quando a primeira tentativa já é OK, nunca espera nem tenta de novo', async () => {
    const { sleep, calls } = fakeSleep();
    const inner = new FakeSourceConnector('github', [{ status: 'OK', candidates: [] }]);
    const wrapped = withSourcePolicy(inner, { maxRetries: 3, sleep });

    const result = await wrapped.discover();
    expect(result.status).toBe('OK');
    expect(calls).toEqual([]);
    expect(inner.callCount).toBe(1);
  });

  it('tenta de novo depois de SOURCE_RATE_LIMITED, respeitando o retryAfterMs da fonte', async () => {
    const { sleep, calls } = fakeSleep();
    const inner = new FakeSourceConnector('github', [
      { status: 'SOURCE_RATE_LIMITED', candidates: [], retryAfterMs: 5_000 },
      { status: 'OK', candidates: [] },
    ]);
    const wrapped = withSourcePolicy(inner, { maxRetries: 3, sleep });

    const result = await wrapped.discover();
    expect(result.status).toBe('OK');
    expect(calls).toEqual([5_000]);
    expect(inner.callCount).toBe(2);
  });

  it('usa defaultRetryAfterMs só quando a fonte não informou retryAfterMs', async () => {
    const { sleep, calls } = fakeSleep();
    const inner = new FakeSourceConnector('github', [{ status: 'SOURCE_RATE_LIMITED', candidates: [] }, { status: 'OK', candidates: [] }]);
    const wrapped = withSourcePolicy(inner, { maxRetries: 3, defaultRetryAfterMs: 2_000, sleep });

    await wrapped.discover();
    expect(calls).toEqual([2_000]);
  });

  it('esgota maxRetries e devolve o último SOURCE_RATE_LIMITED — nunca martela além do teto', async () => {
    const { sleep, calls } = fakeSleep();
    const inner = new FakeSourceConnector('github', [{ status: 'SOURCE_RATE_LIMITED', candidates: [], retryAfterMs: 100 }]);
    const wrapped = withSourcePolicy(inner, { maxRetries: 2, sleep });

    const result = await wrapped.discover();
    expect(result.status).toBe('SOURCE_RATE_LIMITED');
    expect(inner.callCount).toBe(3); // tentativa inicial + 2 retries, nunca mais
    expect(calls).toHaveLength(2);
  });

  it('não retenta em SOURCE_SCHEMA_DRIFT/SOURCE_UNAVAILABLE — só rate limit é reintentável', async () => {
    const { sleep, calls } = fakeSleep();
    const inner = new FakeSourceConnector('github', [{ status: 'SOURCE_SCHEMA_DRIFT', candidates: [] }, { status: 'OK', candidates: [] }]);
    const wrapped = withSourcePolicy(inner, { maxRetries: 3, sleep });

    const result = await wrapped.discover();
    expect(result.status).toBe('SOURCE_SCHEMA_DRIFT');
    expect(calls).toEqual([]);
    expect(inner.callCount).toBe(1);
  });
});
