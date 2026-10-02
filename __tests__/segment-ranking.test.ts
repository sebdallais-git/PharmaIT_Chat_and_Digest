import { describe, expect, it } from "@jest/globals";
import { RANKING_TOP, rankSegment, type RankingInput, type SegmentPosition } from "../src/services/segment-ranking.js";

function positions(entries: Record<string, string>): Map<string, SegmentPosition> {
  return new Map(Object.entries(entries).map(([vendor, label]) => [vendor, { position: label, confidence: "high" }]));
}

function input(over: Partial<RankingInput>): RankingInput {
  return { declared: true, incumbents: [], trigger: null, positions: new Map(), keep: null, ...over };
}

const brief = (ranking: ReturnType<typeof rankSegment>["ranking"]) => ranking?.map((r) => `${r.rank} ${r.vendor}`);

describe("rankSegment", () => {
  it("does not rank a segment nobody declared", () => {
    expect(rankSegment(input({ declared: false, positions: positions({ dell: "leader" }) }))).toEqual({
      regime: "unknown",
      ranking: null,
      ranked: 0,
    });
  });

  it("ranks a declared-empty segment by position, ties sharing a rank", () => {
    const result = rankSegment(input({ positions: positions({ hpe: "leader", dell: "leader", netapp: "strong" }) }));
    expect(result.regime).toBe("greenfield");
    expect(brief(result.ranking)).toEqual(["1 dell", "1 hpe", "3 netapp"]);
    expect(result.ranking?.[0].reasons).toEqual(["nobody installed", "leader/high"]);
  });

  it("keeps the incumbent first without a trigger, even above a leader", () => {
    const result = rankSegment(input({ incumbents: ["everpure"], positions: positions({ dell: "leader", hpe: "strong" }) }));
    expect(result.regime).toBe("defend");
    expect(brief(result.ranking)).toEqual(["1 everpure", "2 dell", "3 hpe"]);
    expect(result.ranking?.map((r) => r.reasons)).toEqual([
      ["incumbent", "no brief"],
      ["rival", "leader/high"],
      ["rival", "strong/high"],
    ]);
  });

  it("lets position decide once a trigger is declared", () => {
    const result = rankSegment(
      input({ incumbents: ["everpure"], trigger: "end of support", positions: positions({ dell: "leader", hpe: "strong" }) }),
    );
    expect(result.regime).toBe("open");
    expect(brief(result.ranking)).toEqual(["1 dell", "2 hpe", "3 everpure"]);
  });

  it("gives the incumbent a tie in an open segment, and nothing else breaks ties", () => {
    const result = rankSegment(
      input({ incumbents: ["hpe"], trigger: "renewal", positions: positions({ hpe: "strong", dell: "strong", netapp: "strong" }) }),
    );
    expect(brief(result.ranking)).toEqual(["1 hpe", "2 dell", "2 netapp"]);
  });

  it("leaves out a vendor absent from the segment unless it is installed there", () => {
    const result = rankSegment(
      input({ incumbents: ["ibm"], positions: positions({ ibm: "absent", dell: "absent", hpe: "strong" }), keep: "dell" }),
    );
    expect(brief(result.ranking)).toEqual(["1 ibm", "2 hpe"]);
    expect(result.ranked).toBe(2);
  });

  it(`shows the top ${RANKING_TOP} with ties at ${RANKING_TOP}, plus the asked vendor, and counts them all`, () => {
    const result = rankSegment(
      input({
        incumbents: ["x"],
        positions: positions({ a: "leader", b: "strong", c: "strong", d: "present", e: "present" }),
        keep: "e",
      }),
    );
    expect(brief(result.ranking)).toEqual(["1 x", "2 a", "3 b", "3 c", "5 e"]);
    expect(result.ranked).toBe(6);
  });
});
