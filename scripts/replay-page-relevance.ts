#!/usr/bin/env -S node --import tsx
// Acceptance harness for the gap workflow's page pre-check.
//
// Every past gap run in n8n's database stored each fetched page beside the
// 27B's extraction of it, and the workflow's filter says whether that
// extraction was kept. This asks the scorer the production relevance question
// about each page, through the same state the app builds, and reports per
// threshold how many discarded pages it would have skipped (27B time saved)
// and how many KEPT pages it would have skipped (knowledge lost -- the number
// that must stay at zero). Read-only on n8n; one scorer call per page.
//
// Pages with no topic come from the old "undefined" search bug and are
// reported apart: the app never asks the scorer about them.
//
// Usage: npx tsx scripts/replay-page-relevance.ts [--db ~/.n8n/database.sqlite]

import { serviceUrl } from "../src/platform/host-config.js";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PAGE_RELEVANT_QUESTION, pageRelevanceState } from "../src/services/page-relevance.js";
import { loadDecideConfig } from "../src/services/decide-config.js";
import { pagesFromRunData, reportRows, unflatten } from "./lib/page-relevance-replay.js";
import type { ReplayPage } from "./lib/page-relevance-replay.js";

const args = process.argv.slice(2);
const dbArg = args.indexOf("--db");
const DB_PATH = dbArg === -1 ? join(homedir(), ".n8n", "database.sqlite") : args[dbArg + 1];
const THRESHOLDS = [0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9];

function gapRunPages(): ReplayPage[] {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT e.id AS id, d.data AS data FROM execution_entity e
           JOIN execution_data d ON d.executionId = e.id
           JOIN workflow_entity w ON w.id = e.workflowId
          WHERE w.name LIKE '%Gap%' ORDER BY e.id`,
      )
      .all() as { id: number; data: string }[];
    return rows.flatMap((row) => {
      const parsed = unflatten(row.data) as { resultData?: { runData?: Record<string, unknown> } };
      return pagesFromRunData(row.id, parsed.resultData?.runData ?? {});
    });
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const token = readFileSync(join(process.cwd(), "data", "run", "api-token"), "utf8").trim();
  const all = gapRunPages();
  const noTopic = all.filter((p) => p.topic.trim() === "");
  const pages = all.filter((p) => p.topic.trim() !== "");
  const scored: (ReplayPage & { p: number })[] = [];
  let dropped = 0;

  for (const page of pages) {
    const resp = await fetch(`${serviceUrl("app")}/api/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ state: pageRelevanceState(page.topic, page.page), question: PAGE_RELEVANT_QUESTION }),
    });
    const decision = resp.ok ? ((await resp.json()) as { probability?: number }) : {};
    // Counted, not skipped silently: rates over a half-failed run look like a pass
    if (typeof decision.probability !== "number") {
      dropped += 1;
      console.error(`${page.url}: /api/decide gave no probability (HTTP ${resp.status}) -- dropped`);
      continue;
    }
    scored.push({ ...page, p: decision.probability });
  }

  const kept = scored.filter((p) => p.kept);
  const discarded = scored.length - kept.length;
  const configured = loadDecideConfig().pageRelevanceSkipBelow;
  console.log(`${scored.length} pages scored from ${new Set(scored.map((p) => p.exec)).size} gap runs: the 27B kept ${kept.length}, discarded ${discarded}`);
  console.log(`(${noTopic.length} pages with no topic left out; ${dropped} dropped)\n`);
  console.log("skip below | discarded pages skipped | KEPT pages lost");
  for (const row of reportRows(scored, THRESHOLDS)) {
    const mark = row.threshold === configured ? "  <- configured" : "";
    console.log(
      `${String(row.threshold).padEnd(10)} | ${`${row.skippedDiscarded} of ${discarded}`.padEnd(23)} | ${row.lostKept} of ${kept.length}${mark}`,
    );
  }
  if (kept.length > 0) {
    const lowest = kept.reduce((a, b) => (a.p < b.p ? a : b));
    console.log(`\nlowest-scoring kept page: p ${lowest.p.toFixed(3)} ${lowest.url}`);
  }
}

await main();
