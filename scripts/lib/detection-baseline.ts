// The detection replay's baseline: past chat questions, a regenerated answer
// for each, and the 27B's checkConfidence label on that answer.
//
// request_log keeps every question and whether the 27B found the answer
// confident, but not the answer itself, so scripts/replay-detection.ts
// regenerates one through /api/chat in benchmark mode (no gap detection, no
// request logging, temperature 0) and labels THAT answer. The label describes
// the regenerated answer, not the one the user saw; the two can differ.
//
// Labels use the replay harness's vocabulary: "resolved" means the answer
// stands (confident), as in shadowRowsAsReplayRows.
import { isRecord } from "../../src/services/decide-config.js";
import { parseSseLines } from "../../src/services/llm-client.js";

// Stamped into the baseline file and required when reading it back, so a file
// written by anything else is refused rather than trusted.
export const DETECTION_LABELLED_BY = "27b-checkConfidence-regenerated";

export type Label = "resolved" | "unresolved";

export interface DetectionBaselineRow {
  requestId: number;
  query: string;
  answer: string;
  label: Label;
}

export interface DetectionBaseline {
  labelled_by: string;
  generated_at: string;
  rows: DetectionBaselineRow[];
}

export interface QueryCandidate {
  id: number;
  query: string;
}

export function labelFromConfidence(result: { parsed: boolean; confident: boolean }): Label | null {
  // An unparsed reply defaults to confident inside checkConfidence; that is a
  // safe default for detection but not an opinion, so it labels nothing.
  if (!result.parsed) return null;
  return result.confident ? "resolved" : "unresolved";
}

function isRow(value: unknown): value is DetectionBaselineRow {
  return (
    isRecord(value) &&
    typeof value.requestId === "number" &&
    typeof value.query === "string" &&
    typeof value.answer === "string" &&
    (value.label === "resolved" || value.label === "unresolved")
  );
}

export function parseDetectionBaseline(raw: unknown): DetectionBaseline {
  if (!isRecord(raw) || raw.labelled_by !== DETECTION_LABELLED_BY || !Array.isArray(raw.rows)) {
    throw new Error(`not a detection baseline written by this version (no "${DETECTION_LABELLED_BY}" stamp)`);
  }
  return {
    labelled_by: DETECTION_LABELLED_BY,
    generated_at: typeof raw.generated_at === "string" ? raw.generated_at : "",
    rows: raw.rows.filter(isRow),
  };
}

function normalise(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * The questions still to label, newest first: one per distinct question text,
 * skipping any the baseline already holds, up to `limit`.
 */
export function pendingQueries(candidates: QueryCandidate[], done: DetectionBaselineRow[], limit: number): QueryCandidate[] {
  const seen = new Set(done.map((r) => normalise(r.query)));
  const out: QueryCandidate[] = [];
  for (const candidate of candidates) {
    if (out.length >= limit) break;
    const key = normalise(candidate.query);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

interface ChatEvent {
  token?: string;
  done?: boolean;
  error?: string;
}

/** Collects a /api/chat server-sent-events stream into the answer text. */
export async function readChatAnswer(body: ReadableStream<Uint8Array>): Promise<{ answer: string; error?: string }> {
  const reader = body.getReader();
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
      if (event.error) return { answer, error: event.error };
      if (event.token) answer += event.token;
      if (event.done) return { answer };
    }
  }
  return { answer, error: "stream ended without a done event" };
}
