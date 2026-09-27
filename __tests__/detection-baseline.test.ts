import { describe, expect, it } from "@jest/globals";
import {
  DETECTION_LABELLED_BY,
  labelFromConfidence,
  parseDetectionBaseline,
  pendingQueries,
  readChatAnswer,
} from "../scripts/lib/detection-baseline.js";
import type { DetectionBaselineRow } from "../scripts/lib/detection-baseline.js";

// scripts/replay-detection.ts --backfill regenerates answers for past chat
// questions (request_log stores no answers), labels them with the 27B's
// checkConfidence and saves them; the replay then asks the scorer the
// detection question about the same answers. None of this touches a live
// service: streams and verdicts are built in memory.

function row(requestId: number, query: string, label: DetectionBaselineRow["label"] = "resolved"): DetectionBaselineRow {
  return { requestId, query, answer: `answer to ${query}`, label };
}

function stream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("labelFromConfidence", () => {
  it("maps a parsed confident verdict to resolved and a parsed doubt to unresolved", () => {
    expect(labelFromConfidence({ parsed: true, confident: true })).toBe("resolved");
    expect(labelFromConfidence({ parsed: true, confident: false })).toBe("unresolved");
  });

  // checkConfidence defaults an unparseable reply to confident: true (right
  // for detection, where a parse miss must not raise a gap). As a LABEL that
  // default would count as the 27B's opinion when the 27B gave none.
  it("gives no label when the 27B's reply could not be parsed", () => {
    expect(labelFromConfidence({ parsed: false, confident: true })).toBeNull();
  });
});

describe("parseDetectionBaseline", () => {
  const valid = {
    labelled_by: DETECTION_LABELLED_BY,
    generated_at: "2026-09-27T12:00:00.000Z",
    rows: [row(1, "q1"), row(2, "q2", "unresolved")],
  };

  it("reads back a baseline this version wrote", () => {
    expect(parseDetectionBaseline(valid).rows).toEqual(valid.rows);
  });

  it("refuses a file without this script's provenance stamp", () => {
    expect(() => parseDetectionBaseline({ ...valid, labelled_by: "27b-checkConfidence" })).toThrow(/stamp/);
    expect(() => parseDetectionBaseline([])).toThrow(/stamp/);
  });

  it("drops malformed rows rather than scoring them", () => {
    const parsed = parseDetectionBaseline({
      ...valid,
      rows: [row(1, "q1"), { requestId: 2, query: "q2", answer: "a", label: "review" }, { requestId: "3" }, null],
    });
    expect(parsed.rows.map((r) => r.requestId)).toEqual([1]);
  });
});

describe("pendingQueries", () => {
  it("skips questions already in the baseline, so an interrupted backfill resumes", () => {
    const pending = pendingQueries(
      [
        { id: 3, query: "c" },
        { id: 2, query: "b" },
        { id: 1, query: "a" },
      ],
      [row(2, "b")],
      10,
    );
    expect(pending.map((q) => q.id)).toEqual([3, 1]);
  });

  // request_log keeps every ask; the same question asked twice would be
  // regenerated twice and counted twice in the agreement rate.
  it("keeps one row per question, ignoring case and surrounding space", () => {
    const pending = pendingQueries(
      [
        { id: 3, query: "What is X?" },
        { id: 2, query: "  what is x? " },
        { id: 1, query: "Other" },
      ],
      [row(9, "other")],
      10,
    );
    expect(pending.map((q) => q.id)).toEqual([3]);
  });

  it("stops at the limit", () => {
    const candidates = [5, 4, 3, 2, 1].map((id) => ({ id, query: `q${id}` }));
    expect(pendingQueries(candidates, [], 2).map((q) => q.id)).toEqual([5, 4]);
  });
});

describe("readChatAnswer", () => {
  it("joins the streamed tokens up to the done event, across chunk boundaries", async () => {
    const result = await readChatAnswer(
      stream(['data: {"token":"Hel', 'lo"}\n\ndata: {"token":" world"}\n\n', 'data: {"done":true}\n\n']),
    );
    expect(result).toEqual({ answer: "Hello world" });
  });

  it("reports an error event instead of a partial answer", async () => {
    const result = await readChatAnswer(stream(['data: {"token":"Hel"}\n\n', 'data: {"error":"model down"}\n\n']));
    expect(result).toEqual({ answer: "Hel", error: "model down" });
  });

  it("reports a stream that ends without a done event", async () => {
    const result = await readChatAnswer(stream(['data: {"token":"Hel"}\n\n']));
    expect(result.error).toMatch(/without a done event/);
  });
});
