import { describe, expect, it } from "@jest/globals";
import { createMinIntervalGate } from "../src/services/watchlist-ingest.js";

// The EDGAR gate keeps SEC requests at least minIntervalMs apart. It waited
// with a single setTimeout, but Node starts timers from libuv's cached loop
// time, which lags Date.now() after synchronous work, so a timer can fire
// early and the gate admitted calls too close together. Under load that made
// the R17 test in watchlist-ingest.test.ts fail now and then (a 1-5 ms short
// gap); against the SEC it means breaking the rate limit.

// A clock whose sleep wakes early, as a timer does when the loop clock is stale
function earlyWakingClock(earlyMs: number) {
  let now = 1000;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += Math.max(1, ms - earlyMs);
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("createMinIntervalGate", () => {
  it("never admits a call before the interval has passed, even when timers wake early", async () => {
    const clock = earlyWakingClock(15);
    const gate = createMinIntervalGate(40, clock);
    const admitted: number[] = [];
    for (let i = 0; i < 4; i++) {
      await gate();
      admitted.push(clock.now());
    }
    for (let i = 1; i < admitted.length; i++) {
      expect(admitted[i] - admitted[i - 1]).toBeGreaterThanOrEqual(40);
    }
  });

  it("does not wait when the interval has already passed", async () => {
    const clock = earlyWakingClock(0);
    const gate = createMinIntervalGate(40, clock);
    await gate();
    clock.advance(100);
    const before = clock.now();
    await gate();
    expect(clock.now()).toBe(before);
  });

  it("paces from the previous admission, not from when the call arrived", async () => {
    const clock = earlyWakingClock(0);
    const gate = createMinIntervalGate(40, clock);
    await gate();
    const first = clock.now();
    clock.advance(10);
    await gate();
    expect(clock.now()).toBe(first + 40);
  });
});
