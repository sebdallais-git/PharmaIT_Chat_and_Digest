// Shadow-mode scoring for gap DETECTION.
//
// Detection asks "did the assistant actually answer?" on every chat turn, and
// today a 27B answers it (gap-detector.ts checkConfidence). That is far more
// traffic than gap RESOLUTION, which is the judgment the scorer already owns --
// so detection is where moving to a 4B would pay most, and also where being
// wrong would cost most.
//
// R1: the scorer runs here alongside the 27B and decides NOTHING. Both verdicts
// are written to detection_shadow and the 27B's answer is still the one that
// acts. The point is to accumulate evidence on the high-volume path before
// betting chat behaviour on a model nobody has measured yet: the spec defers
// detection "pending the replay result", and the replay otherwise has only 63
// backfilled rows to work from.
//
// R2: a row is written for EVERY turn, including the confident ones. gap_log
// only ever gets a row when a gap IS found, so agreement on the common case --
// the answer was fine, no gap -- is measurable nowhere else. That case is the
// majority of traffic and the one a false positive would spam ingests over.
//
// R3: nothing in here may change detection. Every failure is caught and stored
// as a failure; the function always resolves. A scorer that is missing, slow,
// wrong or broken must leave `handleGapDetection` behaving exactly as it did.

import type { Database as SqliteDatabase } from "better-sqlite3";
import type { Decision, DecisionQuestion } from "./decide.js";
import type { ReplayRow } from "./replay-report.js";

/**
 * The one question asked about a fresh answer at detection time.
 *
 * Deliberately NOT GAP_RESOLVED_QUESTION: that one judges a re-answer produced
 * after an ingest, this one judges the answer a user just received. Sharing a
 * constant would make the shadow data describe a question production does not
 * ask here.
 */
export const ANSWER_CONFIDENT_QUESTION: DecisionQuestion = {
  id: "confident",
  instructions:
    "Did the assistant answer the question with specific, confident information, rather than hedging, saying it does not know, or giving only vague generic information?",
  whenTrue: "The answer is specific and addresses the question.",
  whenFalse: "The answer hedges, is vague, says it does not know, or does not address the question.",
};

// Enough to recognise a pattern when reading the table; not enough to become a
// second copy of every conversation.
const EXCERPT_LIMIT = 200;

export interface ShadowRow {
  id: number;
  timestamp: string;
  queryExcerpt: string;
  llmConfident: boolean;
  scorerVerdict: string | null;
  scorerProbability: number | null;
  scorerError: string | null;
}

export interface ShadowStore {
  record(row: Omit<ShadowRow, "id">): void;
  list(limit: number): ShadowRow[];
  close(): void;
}

export interface ShadowDeps {
  // False when no scorer is installed, or when shadow mode is switched off in
  // config. Nothing is called and nothing is written.
  enabled: boolean;
  decide(question: DecisionQuestion, state: string): Promise<Decision>;
}

interface ShadowDbRow {
  id: number;
  timestamp: string;
  query_excerpt: string;
  llm_confident: number;
  scorer_verdict: string | null;
  scorer_probability: number | null;
  scorer_error: string | null;
}

/**
 * Wraps an already-open database. The caller owns the handle — this lives in
 * the same gap_log.db the detector already has open, rather than opening a
 * second connection to the same domain.
 */
export function openShadowStore(db: SqliteDatabase): ShadowStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS detection_shadow (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      query_excerpt TEXT NOT NULL,
      llm_confident INTEGER NOT NULL,
      scorer_verdict TEXT,
      scorer_probability REAL,
      scorer_error TEXT
    );
  `);

  const insert = db.prepare(`
    INSERT INTO detection_shadow (timestamp, query_excerpt, llm_confident, scorer_verdict, scorer_probability, scorer_error)
    VALUES (@timestamp, @queryExcerpt, @llmConfident, @scorerVerdict, @scorerProbability, @scorerError)
  `);
  const selectRecent = db.prepare(`SELECT * FROM detection_shadow ORDER BY id DESC LIMIT ?`);

  return {
    record(row): void {
      insert.run({
        timestamp: row.timestamp,
        queryExcerpt: row.queryExcerpt,
        llmConfident: row.llmConfident ? 1 : 0,
        scorerVerdict: row.scorerVerdict,
        scorerProbability: row.scorerProbability,
        scorerError: row.scorerError,
      });
    },
    list(limit): ShadowRow[] {
      return (selectRecent.all(limit) as ShadowDbRow[]).map((r) => ({
        id: r.id,
        timestamp: r.timestamp,
        queryExcerpt: r.query_excerpt,
        llmConfident: r.llm_confident === 1,
        scorerVerdict: r.scorer_verdict,
        scorerProbability: r.scorer_probability,
        scorerError: r.scorer_error,
      }));
    },
    close(): void {
      db.close();
    },
  };
}

/**
 * Ask the scorer the detection question and store its answer beside the 27B's.
 *
 * Never throws and never reports anything back: the caller's behaviour must not
 * depend on this having worked. See R3 above.
 */
export async function recordShadowDecision(
  store: ShadowStore,
  query: string,
  answer: string,
  llmConfident: boolean,
  deps: ShadowDeps,
): Promise<void> {
  if (!deps.enabled) return;

  let verdict: string | null = null;
  let probability: number | null = null;
  let error: string | null = null;

  try {
    const decision = await deps.decide(ANSWER_CONFIDENT_QUESTION, `Question: ${query}\nAnswer: ${answer}`);
    verdict = decision.verdict;
    probability = decision.probability;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  try {
    store.record({
      timestamp: new Date().toISOString(),
      queryExcerpt: query.slice(0, EXCERPT_LIMIT),
      llmConfident,
      scorerVerdict: verdict,
      scorerProbability: probability,
      scorerError: error,
    });
  } catch (err) {
    // Even the write must not escape into detection.
    console.error("[Shadow] could not record a shadow decision:", err instanceof Error ? err.message : err);
  }
}

/**
 * Adapts shadow rows to the replay harness's row shape so the agreement
 * maths lives in one place (buildReplayReport) rather than being written twice.
 *
 * `confident` maps to `resolved` because the scorer is asked the same shape of
 * question in both places: a high probability means "the answer stands".
 *
 * Rows the scorer never answered are DROPPED rather than counted as
 * disagreements — an outage is not evidence about the model, and scoring it as
 * one would make a dead scorer look like an inaccurate one.
 */
export function shadowRowsAsReplayRows(rows: ShadowRow[]): ReplayRow[] {
  const out: ReplayRow[] = [];
  for (const row of rows) {
    if (row.scorerVerdict === null || row.scorerProbability === null) continue;
    out.push({
      gapId: row.id,
      baseline: row.llmConfident ? "resolved" : "unresolved",
      verdict: row.scorerVerdict as ReplayRow["verdict"],
      probability: row.scorerProbability,
    });
  }
  return out;
}
