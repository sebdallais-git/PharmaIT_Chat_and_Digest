import { describe, expect, it } from "@jest/globals";
import { decide, formatScorerTiming, shouldLogScorerTiming } from "../src/services/decide.js";
import type { DecideDeps, ScorerTiming } from "../src/services/decide.js";

// On 2026-09-27 a resolution check hit the scorer's 15 s timeout (gap #81),
// although the scorer answers in ~0.3 s when called directly and the 27B was
// idle at that moment. Memory pressure is the suspect: free memory fell from
// 82% to 20% during a check, and swap was nearly full. Rather than guess at a
// new limit, every scorer call now reports how long it took, how large the
// state was and how much memory was free, and slow or failed calls are logged.

const question = { id: "resolved", instructions: "i", whenTrue: "t", whenFalse: "f" };

function deps(respond: () => Promise<Response>, clock: number[]): { deps: DecideDeps; reports: ScorerTiming[] } {
  const reports: ScorerTiming[] = [];
  return {
    reports,
    deps: {
      config: { baseUrl: "http://127.0.0.1:8010", model: "jev-latest", timeoutMs: 15000, shadowDetection: false, thresholds: { resolved: 0.85, unresolved: 0.5 }, pageRelevanceSkipBelow: null },
      apiKey: "k",
      fetchImpl: (async () => respond()) as unknown as typeof fetch,
      now: () => clock.shift() ?? 0,
      memory: () => ({ freeMb: 9830, totalMb: 49152 }),
      report: (t) => reports.push(t),
    },
  };
}

const ok = () => Promise.resolve(new Response(JSON.stringify({ answers: { resolved: { noul: 0.97 } } }), { status: 200 }));

describe("decide() timing", () => {
  it("reports each scorer call's duration, state size and free memory", async () => {
    const { deps: d, reports } = deps(ok, [1000, 1265]);
    const state = "Question: q\nAnswer: a";
    await decide(question, state, d);
    expect(reports).toEqual([{ ms: 265, outcome: "ok", stateChars: state.length, freeMb: 9830, totalMb: 49152 }]);
  });

  it("reports a timeout as unavailable, and still throws it", async () => {
    const { deps: d, reports } = deps(() => Promise.reject(new Error("The operation was aborted due to timeout")), [0, 15003]);
    await expect(decide(question, "s", d)).rejects.toThrow(/unreachable/);
    expect(reports).toMatchObject([{ ms: 15003, outcome: "unavailable" }]);
  });

  it("reports a refused request as refused", async () => {
    const { deps: d, reports } = deps(() => Promise.resolve(new Response("no", { status: 401 })), [0, 12]);
    await expect(decide(question, "s", d)).rejects.toThrow();
    expect(reports).toMatchObject([{ outcome: "refused" }]);
  });
});

describe("scorer timing log", () => {
  const timing = (ms: number, outcome: ScorerTiming["outcome"]): ScorerTiming => ({ ms, outcome, stateChars: 4100, freeMb: 9830, totalMb: 49152 });

  it("logs failed and slow calls, not the fast ones shadow mode makes every turn", () => {
    expect(shouldLogScorerTiming(timing(270, "ok"))).toBe(false);
    expect(shouldLogScorerTiming(timing(2400, "ok"))).toBe(true);
    expect(shouldLogScorerTiming(timing(15003, "unavailable"))).toBe(true);
    expect(shouldLogScorerTiming(timing(10, "refused"))).toBe(true);
  });

  it("says how long, what happened, how big the state was and how much memory was free", () => {
    expect(formatScorerTiming(timing(15003, "unavailable"))).toBe(
      "[Decide] scorer call unavailable after 15003 ms (state 4100 chars, 9830 MB of 49152 MB free, 20%)",
    );
  });
});
