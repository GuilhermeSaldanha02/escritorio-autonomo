// src/data/FixtureOfficeDataSource.ts

import type { OfficeDataSource } from './OfficeDataSource';
import type { OfficeEventHandler, OfficeSnapshot, Unsubscribe } from './types';

// Import the demo fixture (in‑memory JavaScript object) from the main office app.
// UI package is at apps/office/ui, so relative path to the fixture is
// ../../../src/fixtures.js (three levels up to apps/office, then src/fixtures.js).
import { OFFICE_DEMO_FIXTURE } from '../../../src/fixtures';

/**
 * In‑memory data source that fulfills the OfficeDataSource contract using
 * the static `OFFICE_DEMO_FIXTURE`.
 *
 * No network, no backend, no side‑effects. All data is read‑only.
 */
export class FixtureOfficeDataSource implements OfficeDataSource {
  async getSnapshot(): Promise<OfficeSnapshot> {
    return structuredClone(OFFICE_DEMO_FIXTURE.snapshot) as OfficeSnapshot;
  }

  /** The demo fixture does not emit live events; return a no‑op unsubscribe. */
  subscribe(_handler: OfficeEventHandler): Unsubscribe {
    return () => {};
  }
}

// Export a ready‑to‑use instance for the UI package.
export const fixtureOfficeDataSource = new FixtureOfficeDataSource();
