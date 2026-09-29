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

// n8n's HTTP Request node sends all of a step's items at once and awaits them
// together; batching only delays launches. MLX serves one request at a time,
// so 7-9 extraction requests queue, and with a 120 s timeout counted from
// launch the last ones failed (executions 16 and 17, 2026-09-27: 3 and 2 of
// 8 pages lost). The app's own ceiling for a model call is Node fetch's 300 s.
//
// And when nothing relevant was found, the run ended at Store with a 400 for
// an empty text, leaving the gap "triggered" instead of "unresolved".
describe("knowledge gap workflow copes with a slow model and an empty harvest", () => {
  interface Param {
    [key: string]: unknown;
  }
  const params = (name: string) => node(name).parameters as unknown as Param;
  const targets = (name: string, output: number) =>
    (workflow.connections[name]?.main[output] ?? []).map((c) => c.node);

  it("gives each extraction as long as the app waits for the model", () => {
    expect((params("Extract Knowledge (Ollama)").options as Param).timeout).toBe(300000);
  });

  it("stores only relevant facts, and sends an empty harvest elsewhere", () => {
    expect(targets("Filter Relevant Only", 0)).toEqual(["Anything Relevant?"]);
    expect(targets("Anything Relevant?", 0)).toEqual(["Store in Knowledge Base"]);
    expect(targets("Anything Relevant?", 1)).toEqual(["Mark Gap Unresolved"]);
  });

  it("tells the two apart by the error field Filter Relevant Only sets", () => {
    const [empty] = runCode("Filter Relevant Only", [{ json: { response: "NOT_RELEVANT" }, pairedItem: { item: 0 } }], {
      "Truncate & Clean Content": [{ json: { url: "https://a.test" } }],
    });
    const [relevant] = runCode(
      "Filter Relevant Only",
      [{ json: { response: "Sandoz chose SAP S/4HANA for its post-spin-off ERP. ".repeat(2) }, pairedItem: { item: 0 } }],
      { "Truncate & Clean Content": [{ json: { url: "https://a.test" } }] },
    );
    expect(empty.json.error).toBeDefined();
    expect(relevant.json.error).toBeUndefined();

    const condition = ((params("Anything Relevant?").conditions as Param).conditions as Param[])[0];
    expect(condition.leftValue).toBe("={{ $json.error }}");
    expect(condition.operator).toMatchObject({ type: "string", operation: "notExists" });
  });

  it("marks the gap unresolved through the app, with the API token", () => {
    const mark = params("Mark Gap Unresolved");
    const url = String(mark.url).replace(/^=/, "");
    const rendered = url.replace(/\{\{([\s\S]+?)\}\}/g, (_m, expr: string) => {
      const $ = () => itemsOf([webhookItem]);
      return String(new Function("$", `return ${expr};`)($));
    });
    expect(mark.method).toBe("POST");
    expect(rendered).toBe("http://localhost:3000/api/knowledge/gaps/71/unresolved");
    expect(JSON.stringify(mark.headerParameters)).toContain("Bearer {{ $env.PHARMALLM_API_TOKEN }}");
  });
});

// The extraction prompt asks for exactly NOT_RELEVANT when a page is off-topic,
// but the model sometimes explains itself instead. Filter Relevant Only only
// caught responses starting with NOT_RELEVANT, so on 2026-09-27 (execution 18,
// gap #80) "The provided web content is not relevant to the topic..." was
// stored in the knowledge base as if it were a fact.
describe("knowledge gap workflow stores no 'not relevant' explanations", () => {
  const truncated: Item[] = [{ json: { url: "https://a.test", search_topic: gap.search_topic } }];
  const kept = (response: string) =>
    runCode("Filter Relevant Only", [{ json: { response }, pairedItem: { item: 0 } }], {
      "Truncate & Clean Content": truncated,
    }).filter((i) => !i.json.error).length === 1;

  it("drops the explanation that was stored on 2026-09-27", () => {
    expect(
      kept(
        'The provided web content is not relevant to the topic of a "Sandoz cloud provider spin-off." The article discusses the spin-off of Sandoz, which is a generic and biosimilar pharmaceutical unit of Novartis, not a cloud computing provider.',
      ),
    ).toBe(false);
  });

  it.each([
    "NOT_RELEVANT.",
    "not_relevant",
    "This page does not contain any information about Sandoz's cloud provider. It covers quarterly results instead.",
    "There is no relevant information about the topic in this content, which is a cookie banner and navigation links.",
    "The content is irrelevant to the requested topic; it describes a casino loyalty programme and its rewards.",
  ])("drops %j", (response) => {
    expect(kept(response)).toBe(false);
  });

  it("keeps a real summary that mentions relevance later on", () => {
    const summary =
      "Sandoz migrated its ERP landscape to SAP S/4HANA on Microsoft Azure after the 2023 spin-off, run by Accenture. " +
      "The migration covered finance, supply chain and manufacturing. Older Novartis-era reporting tools were retired, " +
      "since they were not relevant to a standalone generics company.";
    expect(kept(summary)).toBe(true);
  });

  it("asks the model for no explanation when a page is off-topic", () => {
    const request = evalJsonBody("Extract Knowledge (Ollama)", { search_topic: "t", page_content: "p" });
    expect(String(request.prompt)).toMatch(/exactly NOT_RELEVANT/);
    expect(String(request.prompt)).toMatch(/no explanation/i);
  });
});

// The resolution check re-answers with the stored chunks in its context, a
// 27B generation on a prompt of several thousand tokens. On 2026-09-27 (gap #81)
// it ran past n8n's 120 s limit, so the run ended without a verdict; run by hand
// the same check took 78 s and resolved the gap.
describe("knowledge gap workflow waits for the resolution check", () => {
  it("gives Check Gap Resolution as long as the app waits for the model", () => {
    const options = (node("Check Gap Resolution").parameters as unknown as { options: { timeout: number } }).options;
    expect(options.timeout).toBe(300000);
  });
});

// Before the 27B reads a page, the app asks the System One scorer whether the
// page is about the topic at all (services/page-relevance.ts); a page it is
// nearly certain about comes back NOT_RELEVANT with no 27B call. The workflow
// only has to send the page along and let its filter drop the answer.
describe("knowledge gap workflow lets the app skip clearly irrelevant pages", () => {
  const page = { search_topic: gap.search_topic, page_content: "x".repeat(8000), url: "https://a.test" };

  it("sends the page it wants summarised as relevance, exactly as the prompt shows it", () => {
    const request = evalJsonBody("Extract Knowledge (Ollama)", page);
    expect(request.relevance).toEqual({ topic: gap.search_topic, page: "x".repeat(6000), url: "https://a.test" });
    expect(String(request.prompt)).toContain("x".repeat(6000));
    expect(String(request.prompt)).not.toContain("x".repeat(6001));
  });

  it("drops a page the app skipped", () => {
    const out = runCode(
      "Filter Relevant Only",
      [{ json: { response: "NOT_RELEVANT", skipped: true, relevance_probability: 0.01 }, pairedItem: { item: 0 } }],
      { "Truncate & Clean Content": [{ json: { url: "https://a.test", search_topic: gap.search_topic } }] },
    );
    expect(out.filter((i) => !i.json.error)).toHaveLength(0);
  });
});

// check-services.sh used to POST {"gap_id":"probe"} to the live webhook to prove
// it answered: 26 runs searched the web for "undefined" and 19 stored junk in the
// knowledge base (MDN's `undefined`, Wikipedia "Undefined", dictionaries, a news
// front page). Any call without a real gap now ends before a search or a 27B call.
describe("knowledge gap workflow only researches real gaps", () => {
  it("validates the call right after the webhook", () => {
    const next = workflow.connections["Knowledge Gap Webhook"].main[0]?.map((c) => c.node);
    expect(next).toEqual(["Validate Gap"]);
    expect(workflow.connections["Validate Gap"].main[0]?.map((c) => c.node)).toEqual(["Generate Search Queries (Ollama)"]);
  });

  const withBody = (body: Record<string, unknown>): Item[] => [
    { json: { headers: {}, params: {}, query: {}, body, webhookUrl: "", executionMode: "production" } },
  ];

  it("passes a real gap through unchanged", () => {
    const input = withBody({ gap_id: 82, search_topic: "Roche Kaiseraugst MES vendor", original_query: "q" });
    expect(runCode("Validate Gap", input)).toEqual(input);
  });

  it.each([
    ["the old health-check probe", { question: "probe", gap_id: "probe", confidence: 0.1 }],
    ["no gap id", { search_topic: "Roche Kaiseraugst MES vendor" }],
    ["no topic", { gap_id: 82 }],
    ["a blank topic", { gap_id: 82, search_topic: "   " }],
    ["a topic of undefined", { gap_id: 82, search_topic: "undefined" }],
  ])("stops %s", (_label, body) => {
    expect(runCode("Validate Gap", withBody(body))).toEqual([]);
  });
});
