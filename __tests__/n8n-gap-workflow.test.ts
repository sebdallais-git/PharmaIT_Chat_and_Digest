import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Runs pieces of n8n/knowledge_gap_workflow_v2.json against a webhook item
// shaped the way n8n actually delivers it: the POSTed JSON sits under `body`,
// beside headers, params and query. The workflow read the gap fields from the
// top level instead, so on 2026-09-26 it asked the model for queries about
// "undefined" and got back "general web search", "latest news" and
// "trending topics".

interface WorkflowNode {
  name: string;
  parameters: { jsCode?: string; jsonBody?: string };
}

interface Item {
  json: Record<string, unknown>;
  // Index of the item this one was derived from, as n8n records it
  pairedItem?: { item: number };
}

const WEBHOOK = "Knowledge Gap Webhook";
const workflow = JSON.parse(
  readFileSync(join(process.cwd(), "n8n", "knowledge_gap_workflow_v2.json"), "utf-8"),
) as { nodes: WorkflowNode[]; connections: Record<string, { main: ({ node: string }[] | null)[] }> };

function node(name: string): WorkflowNode {
  const found = workflow.nodes.find((n) => n.name === name);
  if (!found) throw new Error(`no node named ${name}`);
  return found;
}

const gap = {
  gap_id: 71,
  original_query: "Who is the SAP S/4HANA integrator for Sandoz?",
  search_topic: "Sandoz SAP S/4HANA integrator",
  gemma_response: "The context does not say.",
};

// What n8n's webhook node emits for a POST with that JSON body
const webhookItem: Item = {
  json: { headers: {}, params: {}, query: {}, body: gap, webhookUrl: "", executionMode: "production" },
};

function itemsOf(list: Item[]) {
  return { first: () => list[0], all: () => list, item: list[0] };
}

// Runs a Code node's JavaScript with n8n's `$` and `$input` stood in for.
// itemMatching(i) follows input item i's pairedItem back to the named node,
// which is how n8n traces an item to the one it was derived from.
function runCode(name: string, input: Item[] = [], upstream: Record<string, Item[]> = {}): Item[] {
  const code = node(name).parameters.jsCode;
  if (!code) throw new Error(`${name} has no code`);
  const $ = (other: string) => {
    const list = other === WEBHOOK ? [webhookItem] : (upstream[other] ?? []);
    return { ...itemsOf(list), itemMatching: (i: number) => list[input[i]?.pairedItem?.item ?? i] };
  };
  const quiet = { log: () => {}, warn: () => {}, error: () => {} };
  const fn = new Function("$", "$input", "console", code) as (...args: unknown[]) => Item[];
  return fn($, itemsOf(input), quiet);
}

// Evaluates an HTTP Request node's `={{ ... }}` JSON body with $json bound
function evalJsonBody(name: string, $json: Record<string, unknown>): Record<string, unknown> {
  const body = node(name).parameters.jsonBody ?? "";
  const expr = body.replace(/^=\{\{/, "").replace(/\}\}$/, "");
  const fn = new Function("$json", "$env", `return ${expr};`) as (...args: unknown[]) => string;
  return JSON.parse(fn($json, {})) as Record<string, unknown>;
}

describe("knowledge gap workflow reads the gap from the webhook body", () => {
  it("asks the model for search queries about the gap's topic", () => {
    const request = evalJsonBody("Generate Search Queries (Ollama)", webhookItem.json);
    expect(request.prompt).toContain("Sandoz SAP S/4HANA integrator");
    expect(request.prompt).toContain("Who is the SAP S/4HANA integrator for Sandoz?");
    expect(request.prompt).not.toContain("undefined");
  });

  it("carries the topic and question with every parsed query", () => {
    const out = runCode("Parse Search Queries", [{ json: { response: '["q1", "q2"]' } }]);
    expect(out).toHaveLength(2);
    for (const item of out) {
      expect(item.json.search_topic).toBe(gap.search_topic);
      expect(item.json.original_query).toBe(gap.original_query);
    }
  });

  it("falls back to searching the topic itself when the model returns no queries", () => {
    const out = runCode("Parse Search Queries", [{ json: { response: "" } }]);
    expect(out.map((i) => i.json.query)).toEqual([gap.search_topic]);
  });

  it("carries the topic with every deduplicated search result", () => {
    const out = runCode("Deduplicate Results", [
      { json: { results: [{ url: "https://example.test/a", title: "A" }] } },
    ]);
    expect(out[0].json.search_topic).toBe(gap.search_topic);
    expect(out[0].json.original_query).toBe(gap.original_query);
  });

  it("hands Check Gap Resolution the gap id, or the gap can never be marked resolved", () => {
    const [summary] = runCode("Summary & Log", [{ json: {} }], {
      "Deduplicate Results": [{ json: { url: "https://example.test/a" } }],
      "Filter Relevant Only": [{ json: {} }],
    });
    expect(summary.json.gap_id).toBe(71);
    const check = evalJsonBody("Check Gap Resolution", summary.json);
    // Nothing was stored in this run, so there are no stored sources to pass on
    expect(check).toEqual({ gap_id: 71, original_query: gap.original_query, search_topic: gap.search_topic, sources: [] });
  });

  it("falls back to the topic when query generation fails", () => {
    const [item] = runCode("Ollama Query Error Handler");
    expect(item.json.query).toBe(gap.search_topic);
    expect(item.json.original_query).toBe(gap.original_query);
  });

  it("names the topic when SearXNG fails", () => {
    const [item] = runCode("SearXNG Error Handler");
    expect(item.json.search_topic).toBe(gap.search_topic);
  });

  it("never reads a gap field from the top level of the webhook item", () => {
    // Guards nodes added later: the gap is always under .body
    const topLevel = /\$\('Knowledge Gap Webhook'\)\.(?:first\(\)|item)\.json\.(?!body\b)\w+/;
    for (const n of workflow.nodes) {
      expect(JSON.stringify(n.parameters)).not.toMatch(topLevel);
    }
  });
});

// An HTTP Request node with onError "continueErrorOutput" splits its items:
// successes on output 0, failures on output 1. Both outputs of Fetch Page
// Content, Extract Knowledge and Store in Knowledge Base were wired into the
// same next node, so whenever one item failed everything downstream ran twice.
// On 2026-09-26 (execution 15, gap #77) the first pass ran a full resolution
// check before anything had been stored. And because the success batch no
// longer lines up with the node before it, matching items by position put
// pages under the wrong URL.
describe("knowledge gap workflow survives partial failures", () => {
  const page = (words: string) => `<html><body><p>${words} ${"lorem ipsum ".repeat(20)}</p></body></html>`;
  const dedupe: Item[] = ["https://a.test", "https://b.test", "https://c.test"].map((url) => ({
    json: { url, search_topic: gap.search_topic },
  }));

  it("labels each fetched page with its own URL when an earlier fetch failed", () => {
    // b.test failed, so the success batch holds a.test and c.test only
    const out = runCode(
      "Truncate & Clean Content",
      [
        { json: { data: page("alpha") }, pairedItem: { item: 0 } },
        { json: { data: page("gamma") }, pairedItem: { item: 2 } },
      ],
      { "Deduplicate Results": dedupe },
    );
    expect(out.map((i) => [i.json.url, String(i.json.page_content).slice(0, 5)])).toEqual([
      ["https://a.test", "alpha"],
      ["https://c.test", "gamma"],
    ]);
  });

  it("keeps each extracted fact with its page's URL when another extraction failed", () => {
    const truncated: Item[] = [
      { json: { url: "https://a.test", search_topic: gap.search_topic, page_content: "a" } },
      { json: { url: "https://c.test", search_topic: gap.search_topic, page_content: "c" } },
    ];
    // Extraction for a.test failed, so only c.test's comes through
    const out = runCode(
      "Filter Relevant Only",
      [{ json: { response: "Sandoz runs an MES core based on PAS-X across its sites. ".repeat(2) }, pairedItem: { item: 1 } }],
      { "Truncate & Clean Content": truncated },
    );
    expect(out.map((i) => i.json.url)).toEqual(["https://c.test"]);
  });

  it("never wires a failure output into the node that handles successes", () => {
    for (const [from, conn] of Object.entries(workflow.connections)) {
      const [ok, failed] = conn.main;
      const okTargets = new Set((ok ?? []).map((c) => c.node));
      for (const c of failed ?? []) {
        expect(`${from} failure -> ${c.node}`).not.toBe(okTargets.has(c.node) ? `${from} failure -> ${c.node}` : "");
      }
    }
  });
});

// The resolution check re-answers the question right after the loop stored its
// findings, but only searched the top 5 of ~9,400 chunks, so on 2026-09-26
// (gap #77) it never saw what had just been stored. The workflow now tells it
// which sources it stored.
describe("knowledge gap workflow hands the resolution check what it stored", () => {
  const filtered: Item[] = [
    { json: { url: "https://a.test", summary: "fact a" } },
    { json: { url: "https://c.test", summary: "fact c" } },
  ];

  it("names the sources that were actually stored", () => {
    // Storing a.test failed, so only c.test's response reaches the summary
    const [summary] = runCode("Summary & Log", [{ json: { added: 1, chromaAdded: 1 }, pairedItem: { item: 1 } }], {
      "Deduplicate Results": [{ json: { url: "https://a.test" } }, { json: { url: "https://c.test" } }],
      "Filter Relevant Only": filtered,
    });
    expect(summary.json.stored_sources).toEqual(["n8n-gap|https://c.test"]);
  });

  it("names them exactly as Store in Knowledge Base labels them", () => {
    const stored = evalJsonBody("Store in Knowledge Base", filtered[1].json);
    const [summary] = runCode("Summary & Log", [{ json: { added: 1 }, pairedItem: { item: 1 } }], {
      "Filter Relevant Only": filtered,
    });
    expect(summary.json.stored_sources).toEqual([stored.source]);
  });

  it("sends the stored sources to the resolution check", () => {
    const check = evalJsonBody("Check Gap Resolution", {
      gap_id: 71,
      original_query: gap.original_query,
      search_topic: gap.search_topic,
      stored_sources: ["n8n-gap|https://c.test"],
    });
    expect(check.sources).toEqual(["n8n-gap|https://c.test"]);
  });
});
