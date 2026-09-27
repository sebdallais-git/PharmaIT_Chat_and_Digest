import { describe, expect, it } from "@jest/globals";
import { classifyDecideFailure, DECIDE_ERROR_MESSAGES } from "../src/api/decide.js";
import { ScorerResponseError, ScorerUnavailableError } from "../src/services/decide.js";

// /api/knowledge/gaps/check-resolution calls decide(), so scorer errors reach
// its catch block — and those errors interpolate text this codebase did not
// author: JSON.stringify of a scorer-controlled field, and undici's own
// message. Returning them verbatim put third-party text in a response body.
//
// /api/decide was fixed to answer with a fixed message per failure class. This
// pins that check-resolution uses the SAME classifier rather than a second,
// differently-safe opinion — a class rule applied to one of two routes is a
// rule the next reader has to re-derive.
describe("gap resolution error classification", () => {
  it("maps a scorer outage to the same fixed message /api/decide uses", () => {
    const failure = classifyDecideFailure(
      new ScorerUnavailableError("decide: scorer at http://127.0.0.1:8000 is unreachable (ECONNREFUSED)"),
    );

    expect(failure.status).toBe(503);
    expect(failure.message).toBe(DECIDE_ERROR_MESSAGES.unavailable);
    expect(failure.message).not.toMatch(/127\.0\.0\.1|ECONNREFUSED/);
  });

  it("maps an unusable scorer body to a fixed message, carrying none of the body", () => {
    const failure = classifyDecideFailure(
      new ScorerResponseError('decide: scorer returned an invalid noul for "resolved": "sk-leaked-secret"'),
    );

    expect(failure.status).toBe(500);
    expect(failure.message).toBe(DECIDE_ERROR_MESSAGES.invalidResponse);
    expect(failure.message).not.toMatch(/sk-leaked-secret/);
  });

  // A gap-resolution failure that has nothing to do with the scorer — ChromaDB
  // down, the 27B refusing — must still not leak its own message.
  it("maps anything else to the internal message", () => {
    const failure = classifyDecideFailure(new Error("Neo4j bolt://localhost:7687 refused: password=hunter2"));

    expect(failure.status).toBe(500);
    expect(failure.message).toBe(DECIDE_ERROR_MESSAGES.internal);
    expect(failure.message).not.toMatch(/hunter2|7687/);
  });

  it("keeps a distinct log label per class, so the detail is still diagnosable server-side", () => {
    const labels = [
      classifyDecideFailure(new ScorerUnavailableError("x")).logLabel,
      classifyDecideFailure(new ScorerResponseError("x")).logLabel,
      classifyDecideFailure(new Error("x")).logLabel,
    ];

    expect(new Set(labels).size).toBe(3);
  });
});
