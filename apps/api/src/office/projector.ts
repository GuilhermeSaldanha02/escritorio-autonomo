import type { Pool } from '@escritorio/database';
import type { Logger } from '@escritorio/shared';
import { refreshOfficeProjection, type OfficeConfiguration } from './journal.js';

/** Timer da API: nunca executa uma segunda leitura enquanto a anterior ainda corre. */
export function startOfficeProjector(pool: Pool, config: OfficeConfiguration, logger: Logger): () => Promise<void> {
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try { await refreshOfficeProjection(pool, config); }
    catch (error) {
      logger.warn({ code: typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'UNAVAILABLE' }, 'projeção Office indisponível');
    } finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, 1_000);
  timer.unref();
  void tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    while (running) await new Promise(resolve => setTimeout(resolve, 10));
  };
}
