import { describe, expect, it } from "@jest/globals";
import { completeOrSkip, parseCompletionRequest } from "../src/api/llm.js";

describe("parseCompletionRequest", () => {
  it("accepts an Ollama /api/generate body and ignores model and stream", () => {
    expect(parseCompletionRequest({ model: "gemma2:9b", prompt: "Summarize", stream: false })).toEqual({
      prompt: "Summarize",
    });
  });

  it("keeps a numeric temperature", () => {
    expect(parseCompletionRequest({ prompt: "Rate this", temperature: 0.1 })).toEqual({
      prompt: "Rate this",
      temperature: 0.1,
    });
  });

  it("accepts an Ollama-shaped options.temperature when there is no top-level temperature", () => {
    expect(parseCompletionRequest({ prompt: "Rate this", options: { temperature: 0.2 } })).toEqual({
      prompt: "Rate this",
      temperature: 0.2,
    });
    expect(parseCompletionRequest({ prompt: "Rate this", temperature: 0.1, options: { temperature: 0.9 } })).toEqual({
      prompt: "Rate this",
      temperature: 0.1,
    });
    expect(parseCompletionRequest({ prompt: "Rate this", options: { temperature: "hot" } })).toEqual({
      prompt: "Rate this",
    });
  });

  it("rejects a missing or blank prompt", () => {
    expect(parseCompletionRequest({})).toEqual({ error: "The 'prompt' field is required" });
    expect(parseCompletionRequest({ prompt: "   " })).toEqual({ error: "The 'prompt' field is required" });
    expect(parseCompletionRequest(null)).toEqual({ error: "The 'prompt' field is required" });
  });
});

// The gap workflow's Extract step sends the page it wants summarised as
// "relevance"; the app asks the scorer first and answers NOT_RELEVANT itself
// when the page is clearly off-topic, so the workflow's existing filter drops
// it and no 27B call is made. Without "relevance" nothing changes.
describe("parseCompletionRequest relevance", () => {
  it("keeps a well-formed relevance object", () => {
    const body = { prompt: "Extract", relevance: { topic: "t", page: "p", url: "https://x" } };
    expect(parseCompletionRequest(body)).toEqual({ prompt: "Extract", relevance: { topic: "t", page: "p", url: "https://x" } });
  });

  it("ignores a malformed relevance object rather than rejecting the completion", () => {
    expect(parseCompletionRequest({ prompt: "Extract", relevance: { topic: 1, page: "p" } })).toEqual({ prompt: "Extract" });
    expect(parseCompletionRequest({ prompt: "Extract", relevance: "t" })).toEqual({ prompt: "Extract" });
  });

  it("accepts a page without a url", () => {
    expect(parseCompletionRequest({ prompt: "E", relevance: { topic: "t", page: "p" } })).toEqual({
      prompt: "E",
      relevance: { topic: "t", page: "p", url: "unknown" },
    });
  });
});

describe("completeOrSkip", () => {
  function fakes(skip: boolean, probability: number | null = skip ? 0.01 : 0.9) {
    const calls = { complete: 0, check: 0 };
    return {
      calls,
      deps: {
        checkRelevance: async () => {
          calls.check += 1;
          return { skip, probability };
        },
        complete: async () => {
          calls.complete += 1;
          return "facts";
        },
      },
    };
  }
  const relevance = { topic: "t", page: "p", url: "https://x" };

  it("answers NOT_RELEVANT without calling the 27B when the page is skipped", async () => {
    const f = fakes(true);
    expect(await completeOrSkip({ prompt: "E", relevance }, f.deps)).toEqual({
      response: "NOT_RELEVANT",
      skipped: true,
      relevance_probability: 0.01,
    });
    expect(f.calls.complete).toBe(0);
  });

  it("extracts as before when the page is not skipped, and reports the probability", async () => {
    const f = fakes(false);
    expect(await completeOrSkip({ prompt: "E", relevance }, f.deps)).toEqual({
      response: "facts",
      skipped: false,
      relevance_probability: 0.9,
    });
  });

  it("does not consult the scorer for a plain completion", async () => {
    const f = fakes(true);
    expect(await completeOrSkip({ prompt: "E" }, f.deps)).toEqual({ response: "facts" });
    expect(f.calls.check).toBe(0);
  });
});
