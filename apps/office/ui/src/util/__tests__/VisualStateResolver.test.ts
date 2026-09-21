// src/util/__tests__/VisualStateResolver.test.ts
import { visualStateResolver } from "../VisualStateResolver";

describe("visualStateResolver", () => {
  const knownStates = [
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

  test("maps each known state to a unique frame index", () => {
    const indices = knownStates.map((s) => visualStateResolver(s));
    // All indices should be distinct and sequential from 0.
    expect(new Set(indices).size).toBe(knownStates.length);
    expect(indices[0]).toBe(0);
    expect(indices[indices.length - 1]).toBe(knownStates.length - 1);
  });

  test("fallbacks to UNKNOWN for unknown states", () => {
    const unknown = visualStateResolver("SOME_RANDOM_STATE");
    expect(unknown).toBe(knownStates.length - 1); // index of UNKNOWN
  });
});
