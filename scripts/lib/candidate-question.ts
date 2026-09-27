// A candidate wording for the gap-resolution question, read from a JSON file by
// scripts/replay-gap-decisions.ts --question. Tuning the scorer's question is
// measured against the 27B baseline without touching production's question.
import type { DecisionQuestion } from "../../src/services/decide.js";
import { GAP_RESOLVED_QUESTION } from "../../src/services/gap-outcome.js";

export function candidateQuestion(raw: unknown): DecisionQuestion {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("a candidate question must be a JSON object");
  }
  const fields = raw as Record<string, unknown>;
  for (const key of ["instructions", "whenTrue", "whenFalse"]) {
    if (typeof fields[key] !== "string" || (fields[key] as string).trim() === "") {
      throw new Error(`a candidate question needs a non-empty "${key}"`);
    }
  }
  return {
    // The verdict is read back under this id; a different one would drop every row
    id: GAP_RESOLVED_QUESTION.id,
    instructions: fields.instructions as string,
    whenTrue: fields.whenTrue as string,
    whenFalse: fields.whenFalse as string,
  };
}
