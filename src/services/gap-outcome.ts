// The gap-resolution decision: the question production asks about a gap's new
// answer, and what the verdict does to the gap row.
//
// Extracted from the route handler so the branch logic is testable without an
// HTTP server or a database: the three store functions arrive as dependencies.

import type { Verdict } from "./decide-config.js";
import type { DecisionQuestion } from "./decide.js";

/**
 * The one question asked about a re-answered gap. The replay harness imports
 * this instead of repeating it: two copies that drift mean the harness
 * measures a different question than production asks, which invalidates the
 * experiment without failing anything.
 */
export const GAP_RESOLVED_QUESTION: DecisionQuestion = {
  id: "resolved",
  // Measured with scripts/replay-gap-decisions.ts --question on 2026-09-27: 71.9%
  // agreement with the 27B over 60 open gaps (the first wording: 34.6%). The
  // 27B still decides resolution; this is the question the scorer is recorded on.
  instructions:
    "Does the answer directly give the specific information the question asks for? Answer false if the answer says the provided context or sources do not contain the information, falls back on general knowledge, hedges, refuses, or only gives generic background instead of the specific facts asked for.",
  whenTrue: "The answer directly provides the specific facts the question asks for.",
  whenFalse: "The answer says the information is missing, falls back on general knowledge, hedges, refuses, or gives only generic background.",
};

export interface GapOutcomeDeps {
  resolveGap(id: number, response: string): void;
  markUnresolved(id: number): void;
  markForReview(id: number): void;
}

export function applyGapVerdict(
  verdict: Verdict,
  gapId: number,
  newResponse: string,
  deps: GapOutcomeDeps,
): void {
  switch (verdict) {
    case "resolved":
      deps.resolveGap(gapId, newResponse);
      return;
    case "unresolved":
      // markUnresolved increments retry_count; the loop tries again.
      deps.markUnresolved(gapId);
      return;
    case "review":
      // Deliberately no retry: the middle of the scorer's distribution is the
      // part least worth acting on, so the gap waits for a human instead of
      // burning an ingest cycle.
      deps.markForReview(gapId);
      return;
    default: {
      const never: never = verdict;
      throw new Error(`unknown verdict ${String(never)}`);
    }
  }
}
