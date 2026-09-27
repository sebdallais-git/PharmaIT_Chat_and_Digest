import { describe, expect, it } from "@jest/globals";
import { buildReplayReport } from "../src/services/replay-report.js";
import type { ReplayRow } from "../src/services/replay-report.js";

const rows: ReplayRow[] = [
  { gapId: 1, baseline: "resolved", verdict: "resolved", probability: 0.95 },
  { gapId: 2, baseline: "unresolved", verdict: "unresolved", probability: 0.1 },
  { gapId: 3, baseline: "unresolved", verdict: "resolved", probability: 0.9 },
  { gapId: 4, baseline: "resolved", verdict: "unresolved", probability: 0.2 },
  { gapId: 5, baseline: "resolved", verdict: "review", probability: 0.7 },
];

describe("buildReplayReport", () => {
  it("counts agreement only where the scorer committed to a verdict", () => {
    const report = buildReplayReport(rows);

    expect(report.total).toBe(5);
    expect(report.agreed).toBe(2);
    expect(report.review).toBe(1);
  });

  // The two errors are not equal: a false "resolved" closes a gap that is
  // still open, which nothing later reopens. A false "unresolved" only costs
  // another ingest cycle. The report must separate them.
  it("separates the two directions of disagreement", () => {
    const report = buildReplayReport(rows);

    expect(report.falseResolved).toBe(1);
    expect(report.falseUnresolved).toBe(1);
  });

  // The distribution is the point of the exercise: if most gaps land in the
  // review band the thresholds are making the decision, not the model.
  it("buckets the probabilities into tenths", () => {
    const report = buildReplayReport(rows);

    expect(report.histogram["0.9-1.0"]).toBe(2);
    expect(report.histogram["0.7-0.8"]).toBe(1);
    expect(report.histogram["0.1-0.2"]).toBe(1);
    expect(report.histogram["0.2-0.3"]).toBe(1);
  });

  it("reports an empty set without dividing by zero", () => {
    const report = buildReplayReport([]);

    expect(report.total).toBe(0);
    expect(report.agreementRate).toBe(0);
    expect(report.dropped).toBe(0);
  });

  // A run where /api/decide failed on most gaps computes its rate over the few
  // that survived and prints like a clean pass. The count of what never got
  // scored has to travel with the rate.
  it("carries the gaps that were never scored", () => {
    const report = buildReplayReport(rows.slice(0, 2), 61);

    expect(report.total).toBe(2);
    expect(report.dropped).toBe(61);
  });
});
