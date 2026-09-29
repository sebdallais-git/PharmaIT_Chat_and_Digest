// KB canaries: a daily check that the knowledge base still answers what it is
// known to hold.
//
// Each canary is a question plus the facts its answer must contain
// (config/kb-canaries.yaml). A canary passes when the chat retrieved at least
// one chunk and every group of expected terms has a term in the answer. The
// check is plain string matching on purpose: model judgments of answers follow
// the prompt's wording (measured on both the 4B scorer and the 27B), so a
// monitor built on one would drift with it.
//
// Replaced the n8n "KB health monitor" on 2026-09-29. That workflow sent no
// API token, parsed the SSE chat stream as JSON, had the 27B grade answers 0-10
// with an unmeasured rubric, ran its chats through gap detection, and kept its
// reports in memory.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { parse as parseYamlDocument } from "yaml";
import { isRecord } from "./decide-config.js";
import { parseSseLines } from "./llm-client.js";

export const DEFAULT_CANARY_CONFIG = resolve(process.cwd(), "config", "kb-canaries.yaml");

export interface Canary {
  id: string;
  question: string;
  // Every group must have at least one of its terms in the answer
  expect: string[][];
}

export interface ChatReply {
  answer: string;
  chunkCount: number;
  error?: string;
}

export interface CanaryResult {
  id: string;
  question: string;
  ok: boolean;
  // First term of each group with no match
  missing: string[];
  chunkCount: number;
  error?: string;
  ms: number;
  retried: boolean;
}

export interface CanaryRun {
  timestamp: string;
  passed: number;
  total: number;
  results: CanaryResult[];
}

export type AskChat = (question: string) => Promise<ChatReply>;

function configError(message: string): Error {
  return new Error(`kb canaries: ${message}`);
}

function parseTermGroup(raw: unknown, id: string): string[] {
  const terms = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(terms) || terms.length === 0 || !terms.every((t) => typeof t === "string" && t.trim() !== "")) {
    throw configError(`"${id}" has an empty or non-string expected term`);
  }
  return terms as string[];
}

export function parseCanaryConfig(raw: unknown): Canary[] {
  if (!isRecord(raw) || !Array.isArray(raw.canaries) || raw.canaries.length === 0) {
    throw configError("expected a non-empty `canaries` list");
  }
  const seen = new Set<string>();
  return raw.canaries.map((entry: unknown, index: number): Canary => {
    if (!isRecord(entry)) throw configError(`entry ${index + 1} is not a mapping`);
    const { id, question, expect } = entry;
    if (typeof id !== "string" || id.trim() === "") throw configError(`entry ${index + 1} has no id`);
    if (seen.has(id)) throw configError(`duplicate id "${id}"`);
    seen.add(id);
    if (typeof question !== "string" || question.trim() === "") throw configError(`"${id}" has no question`);
    if (!Array.isArray(expect) || expect.length === 0) throw configError(`"${id}" has no expected terms`);
    return { id, question, expect: expect.map((group) => parseTermGroup(group, id)) };
  });
}

export function loadCanaries(path: string = DEFAULT_CANARY_CONFIG): Canary[] {
  return parseCanaryConfig(parseYamlDocument(readFileSync(path, "utf-8")));
}

export function checkCanary(canary: Canary, reply: ChatReply, ms: number, retried = false): CanaryResult {
  const answer = reply.answer.toLowerCase();
  const missing = canary.expect
    .filter((group) => !group.some((term) => answer.includes(term.toLowerCase())))
    .map((group) => group[0]);
  const ok = !reply.error && reply.chunkCount >= 1 && missing.length === 0;
  return {
    id: canary.id,
    question: canary.question,
    ok,
    missing,
    chunkCount: reply.chunkCount,
    ...(reply.error ? { error: reply.error } : {}),
    ms,
    retried,
  };
}

async function askOnce(ask: AskChat, canary: Canary, retried: boolean): Promise<CanaryResult> {
  const start = Date.now();
  let reply: ChatReply;
  try {
    reply = await ask(canary.question);
  } catch (err) {
    reply = { answer: "", chunkCount: 0, error: err instanceof Error ? err.message : String(err) };
  }
  return checkCanary(canary, reply, Date.now() - start, retried);
}

/**
 * Ask every canary in turn (one chat at a time: the stack runs one prefill at
 * a time anyway). A failed canary is asked once more and only counts as failed
 * if the retry fails too: local generation varies, and a monitor that alerts on
 * one odd answer gets ignored.
 */
export async function runCanaries(canaries: Canary[], ask: AskChat, now: () => Date = () => new Date()): Promise<CanaryRun> {
  const timestamp = now().toISOString();
  const results: CanaryResult[] = [];
  for (const canary of canaries) {
    const first = await askOnce(ask, canary, false);
    results.push(first.ok ? first : await askOnce(ask, canary, true));
  }
  return { timestamp, passed: results.filter((r) => r.ok).length, total: results.length, results };
}

/** Empty when everything passed: the Hermes job stays silent on a good night. */
export function formatFailureSummary(run: CanaryRun): string {
  if (run.passed === run.total) return "";
  const errors = new Set(run.results.map((r) => r.error));
  const [onlyError] = errors;
  if (run.passed === 0 && errors.size === 1 && onlyError) {
    return `KB canary: 0/${run.total} passed, every question failed with: ${onlyError}`;
  }
  const lines = run.results
    .filter((r) => !r.ok)
    .map((r) => {
      if (r.error) return `- ${r.id}: ${r.error}`;
      const missing = r.missing.length > 0 ? `missing ${r.missing.join(", ")}` : "no chunks retrieved";
      return `- ${r.id}: ${missing} (${r.chunkCount} chunks)`;
    });
  return [`KB canary: ${run.passed}/${run.total} passed`, ...lines].join("\n");
}

export interface CanarySummary {
  status: "ok" | "failing" | "stale" | "never-run";
  latest: CanaryRun | null;
  history: { timestamp: string; passed: number; total: number }[];
}

// The job runs daily; a day and a half without a run means it stopped
const STALE_AFTER_MS = 36 * 60 * 60 * 1000;

/** For GET /api/dashboard/kb-health. `runs` newest first, as the store lists them. */
export function summarizeCanaryRuns(runs: CanaryRun[], now: Date = new Date()): CanarySummary {
  const latest = runs[0] ?? null;
  const history = runs.map(({ timestamp, passed, total }) => ({ timestamp, passed, total }));
  if (!latest) return { status: "never-run", latest: null, history };
  const stale = now.getTime() - new Date(latest.timestamp).getTime() > STALE_AFTER_MS;
  const status = stale ? "stale" : latest.passed === latest.total ? "ok" : "failing";
  return { status, latest, history };
}

type FetchLike =(url: string, init?: RequestInit) => Promise<Response>;

interface ChatEvent {
  token?: string;
  error?: string;
  done?: boolean;
  chunkIds?: unknown[];
}

// Well above a cold long answer on the slowest stack; Node's fetch caps at 300 s anyway
const CHAT_TIMEOUT_MS = 290_000;

/**
 * Chat as a benchmark request: the app then skips gap detection, request
 * logging and the detection shadow, so canaries never create gaps or skew the
 * dashboard, and it returns the retrieved chunk ids with the done event.
 */
export function createChatAsker(appUrl: string, token: string | null, fetchImpl: FetchLike = fetch): AskChat {
  return async (question) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const resp = await fetchImpl(`${appUrl}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message: question, benchmark: true }),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });
    if (!resp.ok || !resp.body) return { answer: "", chunkCount: 0, error: `HTTP ${resp.status}` };

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let answer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseLines(buffer);
      buffer = parsed.rest;
      for (const data of parsed.events) {
        const event = JSON.parse(data) as ChatEvent;
        if (event.error) return { answer, chunkCount: 0, error: event.error };
        if (event.token) answer += event.token;
        if (event.done) return { answer, chunkCount: Array.isArray(event.chunkIds) ? event.chunkIds.length : 0 };
      }
    }
    return { answer, chunkCount: 0, error: "stream ended without a done event" };
  };
}

export interface CanaryStore {
  record(run: CanaryRun): void;
  list(limit: number): CanaryRun[];
  close(): void;
}

interface CanaryDbRow {
  timestamp: string;
  passed: number;
  total: number;
  results_json: string;
}

// Shares gap_log.db with the other chat-quality tables
export function openCanaryStore(db: SqliteDatabase): CanaryStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kb_canary_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      passed INTEGER NOT NULL,
      total INTEGER NOT NULL,
      results_json TEXT NOT NULL
    );
  `);
  const insert = db.prepare(
    `INSERT INTO kb_canary_runs (timestamp, passed, total, results_json) VALUES (@timestamp, @passed, @total, @resultsJson)`,
  );
  const selectRecent = db.prepare(`SELECT timestamp, passed, total, results_json FROM kb_canary_runs ORDER BY id DESC LIMIT ?`);

  return {
    record(run): void {
      insert.run({ timestamp: run.timestamp, passed: run.passed, total: run.total, resultsJson: JSON.stringify(run.results) });
    },
    list(limit): CanaryRun[] {
      return (selectRecent.all(limit) as CanaryDbRow[]).map((r) => ({
        timestamp: r.timestamp,
        passed: r.passed,
        total: r.total,
        results: JSON.parse(r.results_json) as CanaryResult[],
      }));
    },
    close(): void {
      db.close();
    },
  };
}
