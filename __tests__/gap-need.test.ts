import { describe, expect, it } from "@jest/globals";
import { checkNeedsResearch, needsResearchPrompt, parseNeedsResearch } from "../src/services/gap-need.js";

// Gap detection decides which chat turns send the n8n loop off to search the
// web, fetch and extract pages, and re-check. Two blind spot-checks on
// 2026-09-27 found the old check (checkConfidence: "specific, confident
// information?") flagged answers the user accepted as real answers 19 times
// out of 20 disputed, and 14 times out of 15 random production gaps --
// including "What is your favorite color?", researched twice. The new check
// raises a gap only for an in-scope question the answer did not answer.

describe("parseNeedsResearch", () => {
  it("raises a gap only for an in-scope question that was not answered", () => {
    const reply = (inScope: boolean, answered: boolean) =>
      JSON.stringify({ in_scope: inScope, answered, reason: "r", search_topic: "Sandoz SAP integrator" });
    expect(parseNeedsResearch(reply(true, false))).toMatchObject({ parsed: true, gap: true, search_topic: "Sandoz SAP integrator" });
    expect(parseNeedsResearch(reply(true, true)).gap).toBe(false);
    expect(parseNeedsResearch(reply(false, false)).gap).toBe(false);
    expect(parseNeedsResearch(reply(false, true)).gap).toBe(false);
  });

  it("reads the JSON out of surrounding text", () => {
    const text = 'Here is my verdict:\n{"in_scope": true, "answered": false, "reason": "says unknown", "search_topic": "x"}\nDone.';
    expect(parseNeedsResearch(text)).toMatchObject({ parsed: true, gap: true, reason: "says unknown" });
  });

  // Boolean("false") is true: a model that quotes its booleans must not flip
  // every verdict into a gap
  it("reads quoted booleans as the value they spell", () => {
    const text = '{"in_scope": "true", "answered": "false", "reason": "", "search_topic": "x"}';
    expect(parseNeedsResearch(text).gap).toBe(true);
    const answered = '{"in_scope": "true", "answered": "true", "reason": "", "search_topic": ""}';
    expect(parseNeedsResearch(answered).gap).toBe(false);
  });

  // An unreadable verdict must never create a gap: every gap costs a web
  // search, page fetches and 27B extractions
  it.each([
    ["no JSON", "I think the answer was fine."],
    ["broken JSON", '{"in_scope": true, "answered": '],
    ["a missing field", '{"in_scope": true, "reason": "r"}'],
    ["a non-boolean field", '{"in_scope": true, "answered": "maybe"}'],
  ])("raises no gap on %s", (_label, text) => {
    expect(parseNeedsResearch(text)).toMatchObject({ parsed: false, gap: false });
  });
});

describe("needsResearchPrompt", () => {
  const prompt = needsResearchPrompt("What is your favorite color?", "I don't have personal preferences.");

  it("puts the question and the answer in front of the model", () => {
    expect(prompt).toContain("Question: What is your favorite color?");
    expect(prompt).toContain("Answer: I don't have personal preferences.");
  });

  it("names small talk and personal questions as out of scope", () => {
    expect(prompt).toMatch(/small talk/i);
    expect(prompt).toMatch(/personal questions/i);
  });

  it("counts general knowledge and incomplete sources as answered", () => {
    expect(prompt).toMatch(/general knowledge/i);
    expect(prompt).toMatch(/false ONLY if/);
  });
});

describe("checkNeedsResearch", () => {
  it("asks the model once with the prompt and parses its reply", async () => {
    const seen: string[] = [];
    const verdict = await checkNeedsResearch("q", "a", async (prompt) => {
      seen.push(prompt);
      return '{"in_scope": true, "answered": false, "reason": "r", "search_topic": "t"}';
    });
    expect(seen).toEqual([needsResearchPrompt("q", "a")]);
    expect(verdict.gap).toBe(true);
  });

  it("raises no gap when the model call fails", async () => {
    const verdict = await checkNeedsResearch("q", "a", async () => {
      throw new Error("stack down");
    });
    expect(verdict).toMatchObject({ parsed: false, gap: false });
  });
});
