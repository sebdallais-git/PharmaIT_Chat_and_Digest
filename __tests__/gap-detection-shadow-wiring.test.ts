import { describe, expect, it } from "@jest/globals";
import Database from "better-sqlite3";
import { openShadowStore, recordShadowDecision } from "../src/services/detection-shadow.js";
import type { ShadowDeps } from "../src/services/detection-shadow.js";

// Detection's contract with shadow mode, pinned at the seam rather than by
// booting the whole detector: whatever the scorer does, the caller proceeds.
//
// handleGapDetection runs inside setImmediate AFTER res.end() (src/api/chat.ts:426),
// so this adds no user-visible latency -- but it could still break detection by
// throwing, and detection is what creates every gap in the system.
describe("shadow mode cannot disturb detection", () => {
  function store() {
    return openShadowStore(new Database(":memory:"));
  }

  it.each([
    ["the scorer throws", async (): Promise<never> => { throw new Error("ECONNREFUSED"); }],
    ["the scorer hangs up mid-request", async (): Promise<never> => { throw new TypeError("terminated"); }],
    ["the scorer returns nonsense that the client rejects", async (): Promise<never> => { throw new Error("decide: scorer returned an invalid noul"); }],
  ])("resolves normally when %s", async (_label: string, decide: ShadowDeps["decide"]) => {
    const s = store();

    await expect(recordShadowDecision(s, "q", "a", true, { enabled: true, decide })).resolves.toBeUndefined();

    // The failure is recorded, not swallowed: a scorer that is quietly broken
    // must be visible in the data rather than absent from it.
    expect(s.list(1)[0].scorerError).not.toBeNull();
    s.close();
  });

  it("resolves normally when the store itself is unusable", async () => {
    const s = store();
    s.close(); // writing to a closed database throws

    await expect(
      recordShadowDecision(s, "q", "a", true, {
        enabled: true,
        async decide() {
          return { verdict: "resolved", probability: 0.9 };
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("is inert when disabled, so an uninstalled scorer costs nothing", async () => {
    const s = store();
    let called = 0;

    await recordShadowDecision(s, "q", "a", true, {
      enabled: false,
      async decide() {
        called += 1;
        return { verdict: "resolved", probability: 0.9 };
      },
    });

    expect(called).toBe(0);
    expect(s.list(10)).toEqual([]);
    s.close();
  });
});
