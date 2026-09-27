#!/usr/bin/env -S node --import tsx
// Acceptance harness for the System One scorer.
//
// Stage 1 (--backfill): runs the existing 27B checkConfidence() over the
// triggered gaps that have a gemma_response, writing the result to a local
// baseline file. Slow and sequential, and it competes with live chat -- run it
// when nobody is using the app.
//
// Stage 2 (default): replays those gaps through /api/decide and reports
// agreement, the two directions of disagreement, and the probability
// distribution.
//
// The baseline is the 27B's opinion, not ground truth. This measures whether a
// 4B can stand in for the 27B on this task; it does not measure whether the
// 27B was right -- and the 27B's own judgment had a known failure mode (a
// parse miss returned confident: true, silently closing gaps). Agreement with
// this baseline is not the same thing as either model being correct.
//
// Every label in the baseline is produced HERE, by the 27B, and the file says
// so. An earlier version adopted a row's existing resolved/unresolved status
// as its baseline label -- but once the scorer has run, the SCORER wrote those
// statuses, so a second --backfill measured the 4B against itself and reported
// near-perfect agreement. A baseline that predates this provenance stamp is
// refused rather than trusted.
//
// Usage:
//   npx tsx scripts/replay-gap-decisions.ts --backfill [--limit 63]
//   npx tsx scripts/replay-gap-decisions.ts [--limit 63]

import Database from "better-sqlite3";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkConfidence } from "../src/services/gap-detector.js";
import { GAP_RESOLVED_QUESTION } from "../src/services/gap-outcome.js";
import { buildReplayReport } from "../src/services/replay-report.js";
import type { ReplayRow } from "../src/services/replay-report.js";
import { isRecord } from "../src/services/decide-config.js";
import type { Verdict } from "../src/services/decide-config.js";

const BASELINE_PATH = join(process.cwd(), "data", "run", "gap-baseline.json");
const DB_PATH = join(process.cwd(), "data", "gap_log.db");
// The spec's population: gaps nobody has decided yet. A row the scorer has
// already moved to resolved/unresolved is no longer a question the 27B and the
// 4B can be compared on.
const GAP_STATUS = "triggered";
// Stamped into the baseline file and required when reading it back.
const LABELLED_BY = "27b-checkConfidence";

interface GapRow {
  id: number;
  original_query: string;
  gemma_response: string;
  status: string;
}

type Label = "resolved" | "unresolved";

interface BaselineFile {
  labelled_by: string;
  generated_at: string;
  gap_status: string;
  labels: Record<string, Label>;
}

function gapsWithAnswers(limit: number): GapRow[] {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT id, original_query, gemma_response, status
           FROM gap_log
          WHERE status = ?
            AND gemma_response IS NOT NULL AND gemma_response != ''
          ORDER BY id DESC
          LIMIT ?`,
      )
      .all(GAP_STATUS, limit) as GapRow[];
  } finally {
    db.close();
  }
}

async function backfill(limit: number): Promise<void> {
  const rows = gapsWithAnswers(limit);
  const labels: Record<string, Label> = {};
  console.log(`[backfill] labelling ${rows.length} ${GAP_STATUS} gaps with the 27B -- slow, and it uses the shared model`);
  for (const [i, row] of rows.entries()) {
    const confidence = await checkConfidence(row.original_query, row.gemma_response);
    labels[String(row.id)] = confidence.confident ? "resolved" : "unresolved";
    console.log(`[backfill] ${i + 1}/${rows.length} gap ${row.id} -> ${labels[String(row.id)]}`);
  }
  const baseline: BaselineFile = {
    labelled_by: LABELLED_BY,
    generated_at: new Date().toISOString(),
    gap_status: GAP_STATUS,
    labels,
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2));
  console.log(`[backfill] wrote ${BASELINE_PATH}`);
}

function readBaseline(): Record<string, Label> {
  let text: string;
  try {
    text = readFileSync(BASELINE_PATH, "utf8");
  } catch {
    throw new Error(`no baseline at ${BASELINE_PATH} -- run this script with --backfill first`);
  }
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || parsed.labelled_by !== LABELLED_BY || !isRecord(parsed.labels)) {
    throw new Error(
      `${BASELINE_PATH} was not written by this version (no "${LABELLED_BY}" stamp). ` +
        "Older baselines adopted statuses the scorer itself may have written, which measures the scorer " +
        "against itself -- delete the file and re-run with --backfill.",
    );
  }
  const labels: Record<string, Label> = {};
  for (const [id, label] of Object.entries(parsed.labels)) {
    if (label === "resolved" || label === "unresolved") labels[id] = label;
  }
  return labels;
}

async function replay(limit: number): Promise<void> {
  const baseline = readBaseline();
  const token = readFileSync(join(process.cwd(), "data", "run", "api-token"), "utf8").trim();
  const rows: ReplayRow[] = [];
  let unlabelled = 0;
  let dropped = 0;

  for (const row of gapsWithAnswers(limit)) {
    const label = baseline[String(row.id)];
    if (label === undefined) {
      unlabelled += 1;
      continue;
    }

    const resp = await fetch("http://127.0.0.1:3000/api/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        state: `Question: ${row.original_query}\nAnswer: ${row.gemma_response}`,
        // The same question production asks, imported rather than repeated.
        question: GAP_RESOLVED_QUESTION,
      }),
    });
    if (!resp.ok) {
      // Counted, not just logged: a rate computed over the survivors of a
      // half-failed run prints exactly like a pass over the whole set.
      dropped += 1;
      console.error(`gap ${row.id}: /api/decide returned ${resp.status} -- dropped`);
      continue;
    }
    const decision = (await resp.json()) as { verdict?: Verdict; probability?: number };
    // An undefined probability would land in histogram["NaN-NaN"] and wreck the
    // one number the exercise is about, so it is a drop, not a row.
    if (decision.verdict === undefined || typeof decision.probability !== "number") {
      dropped += 1;
      console.error(`gap ${row.id}: /api/decide returned no usable decision -- dropped`);
      continue;
    }
    rows.push({ gapId: row.id, baseline: label, verdict: decision.verdict, probability: decision.probability });
  }

  const report = buildReplayReport(rows, dropped);
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nscored ${report.total} gaps; dropped ${report.dropped}; ${unlabelled} had no baseline label`);
  console.log(`agreement (of ${report.total - report.review} committed): ${(report.agreementRate * 100).toFixed(1)}%`);
  console.log(`false resolved (closes an open gap): ${report.falseResolved}`);
  console.log(`false unresolved (burns a retry):    ${report.falseUnresolved}`);
  console.log(`parked for review:                   ${report.review} of ${report.total}`);
  if (report.dropped > 0) {
    console.log(`\n${report.dropped} gaps were not scored at all: the rates above cover ${report.total} of ${report.total + report.dropped}.`);
  }
  console.log(`\nIf most rows sit in the 0.5-0.8 buckets, the thresholds are deciding, not the model.`);
}

const args = process.argv.slice(2);
const limitArg = args.indexOf("--limit");
const limit = limitArg === -1 ? 100 : Number(args[limitArg + 1] ?? 100);
await (args.includes("--backfill") ? backfill(limit) : replay(limit));
