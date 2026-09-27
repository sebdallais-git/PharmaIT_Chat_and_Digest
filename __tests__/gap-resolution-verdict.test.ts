import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { decideResolution } from "../src/services/gap-resolution-verdict.js";
import type { ResolutionVerdictDeps } from "../src/services/gap-resolution-verdict.js";

// Since #5 the System One scorer's verdict closed gaps. The acceptance replay
// on 2026-09-27 (60 open gaps) found it agrees with the 27B on only 34.6% of
// committed verdicts, and every disagreement goes the same way: 34 gaps the
// scorer would close that the 27B considers open. It rewards long,
// specific-sounding answers, even ones that say the sources lack the
// information, or invent details. So the 27B decides again; the scorer's
// verdict is only recorded next to it until its question is tuned.
//
// The 27B's old check defaulted to "confident" when its reply could not be
// parsed, silently closing gaps -- the reason #5 moved the decision. An
// unparseable reply now parks the gap for review instead.

function fakeDeps(judge: { confident: boolean; parsed: boolean }, scorer: { verdict: "resolved" | "unresolved" | "review"; probability: number } | Error) {
  const logs: string[] = [];
  const deps: ResolutionVerdictDeps = {
    judge: async () => judge,
    score: async () => {
      if (scorer instanceof Error) throw scorer;
      return scorer;
    },
    log: (m) => logs.push(m),
  };
  return { deps, logs };
}

describe("decideResolution", () => {
  it("resolves when the 27B is confident, whatever the scorer says", async () => {
    const { deps } = fakeDeps({ confident: true, parsed: true }, { verdict: "unresolved", probability: 0.1 });
    expect((await decideResolution("q", "a", deps)).verdict).toBe("resolved");
  });

  it("keeps the gap open when the 27B is not, even if the scorer would close it", async () => {
    // The replay's 34 disagreements: scorer ~1.0, 27B not confident
    const { deps } = fakeDeps({ confident: false, parsed: true }, { verdict: "resolved", probability: 0.999 });
    expect((await decideResolution("q", "a", deps)).verdict).toBe("unresolved");
  });

  it("parks the gap for review when the 27B's reply cannot be parsed, never closing it", async () => {
    // checkConfidence reports confident: true on a parse failure (right for detection, wrong here)
    const { deps } = fakeDeps({ confident: true, parsed: false }, { verdict: "resolved", probability: 0.99 });
    expect((await decideResolution("q", "a", deps)).verdict).toBe("review");
  });

  it("records the scorer's verdict alongside, without letting it decide", async () => {
    const { deps, logs } = fakeDeps({ confident: false, parsed: true }, { verdict: "resolved", probability: 0.9995 });
    const result = await decideResolution("q", "a", deps);
    expect(result.scorer).toEqual({ verdict: "resolved", probability: 0.9995 });
    expect(logs.join("\n")).toMatch(/27B unresolved.*scorer resolved \(noul 0\.9995\)/);
  });

  it("ignores a scorer outage", async () => {
    const { deps, logs } = fakeDeps({ confident: true, parsed: true }, new Error("decide: scorer at http://127.0.0.1:8010 is unreachable"));
    const result = await decideResolution("q", "a", deps);
    expect(result).toEqual({ verdict: "resolved", scorer: null });
    expect(logs.join("\n")).toMatch(/scorer unavailable/);
  });
});

describe("POST /api/knowledge/gaps/check-resolution", () => {
  const route = readFileSync("src/api/knowledge.ts", "utf8");
  const start = route.indexOf('router.post("/gaps/check-resolution"');
  const handler = route.slice(start, route.indexOf("\n});", start));

  it("decides through decideResolution, not the scorer directly", () => {
    expect(handler).toMatch(/decideResolution\(/);
    expect(handler).not.toMatch(/\bdecide\(/);
  });
});
