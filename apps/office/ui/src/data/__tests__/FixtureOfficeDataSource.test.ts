// src/data/__tests__/FixtureOfficeDataSource.test.ts
import { fixtureOfficeDataSource } from "../../data/FixtureOfficeDataSource";
import type { OfficeSnapshot } from "../../data/types";

describe("FixtureOfficeDataSource", () => {
  test("getSnapshot returns a deep cloned snapshot", async () => {
    const snap1 = await fixtureOfficeDataSource.getSnapshot();
    const snap2 = await fixtureOfficeDataSource.getSnapshot();
    expect(snap1).toEqual(snap2);
    // Mutate first snapshot and ensure second is unchanged (deep clone).
    (snap1.agents[0] as any).state = "CHANGED";
    expect(snap2.agents[0].state).not.toBe("CHANGED");
  });

  test("subscribe returns an unsubscribe function and does not invoke network", () => {
    const originalFetch = global.fetch;
    // @ts-ignore
    global.fetch = jest.fn();
    const unsubscribe = fixtureOfficeDataSource.subscribe(() => {});
    expect(typeof unsubscribe).toBe("function");
    expect(global.fetch).not.toHaveBeenCalled();
    // restore
    // @ts-ignore
    global.fetch = originalFetch;
  });
});
