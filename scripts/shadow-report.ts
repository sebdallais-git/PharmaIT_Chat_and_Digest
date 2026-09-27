#!/usr/bin/env -S node --import tsx
// Agreement report for shadow-mode gap DETECTION.
//
// Shadow mode records, for every chat turn, what the 27B decided and what the
// scorer would have decided (src/services/detection-shadow.ts). This prints the
// comparison using the same maths as the resolution replay -- one
// implementation of agreement, two directions of error, and the probability
// histogram.
//
// Read the same caveats the replay carries:
//
//   The baseline is the 27B's OPINION, not ground truth. This measures whether
//   a 4B could stand in for it, not whether either is right. The 27B's own
//   detection judgment has a known failure mode: checkConfidence() pulls JSON
//   out of the model's prose with a regex and returns { confident: true } when
//   the regex misses, so some "confident" baselines are parse failures rather
//   than judgments.
//
//   The DISTRIBUTION matters more than the agreement rate. If most turns land
//   between the thresholds, the thresholds are deciding rather than the model.
//
// Unlike the resolution replay this needs no backfill: the rows accrue from
// live traffic, which is the point of shadowing the high-volume path.
//
// Usage: npx tsx scripts/shadow-report.ts [--limit 500]

import Database from "better-sqlite3";
import { join } from "node:path";
import { openShadowStore, shadowRowsAsReplayRows } from "../src/services/detection-shadow.js";
import { buildReplayReport } from "../src/services/replay-report.js";

const args = process.argv.slice(2);
const limitArg = args.indexOf("--limit");
const limit = limitArg === -1 ? 500 : Number(args[limitArg + 1] ?? 500);

const db = new Database(join(process.cwd(), "data", "gap_log.db"), { readonly: true });
// openShadowStore() creates the table, which a read-only handle cannot do. The
// app creates it on its first detection after deploy, so before any chat
// traffic it simply does not exist yet: that means no rows, not an error.
const hasTable = db
  .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'detection_shadow'")
  .get() !== undefined;
const rows = hasTable ? openShadowStore(db).list(limit) : [];

if (rows.length === 0) {
  console.log("No shadow rows yet. Shadow mode is off by default — set shadow_detection: true in");
  console.log("config/decide.yaml, with the scorer installed, and let some chat traffic through.");
  process.exit(0);
}

const unanswered = rows.filter((r) => r.scorerVerdict === null).length;
const report = buildReplayReport(shadowRowsAsReplayRows(rows));

console.log(JSON.stringify(report, null, 2));
console.log(`\nturns recorded:                      ${rows.length}`);
console.log(`scorer never answered (excluded):    ${unanswered}`);
console.log(`agreement (of ${report.total - report.review} committed): ${(report.agreementRate * 100).toFixed(1)}%`);
// Named in detection's terms rather than resolution's: here a false "confident"
// means a real gap was never logged and no ingest ever ran for it.
console.log(`scorer confident, 27B was not:       ${report.falseResolved}  (a gap that would never be logged)`);
console.log(`27B confident, scorer was not:       ${report.falseUnresolved}  (a spurious gap and a wasted ingest)`);
console.log(`parked for review:                   ${report.review} of ${report.total}`);
console.log(`\nIf most rows sit in the middle buckets, the thresholds are deciding, not the model.`);

db.close();
