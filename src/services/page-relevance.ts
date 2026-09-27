// A System One pre-check in front of the gap workflow's 27B extraction.
//
// The n8n gap workflow fetches up to 9 pages per gap and sends every one to
// the 27B to extract facts; the 27B then discards about two thirds of them as
// not relevant (13 runs to 2026-09-27: 54 pages, ~650 of 997 s of 27B time
// spent on pages thrown away). Whether a page is ABOUT a topic is a narrow,
// surface-level question a 4B answers well, unlike "is this answer good
// enough", so the scorer is asked first and a page it is nearly certain about
// never reaches the 27B.
//
// Everything errs towards extracting. A skipped relevant page is knowledge
// lost for good; an extracted irrelevant page only costs time, and the
// workflow's own NOT_RELEVANT filter still catches it. So: the threshold is
// low and one-sided (there is no "certainly relevant" shortcut), and any
// scorer failure extracts the page as before. Measure a change of question or
// threshold with scripts/replay-page-relevance.ts before relying on it.

import type { DecisionQuestion } from "./decide.js";
import { decide } from "./decide.js";
import type { DecideConfig } from "./decide-config.js";
import { loadDecideConfig } from "./decide-config.js";

// Measured with scripts/replay-page-relevance.ts on 2026-09-27 (34 pages from
// real gap runs): this wording skips 9 of the 26 pages the 27B discarded at
// p < 0.1 and none of the 8 it kept, whose lowest score was 0.915. Without the
// "original question" clause it skipped 4 at the same threshold.
export const PAGE_RELEVANT_QUESTION: DecisionQuestion = {
  id: "page-relevant",
  instructions:
    "Does this web page contain specific information about the research topic, information that would help answer the original question? Answer false if the page is about something else, is only navigation, cookie or login text, or mentions the topic only in passing.",
  whenTrue: "The page contains specific information about the topic.",
  whenFalse: "The page is about something else, is boilerplate, or mentions the topic only in passing.",
};

// The extraction prompt reads page_content.slice(0, 6000): judge the same text
const PAGE_CHARS = 6000;

export function pageRelevanceState(topic: string, page: string): string {
  return `Research topic: ${topic}\nWeb page:\n${page.slice(0, PAGE_CHARS)}`;
}

export interface PageRelevanceInput {
  topic: string;
  page: string;
  url: string;
}

export interface PageRelevanceDeps {
  // Skip a page whose probability is below this; null switches the check off
  skipBelow: number | null;
  score(topic: string, page: string): Promise<{ probability: number }>;
  log(message: string): void;
}

export interface PageRelevanceResult {
  skip: boolean;
  // Null when the scorer was not asked or could not answer
  probability: number | null;
}

export async function checkPageRelevance(input: PageRelevanceInput, deps: PageRelevanceDeps): Promise<PageRelevanceResult> {
  // No topic is the old "undefined" search bug: nothing to judge the page against
  if (deps.skipBelow === null || input.topic.trim() === "") return { skip: false, probability: null };

  let probability: number;
  try {
    ({ probability } = await deps.score(input.topic, input.page));
  } catch (err) {
    deps.log(`[Page Relevance] scorer unavailable, extracting ${input.url} (${err instanceof Error ? err.message : String(err)})`);
    return { skip: false, probability: null };
  }

  const skip = probability < deps.skipBelow;
  if (skip) {
    deps.log(
      `[Page Relevance] skipped ${input.url} (p ${probability.toFixed(3)} < ${deps.skipBelow}) for "${input.topic.slice(0, 80)}"`,
    );
  }
  return { skip, probability };
}

// The production wiring. The scorer key is read by the caller (src/api), as
// for resolutionDeps. A config that cannot be read switches the check off:
// the completion must never fail because of the pre-check.
export function pageRelevanceDeps(apiKey: string | null): PageRelevanceDeps {
  const log = (message: string): void => console.log(message);
  let config: DecideConfig;
  try {
    config = loadDecideConfig();
  } catch (err) {
    log(`[Page Relevance] decide config unreadable, check off (${err instanceof Error ? err.message : String(err)})`);
    return { skipBelow: null, score: async () => ({ probability: 1 }), log };
  }
  return {
    skipBelow: config.pageRelevanceSkipBelow,
    score: (topic, page) => decide(PAGE_RELEVANT_QUESTION, pageRelevanceState(topic, page), { config, apiKey, fetchImpl: fetch }),
    log,
  };
}
