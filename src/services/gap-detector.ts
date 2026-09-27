// Knowledge gap detection service and N8N webhook triggering

import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { getLlmClient } from "./llm-client.js";
import type { ChatMessage } from "./llm-client.js";
import { isBenchmarkActive, trackJob } from "./bench-mode.js";
import { decide } from "./decide.js";
import { loadDecideConfig } from "./decide-config.js";
import type { DecideConfig } from "./decide-config.js";
import { openShadowStore, recordShadowDecision } from "./detection-shadow.js";
import type { ShadowDeps, ShadowStore } from "./detection-shadow.js";
import { isScorerConfigured } from "./health.js";
import { readScorerKey } from "../api/decide.js";

const DB_PATH = join(process.cwd(), "data", "gap_log.db");

let db: Database.Database;

// Shadow scoring shares gap_log.db rather than opening a second connection to
// the same domain, and is built lazily on first use so importing this module
// reads no config and opens nothing.
let shadow: ShadowStore | null = null;

function shadowStore(): ShadowStore {
  return (shadow ??= openShadowStore(db));
}

// Inert unless a scorer is actually installed AND config asks for it, so a
// machine without open-jev pays nothing and writes nothing.
function shadowDeps(): ShadowDeps {
  let enabled = false;
  let config: DecideConfig | null = null;
  try {
    config = loadDecideConfig();
    enabled = config.shadowDetection && isScorerConfigured();
  } catch {
    // A missing or malformed decide.yaml disables shadow mode; it must never
    // take down detection, which creates every gap in the system.
    enabled = false;
  }
  return {
    enabled,
    decide: (question, state) =>
      decide(question, state, { config: config as DecideConfig, apiKey: readScorerKey(), fetchImpl: fetch }),
  };
}

// Initialise la base SQLite pour le suivi des lacunes
export function initGapDB(): void {
  mkdirSync(join(process.cwd(), "data"), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS gap_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      original_query TEXT NOT NULL,
      search_topic TEXT,
      reason TEXT,
      was_triggered INTEGER NOT NULL DEFAULT 0,
      gemma_response TEXT,
      status TEXT NOT NULL DEFAULT 'detected'
    )
  `);

  // Add columns if they don't exist (safe migration)
  const columns = db.prepare("PRAGMA table_info(gap_log)").all() as Array<{ name: string }>;
  const colNames = new Set(columns.map((c) => c.name));

  if (!colNames.has("retry_count")) {
    db.exec("ALTER TABLE gap_log ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!colNames.has("resolved_at")) {
    db.exec("ALTER TABLE gap_log ADD COLUMN resolved_at TEXT");
  }
  if (!colNames.has("resolved_response")) {
    db.exec("ALTER TABLE gap_log ADD COLUMN resolved_response TEXT");
  }
}

interface ConfidenceResult {
  confident: boolean;
  reason: string;
  search_topic: string;
}

// Secondary LLM call to evaluate response confidence
export async function checkConfidence(
  originalQuestion: string,
  gemmaResponse: string
): Promise<ConfidenceResult> {
  const prompt = `Analyze this Q&A exchange. Did the assistant actually answer the question with specific, confident information? Or did it hedge, say it doesn't know, provide only vague/generic information, or fail to address the question?

Question: ${originalQuestion}
Answer: ${gemmaResponse}

Respond with ONLY a JSON object, no other text:
{"confident": true/false, "reason": "brief explanation", "search_topic": "2-5 word search query if not confident"}`;

  try {
    const messages: ChatMessage[] = [
      { role: "user", content: prompt },
    ];
    const response = await getLlmClient().chat(messages, { temperature: 0.1 });

    // Extract JSON from the response
    const jsonMatch = response.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) {
      return { confident: true, reason: "Could not parse confidence check", search_topic: "" };
    }

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    return {
      confident: Boolean(parsed.confident),
      reason: String(parsed.reason ?? ""),
      search_topic: String(parsed.search_topic ?? ""),
    };
  } catch {
    // Default to confident=true to avoid false triggers
    return { confident: true, reason: "Confidence check failed", search_topic: "" };
  }
}

// Check if a similar topic was triggered in the last 2 hours
function isOnCooldown(searchTopic: string): boolean {
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const row = db.prepare(
    `SELECT COUNT(*) as count FROM gap_log
     WHERE search_topic = ? AND was_triggered = 1 AND timestamp > ?`
  ).get(searchTopic, twoHoursAgo) as { count: number };
  return row.count > 0;
}

// Log a gap detection in the database — returns the gap ID
export function logGap(
  originalQuery: string,
  searchTopic: string,
  reason: string,
  gemmaResponse: string,
  wasTriggered: boolean
): number {
  const result = db.prepare(
    `INSERT INTO gap_log (timestamp, original_query, search_topic, reason, was_triggered, gemma_response, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    new Date().toISOString(),
    originalQuery,
    searchTopic,
    reason,
    wasTriggered ? 1 : 0,
    gemmaResponse,
    wasTriggered ? "triggered" : "skipped"
  );
  return result.lastInsertRowid as number;
}

// Send the N8N webhook asynchronously
export async function triggerWebhook(
  originalQuery: string,
  searchTopic: string,
  gemmaResponse: string,
  reason: string,
  gapId: number
): Promise<void> {
  const webhookUrl = process.env.N8N_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn("[Gap Detector] N8N_WEBHOOK_URL not set, skipping webhook");
    return;
  }

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        gap_id: gapId,
        original_query: originalQuery,
        search_topic: searchTopic,
        timestamp: new Date().toISOString(),
        gemma_response: gemmaResponse,
        reason,
      }),
      signal: AbortSignal.timeout(10000),
    });
    console.log(`[Gap Detector] Webhook triggered for topic: "${searchTopic}" (gap_id: ${gapId})`);
  } catch (err) {
    console.error("[Gap Detector] Webhook failed:", err);
  }
}

// Guard: only one gap detection at a time so we don't hog the LLM stack
let gapDetectionRunning = false;

// Orchestrate detection: confidence check → cooldown → log → webhook
export async function handleGapDetection(
  originalQuery: string,
  gemmaResponse: string
): Promise<boolean> {
  // Benchmarks need the GPU to themselves
  if (isBenchmarkActive()) return false;

  // Skip if another gap detection is already running — don't queue behind it
  if (gapDetectionRunning) {
    console.log("[Gap Detector] Skipped — another detection already in progress");
    return false;
  }

  gapDetectionRunning = true;
  try {
    const result = await trackJob("gap-detection", () => checkConfidence(originalQuery, gemmaResponse));

    // Shadow mode: ask the scorer the same question and store both answers.
    // The 27B's verdict above is still the one that acts -- see R1 in
    // detection-shadow.ts. This cannot throw and cannot change what follows.
    await recordShadowDecision(shadowStore(), originalQuery, gemmaResponse, result.confident, shadowDeps());

    if (result.confident) {
      return false;
    }

  const onCooldown = isOnCooldown(result.search_topic);
  const gapId = logGap(originalQuery, result.search_topic, result.reason, gemmaResponse, !onCooldown);

  if (!onCooldown) {
    // Async webhook — don't block the response
    triggerWebhook(originalQuery, result.search_topic, gemmaResponse, result.reason, gapId)
      .catch((err: unknown) => console.error("[Gap Detector] Async webhook error:", err));
  } else {
    console.log(`[Gap Detector] Topic "${result.search_topic}" on cooldown, skipped webhook`);
  }

  return true;
  } finally {
    gapDetectionRunning = false;
  }
}

// --- Query functions for the API ---

export interface GapLogEntry {
  id: number;
  timestamp: string;
  original_query: string;
  search_topic: string;
  reason: string;
  was_triggered: boolean;
  gemma_response: string;
  status: string;
}

export function getRecentGaps(limit: number = 50): GapLogEntry[] {
  const rows = db.prepare(
    `SELECT * FROM gap_log ORDER BY id DESC LIMIT ?`
  ).all(limit) as Array<{
    id: number;
    timestamp: string;
    original_query: string;
    search_topic: string;
    reason: string;
    was_triggered: number;
    gemma_response: string;
    status: string;
  }>;

  return rows.map((r) => ({
    ...r,
    was_triggered: r.was_triggered === 1,
  }));
}

export interface GapStats {
  total_detected: number;
  total_triggered: number;
  total_resolved: number;
  most_common_topics: Array<{ topic: string; count: number }>;
}

// Mark a gap as resolved
export function resolveGap(gapId: number, newResponse: string): void {
  db.prepare(
    `UPDATE gap_log SET status = 'resolved', resolved_at = ?, resolved_response = ? WHERE id = ?`
  ).run(new Date().toISOString(), newResponse, gapId);
}

// Mark a gap as unresolved and increment retry count
export function markUnresolved(gapId: number): void {
  db.prepare(
    `UPDATE gap_log SET status = 'unresolved', retry_count = retry_count + 1 WHERE id = ?`
  ).run(gapId);
}

// Parks a gap the scorer was not confident about. Unlike markUnresolved this
// does NOT touch retry_count: a gap nobody is sure about should not consume an
// ingest cycle.
export function markForReview(gapId: number): void {
  db.prepare("UPDATE gap_log SET status = 'review' WHERE id = ?").run(gapId);
}

// Get a single gap by ID
export function getGapById(gapId: number): GapLogEntry | undefined {
  const row = db.prepare("SELECT * FROM gap_log WHERE id = ?").get(gapId) as {
    id: number;
    timestamp: string;
    original_query: string;
    search_topic: string;
    reason: string;
    was_triggered: number;
    gemma_response: string;
    status: string;
  } | undefined;

  if (!row) return undefined;

  return { ...row, was_triggered: row.was_triggered === 1 };
}

export function getGapStats(): GapStats {
  const total = db.prepare(
    "SELECT COUNT(*) as count FROM gap_log"
  ).get() as { count: number };

  const triggered = db.prepare(
    "SELECT COUNT(*) as count FROM gap_log WHERE was_triggered = 1"
  ).get() as { count: number };

  const resolved = db.prepare(
    "SELECT COUNT(*) as count FROM gap_log WHERE status = 'resolved'"
  ).get() as { count: number };

  const topics = db.prepare(
    `SELECT search_topic as topic, COUNT(*) as count
     FROM gap_log
     WHERE search_topic IS NOT NULL AND search_topic != ''
     GROUP BY search_topic
     ORDER BY count DESC
     LIMIT 10`
  ).all() as Array<{ topic: string; count: number }>;

  return {
    total_detected: total.count,
    total_triggered: triggered.count,
    total_resolved: resolved.count,
    most_common_topics: topics,
  };
}
