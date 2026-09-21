// src/data/OfficeDataSource.ts

import type { OfficeSnapshot, OfficeEvent, OfficeEventHandler, Unsubscribe } from "./types";

/**
 * Public contract for the UI to retrieve a read‑only projection of the Office.
 * No transport details (REST, WebSocket, cursor, etc.) are exposed.
 */
export interface OfficeDataSource {
  /** Returns the full snapshot needed by the UI. */
  getSnapshot(): Promise<OfficeSnapshot>;

  /** Subscribe to UI‑level events. Returns an unsubscribe function. */
  subscribe(handler: OfficeEventHandler): Unsubscribe;
}
