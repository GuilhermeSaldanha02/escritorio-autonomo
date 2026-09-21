// src/fixtures.js

export const OFFICE_DEMO_FIXTURE = {
  snapshot: {
    agents: [
      {
        id: "agent-1",
        name: "Agent 1",
        state: "IDLE",
        workstationId: "ws-1",
      },
      {
        id: "agent-2",
        name: "Agent 2",
        state: "WORKING",
        // no workstation assignment to test random placement
      },
    ],
    workstations: [
      { id: "ws-1", x: 200, y: 200 },
      { id: "ws-2", x: 400, y: 300 },
    ],
    metrics: {
      cashReal: 1000,
      cashSimulated: 1200,
      reserveReal: 500,
      reserveSimulated: 600,
      operationsReal: 10,
      operationsSimulated: 12,
      expansionReal: 2,
      expansionSimulated: 3,
    },
    autonomyEnabled: true,
    autoSpendEnabled: false,
    emergencyStop: false,
    circuitBreakerActive: false,
    generatedAt: new Date().toISOString(),
  },
};
