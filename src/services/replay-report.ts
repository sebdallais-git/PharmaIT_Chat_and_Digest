// Reporting for the scorer replay. Pure: the script supplies the rows.
//
// The agreement rate alone is not the result. A scorer that answers "review"
// to everything agrees with nothing and disagrees with nothing, and a scorer
// whose probabilities all cluster in the review band is being decided by the
// thresholds rather than deciding anything. The histogram is what shows that,
// which is why it is part of the report rather than a debugging aid.

import type { Verdict } from "./decide-config.js";

export interface ReplayRow {
  gapId: number;
  baseline: "resolved" | "unresolved";
  verdict: Verdict;
  probability: number;
}

export interface ReplayReport {
  total: number;
  agreed: number;
  agreementRate: number;
  falseResolved: number; // baseline unresolved, scorer resolved -- closes an open gap
  falseUnresolved: number; // baseline resolved, scorer unresolved -- burns a retry
  review: number;
  // Gaps the replay could not score at all -- a non-ok /api/decide, a response
  // it could not read. Reported because an agreement rate computed over a
  // handful of surviving rows reads exactly like a pass over all of them.
  dropped: number;
  histogram: Record<string, number>; // 10 buckets of 0.1
}

function bucketOf(p: number): string {
  const lower = Math.min(0.9, Math.floor(p * 10) / 10);
  return `${lower.toFixed(1)}-${(lower + 0.1).toFixed(1)}`;
}

export function buildReplayReport(rows: ReplayRow[], dropped: number = 0): ReplayReport {
  const histogram: Record<string, number> = {};
  for (let i = 0; i < 10; i += 1) {
    histogram[`${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}`] = 0;
  }

  let agreed = 0;
  let falseResolved = 0;
  let falseUnresolved = 0;
  let review = 0;

  for (const row of rows) {
    histogram[bucketOf(row.probability)] += 1;
    if (row.verdict === "review") {
      review += 1;
      continue;
    }
    if (row.verdict === row.baseline) {
      agreed += 1;
    } else if (row.verdict === "resolved") {
      falseResolved += 1;
    } else {
      falseUnresolved += 1;
    }
  }

  const committed = rows.length - review;
  return {
    total: rows.length,
    agreed,
    agreementRate: committed === 0 ? 0 : agreed / committed,
    falseResolved,
    falseUnresolved,
    review,
    dropped,
    histogram,
  };
}
