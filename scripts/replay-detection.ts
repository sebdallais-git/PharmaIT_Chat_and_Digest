#!/usr/bin/env -S node --import tsx
// Acceptance harness for the System One scorer on gap DETECTION.
//
// replay-gap-decisions.ts only sees answers that were flagged as gaps (the
// gap_log rows): it measures whether the scorer catches non-answers, and says
// nothing about false alarms on good answers -- the common case, and the one a
// scorer that cries wolf would turn into needless web-search ingests.
// request_log holds those confident questions but not their answers, so:
//
// Stage 1 (--backfill): for each past question the 27B found confident (all
// of them with --all), regenerate an answer through /api/chat in benchmark
// mode (no gap detection, no request logging, temperature 0, no live news),
// label it with the 27B's checkConfidence, and save the row at once. Slow --
// about a minute per question on the shared 27B -- so run it when nobody is
// chatting; an interrupted run resumes where it stopped.
//
// Stage 2 (default): asks the scorer the detection question about each saved
// answer through /api/decide and reports agreement with the 27B.
//
// As with the gap replay, the 27B's label is a baseline, not ground truth, and
// it describes the regenerated answer, not the one the user saw.
//
// Usage:
//   npx tsx scripts/replay-detection.ts --backfill [--limit 30] [--all]
//   npx tsx scripts/replay-detection.ts [--question candidate.json] [--details]

import { serviceUrl } from "../src/platform/host-config.js";
import Database from "better-sqlite3";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkConfidence } from "../src/services/gap-detector.js";
import { ANSWER_CONFIDENT_QUESTION } from "../src/services/detection-shadow.js";
import type { DecisionQuestion } from "../src/services/decide.js";
import type { Verdict } from "../src/services/decide-config.js";
import { buildReplayReport } from "../src/services/replay-report.js";
import type { ReplayRow } from "../src/services/replay-report.js";
import { candidateQuestion } from "./lib/candidate-question.js";
import {
  DETECTION_LABELLED_BY,
  labelFromConfidence,
  parseDetectionBaseline,
  pendingQueries,
  readChatAnswer,
} from "./lib/detection-baseline.js";
import type { DetectionBaseline, QueryCandidate } from "./lib/detection-baseline.js";

const APP_URL = serviceUrl("app");
const BASELINE_PATH = join(process.cwd(), "data", "run", "detection-baseline.json");
const DB_PATH = join(process.cwd(), "data", "gap_log.db");
// Same ceiling as benchmark-stack.ts: a long answer on a busy 27B
const CHAT_TIMEOUT_MS = 600_000;

function apiToken(): string {
  return readFileSync(join(process.cwd(), "data", "run", "api-token"), "utf8").trim();
}

function pastQuestions(includeUnconfident: boolean): QueryCandidate[] {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT id, query FROM request_log
          WHERE query != '' ${includeUnconfident ? "" : "AND was_confident = 1"}
          ORDER BY id DESC`,
      )
      .all() as QueryCandidate[];
  } finally {
    db.close();
  }
}

function loadBaseline(): DetectionBaseline {
  let text: string;
  try {
    text = readFileSync(BASELINE_PATH, "utf8");
  } catch {
    return { labelled_by: DETECTION_LABELLED_BY, generated_at: new Date().toISOString(), rows: [] };
  }
  return parseDetectionBaseline(JSON.parse(text));
}

async function regenerate(query: string, token: string): Promise<{ answer: string; error?: string }> {
  try {
    const resp = await fetch(`${APP_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: query, benchmark: true }),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });
    if (!resp.ok || !resp.body) return { answer: "", error: `HTTP ${resp.status}` };
    return await readChatAnswer(resp.body);
  } catch (err) {
    return { answer: "", error: err instanceof Error ? err.message : String(err) };
  }
}

async function backfill(limit: number, includeUnconfident: boolean): Promise<void> {
  const baseline = loadBaseline();
  const token = apiToken();
  const pending = pendingQueries(pastQuestions(includeUnconfident), baseline.rows, limit);
  console.log(
    `[backfill] ${baseline.rows.length} already labelled; regenerating ${pending.length} -- ` +
      "about a minute each on the shared 27B",
  );
  let skipped = 0;
  for (const [i, candidate] of pending.entries()) {
    const started = Date.now();
    const { answer, error } = await regenerate(candidate.query, token);
    if (error !== undefined || answer.trim() === "") {
      skipped += 1;
      console.error(`[backfill] ${i + 1}/${pending.length} request ${candidate.id}: no answer (${error ?? "empty"}) -- skipped`);
      continue;
    }
    const label = labelFromConfidence(await checkConfidence(candidate.query, answer));
    if (label === null) {
      skipped += 1;
      console.error(`[backfill] ${i + 1}/${pending.length} request ${candidate.id}: 27B verdict unparseable -- skipped`);
      continue;
    }
    baseline.rows.push({ requestId: candidate.id, query: candidate.query, answer, label });
    baseline.generated_at = new Date().toISOString();
    // Saved after every row: a 2-hour run must survive a Ctrl-C or a crash
    writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2), { mode: 0o600 });
    const secs = Math.round((Date.now() - started) / 1000);
    console.log(`[backfill] ${i + 1}/${pending.length} request ${candidate.id} -> ${label} (${secs} s)`);
  }
  console.log(`[backfill] ${baseline.rows.length} rows in ${BASELINE_PATH}; ${skipped} skipped this run`);
}

async function replay(question: DecisionQuestion, details: boolean): Promise<void> {
  const baseline = loadBaseline();
  if (baseline.rows.length === 0) throw new Error(`no rows in ${BASELINE_PATH} -- run with --backfill first`);
  const token = apiToken();
  const rows: ReplayRow[] = [];
  let dropped = 0;

  for (const row of baseline.rows) {
    const resp = await fetch(`${APP_URL}/api/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ state: `Question: ${row.query}\nAnswer: ${row.answer}`, question }),
    });
    const decision = resp.ok ? ((await resp.json()) as { verdict?: Verdict; probability?: number }) : {};
    // Counted, not just logged: a rate over the survivors of a half-failed
    // run prints exactly like a pass over the whole set.
    if (decision.verdict === undefined || typeof decision.probability !== "number") {
      dropped += 1;
      console.error(`request ${row.requestId}: /api/decide gave no usable decision (HTTP ${resp.status}) -- dropped`);
      continue;
    }
    rows.push({ gapId: row.requestId, baseline: row.label, verdict: decision.verdict, probability: decision.probability });
    if (details && decision.verdict !== row.label) {
      console.log(`request ${row.requestId}: 27B ${row.label}, scorer ${decision.verdict} (noul ${decision.probability.toFixed(3)}) -- ${row.query.slice(0, 80)}`);
    }
  }

  const report = buildReplayReport(rows, dropped);
  const confident = baseline.rows.filter((r) => r.label === "resolved").length;
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nscored ${report.total} answers (27B: ${confident} confident, ${baseline.rows.length - confident} not); dropped ${report.dropped}`);
  console.log(`agreement (of ${report.total - report.review} committed): ${(report.agreementRate * 100).toFixed(1)}%`);
  console.log(`missed gap (scorer confident, 27B not):  ${report.falseResolved}`);
  console.log(`false alarm (scorer doubts a good answer): ${report.falseUnresolved}`);
  console.log(`parked for review:                        ${report.review} of ${report.total}`);
}

const args = process.argv.slice(2);
const limitArg = args.indexOf("--limit");
const limit = limitArg === -1 ? 30 : Number(args[limitArg + 1] ?? 30);
const questionArg = args.indexOf("--question");
const question =
  questionArg === -1
    ? ANSWER_CONFIDENT_QUESTION
    : candidateQuestion(JSON.parse(readFileSync(args[questionArg + 1], "utf8")), ANSWER_CONFIDENT_QUESTION.id);
if (questionArg !== -1) console.log(`replaying with the candidate question in ${args[questionArg + 1]}`);
await (args.includes("--backfill") ? backfill(limit, args.includes("--all")) : replay(question, args.includes("--details")));
