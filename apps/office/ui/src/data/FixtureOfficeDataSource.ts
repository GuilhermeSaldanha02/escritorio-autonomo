// src/data/FixtureOfficeDataSource.ts

import type { OfficeDataSource } from "./OfficeDataSource";
import type { OfficeSnapshot, OfficeEventHandler, Unsubscribe } from "./types";

// Import the demo fixture (in‑memory JavaScript object) from the main office app.
// UI package is at apps/office/ui, so relative path to the fixture is
// ../../../src/fixtures.js (three levels up to apps/office, then src/fixtures.js).
import { OFFICE_DEMO_FIXTURE } from "../../../src/fixtures.js";

/**
 * In‑memory data source that fulfills the OfficeDataSource contract using
 * the static `OFFICE_DEMO_FIXTURE`.
 *
 * No network, no backend, no side‑effects. All data is read‑only.
 */
export class FixtureOfficeDataSource implements OfficeDataSource {
  async getSnapshot(): Promise<OfficeSnapshot> {
    // Deep‑clone to avoid accidental mutation by UI code.
    return JSON.parse(JSON.stringify(OFFICE_DEMO_FIXTURE.snapshot));
  }

  /** The demo fixture does not emit live events; return a no‑op unsubscribe. */
  subscribe(_handler: OfficeEventHandler): Unsubscribe {
    return () => {};
  }
}

// Export a ready‑to‑use instance for the UI package.
export const fixtureOfficeDataSource = new FixtureOfficeDataSource();
