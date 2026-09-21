// src/util/VisualStateResolver.ts
/**
 * Maps an agent's logical state string to a Phaser sprite frame index.
 * The UI defines 12 concrete visual states plus an UNKNOWN fallback.
 * Frame indices must be deterministic across runs.
 */
export const visualStateResolver = (state: string): number => {
  // Ordered list of known states – must match the sprite sheet order.
  const STATES = [
    "IDLE",
    "SEARCHING",
    "ANALYZING",
    "WORKING",
    "MOVING",
    "PAUSED",
    "EMERGENCY_STOP",
    "CIRCUIT_BREAKER",
    "FAILURE",
    "COMPLETED",
    "ERROR",
    "UNKNOWN",
  ];

  const idx = STATES.findIndex((s) => s.toUpperCase() === state.toUpperCase());
  // If not found, fall back to the last frame (UNKNOWN).
  return idx >= 0 ? idx : STATES.length - 1;
};
