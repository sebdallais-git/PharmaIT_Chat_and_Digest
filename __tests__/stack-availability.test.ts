import { describe, expect, it } from "@jest/globals";
import { createAvailabilityReader, parseAvailability } from "../src/services/stack-availability.js";

// scripts/switch-stack.sh availability prints one line per stack: "<stack> ok"
// or "<stack> <why it cannot start>". The app reads it to show unavailable
// stacks disabled and to refuse a switch before asking Telegram to confirm it.

describe("parseAvailability", () => {
  it("reads ok and the reason for each stack", () => {
    const text = "ollama ok\nmlx ok\nomlx models for omlx are missing (run scripts/switch-stack.sh prepare)\nsplash Splash cannot build its engine: Xcode is missing\n";
    expect(parseAvailability(text)).toEqual({
      ollama: { available: true },
      mlx: { available: true },
      omlx: { available: false, reason: "models for omlx are missing (run scripts/switch-stack.sh prepare)" },
      splash: { available: false, reason: "Splash cannot build its engine: Xcode is missing" },
    });
  });

  it("ignores lines that name no stack", () => {
    expect(parseAvailability("[switch-stack] something\nnonsense ok\nmlx ok")).toEqual({ mlx: { available: true } });
  });
});

describe("createAvailabilityReader", () => {
  it("runs the script once per ttl and serves the cached answer in between", async () => {
    let runs = 0;
    let now = 0;
    const reader = createAvailabilityReader({ run: async () => { runs += 1; return "mlx ok"; }, now: () => now, ttlMs: 30_000 });
    await reader.get();
    now = 29_000;
    await reader.get();
    expect(runs).toBe(1);
    now = 31_000;
    await reader.get();
    expect(runs).toBe(2);
  });

  // Unknown never blocks: the switch script checks again itself before stopping anything
  it("answers null when the script fails, and tries again next time", async () => {
    let fail = true;
    const reader = createAvailabilityReader({
      run: async () => { if (fail) throw new Error("boom"); return "mlx ok"; },
      now: () => 0,
      ttlMs: 30_000,
    });
    expect(await reader.get()).toBeNull();
    fail = false;
    expect(await reader.get()).toEqual({ mlx: { available: true } });
  });
});
