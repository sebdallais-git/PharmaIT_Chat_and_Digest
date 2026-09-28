// Does this chat turn reveal a knowledge gap worth researching?
//
// Every gap sends the n8n loop to search the web, fetch and extract up to nine
// pages and re-check the answer: minutes of 27B time that competes with live
// chat. The check used until 2026-09-27 (checkConfidence) asked whether the
// answer gave "specific, confident information", flagged 39% of all chat
// turns, and in two blind spot-checks the user judged the flagged answer a
// real answer 14 times out of 15 random production gaps -- including
// "What is your favorite color?", researched twice.
//
// So a gap now needs two things, judged in the same single 27B call:
//   in_scope -- the question is about the domain this knowledge base covers,
//               not small talk, a personal question or a follow-up about the
//               conversation itself;
//   answered -- false only when the answer mainly says the information is
//               missing or unknown, refuses, or offers nothing but generality.
//               General knowledge and "the sources are incomplete" still count
//               as answered.
//
// Measured on 2026-09-27 (64 cases: 43 the user labelled blind, 11 answers
// that plainly say the information is missing, 9 hedged-but-substantive, 1
// out of scope): false gaps on answers the user accepted fell from 19 to 9 of
// 41, small talk is kept out, and 9 of the 11 missing-information answers are
// still caught. The two misses are one question asked twice ("Which ERP
// system did Sandoz choose...?"): the answer said there was no information,
// then listed the vendors Sandoz uses, and that list was read as an answer.
// A wording that caught it ("even if it then lists loosely related context")
// brought the false gaps back to 17, so this one was chosen.
//
// checkConfidence stays as it is: gap RESOLUTION still asks the strict
// question, since there the point is whether the research delivered the facts.

import { getLlmClient } from "./llm-client.js";

export interface NeedsResearchVerdict {
  // False when the reply could not be read; no gap is raised then
  parsed: boolean;
  inScope: boolean;
  answered: boolean;
  gap: boolean;
  reason: string;
  search_topic: string;
}

export function needsResearchPrompt(question: string, answer: string): string {
  return `You decide whether a chat answer reveals a gap in a knowledge base about the pharma, biotech and life-sciences industry, its IT and cybersecurity, and its technology vendors, worth researching on the web.

Question: ${question}
Answer: ${answer}

Decide two things:
1. in_scope: is the question about that domain, or about companies, people, products or events in it? Greetings, small talk, personal questions (such as a favourite colour), requests about the conversation itself (such as "make it shorter") and general trivia are NOT in scope.
2. answered: did the answer give the user a substantive response, such as facts, names, figures, examples, or the requested writing, comparison or advice, even if it draws on general knowledge or notes that its sources are incomplete? Answer false ONLY if the answer mainly says the information is not available or that it does not know, refuses, or gives nothing but vague generalities.

Respond with ONLY a JSON object, no other text:
{"in_scope": true/false, "answered": true/false, "reason": "brief explanation", "search_topic": "2-5 word web search query for the missing information, or empty"}`;
}

const UNREADABLE: NeedsResearchVerdict = {
  parsed: false,
  inScope: false,
  answered: true,
  gap: false,
  reason: "Could not read the verdict",
  search_topic: "",
};

// Strict: Boolean("false") is true, so a quoted boolean is read by its spelling
function readBoolean(value: unknown): boolean | null {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

export function parseNeedsResearch(text: string): NeedsResearchVerdict {
  const match = text.match(/\{[\s\S]*?\}/);
  if (!match) return UNREADABLE;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return UNREADABLE;
  }
  const inScope = readBoolean(raw.in_scope);
  const answered = readBoolean(raw.answered);
  if (inScope === null || answered === null) return UNREADABLE;
  return {
    parsed: true,
    inScope,
    answered,
    gap: inScope && !answered,
    reason: String(raw.reason ?? ""),
    search_topic: String(raw.search_topic ?? ""),
  };
}

export type CompleteFn = (prompt: string) => Promise<string>;

const defaultComplete: CompleteFn = (prompt) =>
  getLlmClient().chat([{ role: "user", content: prompt }], { temperature: 0.1 });

export async function checkNeedsResearch(
  question: string,
  answer: string,
  complete: CompleteFn = defaultComplete,
): Promise<NeedsResearchVerdict> {
  try {
    return parseNeedsResearch(await complete(needsResearchPrompt(question, answer)));
  } catch {
    // A failed check must not create a gap
    return { ...UNREADABLE, reason: "Detection check failed" };
  }
}
