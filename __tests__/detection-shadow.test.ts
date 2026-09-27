import { describe, expect, it } from "@jest/globals";
import Database from "better-sqlite3";
import {
  ANSWER_CONFIDENT_QUESTION,
  openShadowStore,
  recordShadowDecision,
  shadowRowsAsReplayRows,
} from "../src/services/detection-shadow.js";
import type { ShadowDeps, ShadowStore } from "../src/services/detection-shadow.js";

function store(): ShadowStore {
  return openShadowStore(new Database(":memory:"));
}

function deps(over: Partial<ShadowDeps> = {}): ShadowDeps {
  return {
    enabled: true,
    async decide() {
      return { verdict: "resolved", probability: 0.93 };
    },
    ...over,
  };
}

describe("ANSWER_CONFIDENT_QUESTION", () => {
  // Detection judges a FRESH answer; resolution judges a re-answer after an
  // ingest. Sharing one constant would quietly make the shadow data describe a
  // question production does not ask at detection time.
  it("is a distinct question from the resolution one", async () => {
    const { GAP_RESOLVED_QUESTION } = await import("../src/services/gap-outcome.js");

    expect(ANSWER_CONFIDENT_QUESTION.id).toBe("confident");
    expect(ANSWER_CONFIDENT_QUESTION.id).not.toBe(GAP_RESOLVED_QUESTION.id);
  });
});

describe("recordShadowDecision", () => {
  it("records the 27B verdict and the scorer's beside it", async () => {
    const s = store();

    await recordShadowDecision(s, "what is x?", "answer", true, deps());

    const rows = s.list(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].llmConfident).toBe(true);
    expect(rows[0].scorerVerdict).toBe("resolved");
    expect(rows[0].scorerProbability).toBeCloseTo(0.93);
    expect(rows[0].scorerError).toBeNull();
    s.close();
  });

  it("stores only an excerpt of the query, not a second transcript", async () => {
    const s = store();

    await recordShadowDecision(s, "q".repeat(500), "answer", true, deps());

    expect(s.list(1)[0].queryExcerpt.length).toBeLessThanOrEqual(200);
    s.close();
  });

  // The whole point of shadow mode: the scorer must be able to fail, be
  // missing, or be wrong without touching what detection does.
  it("records the failure and still returns normally when the scorer throws", async () => {
    const s = store();
    const failing = deps({
      async decide() {
        throw new Error("ECONNREFUSED 127.0.0.1:8000");
      },
    });

    await expect(recordShadowDecision(s, "q", "a", false, failing)).resolves.toBeUndefined();

    const row = s.list(1)[0];
    expect(row.llmConfident).toBe(false);
    expect(row.scorerVerdict).toBeNull();
    expect(row.scorerProbability).toBeNull();
    expect(String(row.scorerError)).toMatch(/ECONNREFUSED/);
    s.close();
  });

  it("writes nothing at all when shadow mode is disabled", async () => {
    const s = store();

    await recordShadowDecision(s, "q", "a", true, deps({ enabled: false }));

    expect(s.list(10)).toEqual([]);
    s.close();
  });

  it("does not call the scorer when shadow mode is disabled", async () => {
    const s = store();
    let called = 0;
    const counted = deps({
      enabled: false,
      async decide() {
        called += 1;
        return { verdict: "resolved", probability: 1 };
      },
    });

    await recordShadowDecision(s, "q", "a", true, counted);

    expect(called).toBe(0);
    s.close();
  });

  it("records a row for a confident turn, which is the data that exists nowhere else", async () => {
    const s = store();

    // gap_log only ever gets a row when a gap IS found. Agreement on the
    // common case -- the answer was fine -- is unmeasurable without this.
    await recordShadowDecision(s, "q", "a", true, deps());

    expect(s.list(1)[0].llmConfident).toBe(true);
    s.close();
  });
});

describe("shadowRowsAsReplayRows", () => {
  // Reuses buildReplayReport rather than reimplementing the maths. The
  // mapping is confident -> "resolved", because the scorer is asked the same
  // shape of question in both places.
  it("maps the 27B's confidence onto the replay baseline vocabulary", () => {
    const rows = shadowRowsAsReplayRows([
      { id: 1, timestamp: "t", queryExcerpt: "q", llmConfident: true, scorerVerdict: "resolved", scorerProbability: 0.9, scorerError: null },
      { id: 2, timestamp: "t", queryExcerpt: "q", llmConfident: false, scorerVerdict: "unresolved", scorerProbability: 0.2, scorerError: null },
    ]);

    expect(rows).toEqual([
      { gapId: 1, baseline: "resolved", verdict: "resolved", probability: 0.9 },
      { gapId: 2, baseline: "unresolved", verdict: "unresolved", probability: 0.2 },
    ]);
  });

  it("drops rows the scorer never answered, rather than scoring them as disagreements", () => {
    const rows = shadowRowsAsReplayRows([
      { id: 1, timestamp: "t", queryExcerpt: "q", llmConfident: true, scorerVerdict: null, scorerProbability: null, scorerError: "unreachable" },
    ]);

    expect(rows).toEqual([]);
  });
});
