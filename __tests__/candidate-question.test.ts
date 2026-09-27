import { describe, expect, it } from "@jest/globals";
import { candidateQuestion } from "../scripts/lib/candidate-question.js";
import { GAP_RESOLVED_QUESTION } from "../src/services/gap-outcome.js";

// scripts/replay-gap-decisions.ts --question <file> replays the gaps with a
// candidate wording instead of production's, so the scorer's question can be
// tuned against the baseline without touching production.
describe("candidateQuestion", () => {
  it("keeps production's id, which the verdict is read back under", () => {
    const q = candidateQuestion({ id: "something-else", instructions: "i", whenTrue: "t", whenFalse: "f" });
    expect(q).toEqual({ id: GAP_RESOLVED_QUESTION.id, instructions: "i", whenTrue: "t", whenFalse: "f" });
  });

  it.each(["instructions", "whenTrue", "whenFalse"])("rejects a candidate without %s", (field) => {
    const raw: Record<string, string> = { instructions: "i", whenTrue: "t", whenFalse: "f" };
    delete raw[field];
    expect(() => candidateQuestion(raw)).toThrow(field);
  });

  it("rejects something that is not an object", () => {
    expect(() => candidateQuestion("just text")).toThrow(/object/);
  });
});
