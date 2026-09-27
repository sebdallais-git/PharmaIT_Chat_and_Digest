import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keptByFilter, pagesFromRunData, reportRows, unflatten } from "../scripts/lib/page-relevance-replay.js";

// scripts/replay-page-relevance.ts measures the page pre-check against n8n's
// own history: every past gap run stored each fetched page beside the 27B's
// extraction, and the workflow's filter says which of those were kept. These
// tests build that history in memory; nothing reads the live n8n database.

describe("unflatten", () => {
  // n8n stores execution data in the "flatted" format: one array, where
  // strings of digits point at other entries so shared objects appear once
  it("resolves index references, including shared ones", () => {
    const flat = JSON.stringify([{ a: "1", b: "1", c: "2" }, { x: "3" }, ["3", "4"], "hello", 7]);
    expect(unflatten(flat)).toEqual({ a: { x: "hello" }, b: { x: "hello" }, c: ["hello", 7] });
  });
});

describe("keptByFilter", () => {
  // The rule must be the workflow's own; run the Filter node's code to compare
  const workflow = JSON.parse(readFileSync(join(process.cwd(), "n8n", "knowledge_gap_workflow_v2.json"), "utf-8")) as {
    nodes: { name: string; parameters: { jsCode?: string } }[];
  };
  const code = workflow.nodes.find((n) => n.name === "Filter Relevant Only")?.parameters.jsCode ?? "";
  function workflowKeeps(json: Record<string, unknown>): boolean {
    const list = [{ json, pairedItem: { item: 0 } }];
    const $ = () => ({ itemMatching: () => ({ json: {} }) });
    const $input = { all: () => list };
    const fn = new Function("$", "$input", code) as (...args: unknown[]) => { json: Record<string, unknown> }[];
    return fn($, $input).some((i) => !i.json.error);
  }

  it.each([
    "NOT_RELEVANT",
    "NOT_RELEVANT.",
    "This page does not contain any information about the topic at all, it is a login form for staff.",
    "The content is irrelevant to the requested topic; it describes a casino loyalty programme and its rewards.",
    "short",
    "Merck settled its NotPetya insurance dispute for an undisclosed sum in 2024 after a New Jersey appellate ruling.",
    "Sandoz runs SAP S/4HANA on Azure since the spin-off. Older tools were retired as not relevant to a generics firm.",
  ])("agrees with the workflow's Filter node on %j", (response) => {
    expect(keptByFilter({ response })).toBe(workflowKeeps({ response }));
  });

  it("gives no verdict for a failed extraction", () => {
    expect(keptByFilter({ error: "timeout" })).toBeNull();
  });
});

describe("pagesFromRunData", () => {
  const run = (items: Record<string, unknown>[]) => [{ data: { main: [items.map((json) => ({ json }))] } }];

  it("pairs each page with the extraction made from it", () => {
    const pages = pagesFromRunData(7, {
      "Truncate & Clean Content": run([
        { url: "https://a", search_topic: "t", page_content: "page a" },
        { url: "https://b", search_topic: "t", page_content: "page b" },
      ]),
      "Extract Knowledge (Ollama)": run([{ response: "NOT_RELEVANT" }, { response: "A real summary of page b that is long enough to keep." }]),
    });
    expect(pages).toEqual([
      { exec: 7, url: "https://a", topic: "t", page: "page a", kept: false },
      { exec: 7, url: "https://b", topic: "t", page: "page b", kept: true },
    ]);
  });

  it("leaves out failed extractions and runs that never reached extraction", () => {
    expect(
      pagesFromRunData(1, {
        "Truncate & Clean Content": run([{ url: "https://a", search_topic: "t", page_content: "p" }]),
        "Extract Knowledge (Ollama)": run([{ error: "timeout" }]),
      }),
    ).toEqual([]);
    expect(pagesFromRunData(2, {})).toEqual([]);
  });
});

describe("reportRows", () => {
  const pages = [
    { kept: true, p: 0.4 },
    { kept: false, p: 0.01 },
    { kept: false, p: 0.15 },
    { kept: false, p: 0.9 },
  ];

  it("counts, per threshold, the discarded pages skipped and the kept pages lost", () => {
    expect(reportRows(pages, [0.1, 0.5])).toEqual([
      { threshold: 0.1, skippedDiscarded: 1, lostKept: 0 },
      { threshold: 0.5, skippedDiscarded: 2, lostKept: 1 },
    ]);
  });
});
