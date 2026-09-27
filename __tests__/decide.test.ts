import { describe, expect, it } from "@jest/globals";
import { decide, ScorerResponseError, ScorerUnavailableError } from "../src/services/decide.js";
import type { DecideDeps, DecisionQuestion } from "../src/services/decide.js";

const question: DecisionQuestion = {
  id: "resolved",
  instructions: "Did the answer address the question with specific information?",
  whenTrue: "The answer is specific and addresses the question.",
  whenFalse: "The answer hedges, is vague, or says it does not know.",
};

function depsReturning(noul: number, seen?: { body?: unknown; url?: string; auth?: string | null }): DecideDeps {
  return {
    config: {
      baseUrl: "http://127.0.0.1:8000",
      model: "jev-latest",
      timeoutMs: 15000,
      shadowDetection: false,
      pageRelevanceSkipBelow: null,
      thresholds: { resolved: 0.85, unresolved: 0.5 },
    },
    apiKey: "secret-key",
    fetchImpl: (async (url: string, init?: RequestInit) => {
      if (seen) {
        seen.url = String(url);
        seen.body = JSON.parse(String(init?.body ?? "{}"));
        seen.auth = new Headers(init?.headers).get("authorization");
      }
      return new Response(JSON.stringify({ answers: { resolved: { noul } } }), { status: 200 });
    }) as unknown as typeof fetch,
  };
}

describe("decide", () => {
  it("sends a noul question to /v1/systemone with the scorer key", async () => {
    const seen: { body?: unknown; url?: string; auth?: string | null } = {};

    await decide(question, "Q: x\nA: y", depsReturning(0.9, seen));

    expect(seen.url).toBe("http://127.0.0.1:8000/v1/systemone");
    expect(seen.auth).toBe("Bearer secret-key");
    expect(seen.body).toEqual({
      state: "Q: x\nA: y",
      model: "jev-latest",
      questions: {
        resolved: {
          type: "noul",
          instructions: question.instructions,
          criteria: { true: question.whenTrue, false: question.whenFalse },
        },
      },
    });
  });

  // Both edges are named explicitly: an off-by-one on either boundary silently
  // moves gaps between "closed" and "spend a retry".
  it.each([
    [0.95, "resolved"],
    [0.85, "resolved"],
    [0.8499, "review"],
    [0.6, "review"],
    [0.5, "review"],
    [0.4999, "unresolved"],
    [0.0, "unresolved"],
  ])("maps noul %s to %s", async (noul: number, expected: string) => {
    const decision = await decide(question, "state", depsReturning(noul));

    expect(decision.verdict).toBe(expected);
    expect(decision.probability).toBe(noul);
  });

  // The bug this service replaces: checkConfidence() returned
  // { confident: true } whenever it could not parse the model, so an
  // unparseable judgment silently marked a gap resolved. A scorer that cannot
  // answer must stop the decision, never supply one.
  it("throws rather than returning a verdict when the scorer is unreachable", async () => {
    const deps = depsReturning(0.9);
    deps.fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    await expect(decide(question, "state", deps)).rejects.toBeInstanceOf(ScorerUnavailableError);
  });

  it("throws on a non-ok response", async () => {
    const deps = depsReturning(0.9);
    deps.fetchImpl = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;

    await expect(decide(question, "state", deps)).rejects.toBeInstanceOf(ScorerUnavailableError);
  });

  it.each([
    ["missing answers", {}],
    ["missing the question id", { answers: {} }],
    ["a non-numeric noul", { answers: { resolved: { noul: "yes" } } }],
    ["a noul outside 0..1", { answers: { resolved: { noul: 1.4 } } }],
    // typeof [] is "object", so an array walks into every property read below
    // unless the guard excludes it.
    ["an array body", []],
    ["array answers", { answers: [] }],
    ["an array answer", { answers: { resolved: [] } }],
  ])("throws on %s", async (_label: string, body: unknown) => {
    const deps = depsReturning(0.9);
    deps.fetchImpl = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

    await expect(decide(question, "state", deps)).rejects.toBeInstanceOf(ScorerResponseError);
  });

  // A 200 whose body is not JSON (a proxy's HTML error page) used to surface as
  // a bare SyntaxError, which /api/decide answered 500 while every other scorer
  // failure answered 503.
  // A 4xx is the scorer refusing this request, not the scorer being down: a
  // missing or wrong jev-token (401/403) or a malformed request stays wrong on
  // every retry. Classed as unavailable, /api/decide answered 503 "retry" and
  // n8n kept retrying a permanent failure.
  it.each([400, 401, 403, 404, 422])("treats a %i as a response that retrying will not fix", async (status) => {
    const deps = depsReturning(0.9);
    deps.fetchImpl = (async () => new Response("no", { status })) as unknown as typeof fetch;

    await expect(decide(question, "state", deps)).rejects.toBeInstanceOf(ScorerResponseError);
  });

  it.each([408, 429, 500, 502, 503])("treats a %i as the scorer being temporarily unavailable", async (status) => {
    const deps = depsReturning(0.9);
    deps.fetchImpl = (async () => new Response("later", { status })) as unknown as typeof fetch;

    await expect(decide(question, "state", deps)).rejects.toBeInstanceOf(ScorerUnavailableError);
  });

  it("treats a non-JSON 200 body as the scorer being unavailable", async () => {
    const deps = depsReturning(0.9);
    deps.fetchImpl = (async () =>
      new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })) as unknown as typeof fetch;

    await expect(decide(question, "state", deps)).rejects.toBeInstanceOf(ScorerUnavailableError);
  });

  it("omits the Authorization header when no key is configured", async () => {
    const seen: { auth?: string | null } = {};
    const deps = depsReturning(0.9, seen);
    deps.apiKey = null;

    await decide(question, "state", deps);

    expect(seen.auth).toBeNull();
  });
});
