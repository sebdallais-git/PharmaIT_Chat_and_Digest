import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyGapVerdict, GAP_RESOLVED_QUESTION } from "../src/services/gap-outcome.js";
import type { GapOutcomeDeps } from "../src/services/gap-outcome.js";

function spyDeps(): GapOutcomeDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resolveGap: (id, response) => calls.push(`resolve:${id}:${response}`),
    markUnresolved: (id) => calls.push(`unresolved:${id}`),
    markForReview: (id) => calls.push(`review:${id}`),
  };
}

describe("applyGapVerdict", () => {
  it("resolves the gap and stores the new answer", () => {
    const deps = spyDeps();

    applyGapVerdict("resolved", 7, "the answer", deps);

    expect(deps.calls).toEqual(["resolve:7:the answer"]);
  });

  it("marks the gap unresolved so the loop spends a retry", () => {
    const deps = spyDeps();

    applyGapVerdict("unresolved", 7, "the answer", deps);

    expect(deps.calls).toEqual(["unresolved:7"]);
  });

  // The whole reason the review band exists: a gap nobody is confident about
  // should wait for a human, not consume a retry and re-run the ingest.
  it("parks a review gap without spending a retry", () => {
    const deps = spyDeps();

    applyGapVerdict("review", 7, "the answer", deps);

    expect(deps.calls).toEqual(["review:7"]);
  });
});

// The harness exists to tell whether the 4B can stand in for the 27B on ONE
// question. If production and the harness each keep their own copy of that
// question, they can drift apart without failing anything, and the experiment
// silently stops being about production's question.
describe("GAP_RESOLVED_QUESTION", () => {
  it("is asked with the id the verdict is read back under", () => {
    expect(GAP_RESOLVED_QUESTION.id).toBe("resolved");
    expect(GAP_RESOLVED_QUESTION.instructions).toContain("hedging");
  });

  it.each([
    ["production", join("src", "api", "knowledge.ts")],
    ["the replay harness", join("scripts", "replay-gap-decisions.ts")],
  ])("is imported by %s rather than repeated there", (_label: string, path: string) => {
    const source = readFileSync(join(process.cwd(), path), "utf8");

    expect(source).toContain("GAP_RESOLVED_QUESTION");
    expect(source).not.toContain(GAP_RESOLVED_QUESTION.instructions);
    expect(source).not.toContain(GAP_RESOLVED_QUESTION.whenTrue);
  });
});
