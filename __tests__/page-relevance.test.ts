import { describe, expect, it } from "@jest/globals";
import {
  PAGE_RELEVANT_QUESTION,
  checkPageRelevance,
  pageRelevanceState,
} from "../src/services/page-relevance.js";
import type { PageRelevanceDeps } from "../src/services/page-relevance.js";

// The gap workflow sends every fetched page to the 27B for extraction, and
// the 27B then discards about two thirds of them as not relevant. The scorer
// is asked first; a page it is nearly certain about skips the 27B. Every rule
// here errs towards extracting: a skipped relevant page is lost knowledge,
// an extracted irrelevant one only costs time.

const page = { topic: "Merck NotPetya insurance ruling cost", page: "Merck settled with insurers...", url: "https://example.org/a" };

function deps(over: Partial<PageRelevanceDeps> = {}): PageRelevanceDeps & { logs: string[]; calls: number } {
  const logs: string[] = [];
  const d = {
    skipBelow: 0.1,
    logs,
    calls: 0,
    score: async () => {
      d.calls += 1;
      return { probability: 0.02 };
    },
    log: (m: string) => logs.push(m),
    ...over,
  };
  return d;
}

describe("checkPageRelevance", () => {
  it("skips a page the scorer is nearly certain is irrelevant, and logs it", async () => {
    const d = deps();
    expect(await checkPageRelevance(page, d)).toEqual({ skip: true, probability: 0.02 });
    expect(d.logs.join("\n")).toMatch(/skipped https:\/\/example\.org\/a .*0\.020.*0\.1/);
  });

  it("extracts a page at or above the threshold", async () => {
    const d = deps({ score: async () => ({ probability: 0.1 }) });
    expect(await checkPageRelevance(page, d)).toEqual({ skip: false, probability: 0.1 });
    expect(d.logs).toEqual([]);
  });

  it("fails open: a scorer error extracts the page", async () => {
    const d = deps({
      score: async () => {
        throw new Error("scorer down");
      },
    });
    expect(await checkPageRelevance(page, d)).toEqual({ skip: false, probability: null });
    expect(d.logs.join("\n")).toMatch(/scorer down/);
  });

  it("does not ask the scorer when the check is switched off", async () => {
    const d = deps({ skipBelow: null });
    expect(await checkPageRelevance(page, d)).toEqual({ skip: false, probability: null });
    expect(d.calls).toBe(0);
  });

  // An empty topic is the old "undefined" search bug: nothing to judge against
  it("does not ask the scorer about a page with no topic", async () => {
    const d = deps();
    expect(await checkPageRelevance({ ...page, topic: "  " }, d)).toEqual({ skip: false, probability: null });
    expect(d.calls).toBe(0);
  });
});

describe("pageRelevanceState", () => {
  // The 27B's extraction prompt sees page_content.slice(0, 6000); the scorer
  // should judge the same text, not a page the 27B never reads.
  it("gives the scorer the topic and the first 6000 characters of the page", () => {
    const state = pageRelevanceState("topic x", "p".repeat(9000));
    expect(state.startsWith("Research topic: topic x\nWeb page:\n")).toBe(true);
    expect(state.length).toBe("Research topic: topic x\nWeb page:\n".length + 6000);
  });
});

describe("PAGE_RELEVANT_QUESTION", () => {
  it("has its own id, distinct from the gap questions", () => {
    expect(PAGE_RELEVANT_QUESTION.id).toBe("page-relevant");
  });
});
