import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { NEWS_AGENT_TIMEOUT_MS } from "../src/tools/operations.js";
import { sendJson } from "./helpers/fake-pharmaitchat.js";
import { isToolError, startHarness, toolText } from "./helpers/harness.js";
import type { Harness } from "./helpers/harness.js";

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness.close();
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return harness.client.callTool({ name, arguments: args });
}

describe("tool list", () => {
  it("exposes exactly the 18 PharmaITChat tools", async () => {
    const { tools } = await harness.client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "add_knowledge",
      "artifact_status",
      "ask_pharmaitchat",
      "create_artifact",
      "dashboard_metrics",
      "feedback_report",
      "graph_search",
      "graph_stats",
      "knowledge_status",
      "list_knowledge_gaps",
      "news_agent_status",
      "record_feedback",
      "reindex_status",
      "resolve_knowledge_gap",
      "run_news_agent",
      "search_knowledge",
      "start_reindex",
      "system_health",
    ]);
  });
});

describe("graph tools", () => {
  it("searches an entity by name", async () => {
    harness.pharma.on("POST", "/api/graph/search", (_req, res) => sendJson(res, 200, { results: [{ name: "LockBit" }] }));

    const result = await call("graph_search", { entity: "LockBit" });

    expect(JSON.parse(toolText(result))).toEqual({ results: [{ name: "LockBit" }] });
    expect(harness.pharma.requests[0].body).toEqual({ name: "LockBit" });
  });

  it("returns graph stats", async () => {
    harness.pharma.on("GET", "/api/graph/stats", (_req, res) => sendJson(res, 200, { nodeCount: 498 }));
    expect(JSON.parse(toolText(await call("graph_stats")))).toEqual({ nodeCount: 498 });
  });
});

describe("gap tools", () => {
  // PharmaITChat inserts new gaps as 'triggered', not 'detected' (src/services/gap-detector.ts)
  function serveGaps(): void {
    harness.pharma.on("GET", "/api/knowledge/gaps", (_req, res) =>
      sendJson(res, 200, {
        gaps: [
          { id: 1, status: "resolved" },
          { id: 2, status: "triggered" },
          { id: 3, status: "review" },
        ],
      })
    );
    harness.pharma.on("GET", "/api/knowledge/gaps/stats", (_req, res) => sendJson(res, 200, { total: 2 }));
  }

  it("lists gaps filtered by status with stats", async () => {
    serveGaps();

    const result = await call("list_knowledge_gaps", { status: "triggered" });

    expect(JSON.parse(toolText(result))).toEqual({ gaps: [{ id: 2, status: "triggered" }], stats: { total: 2 } });
  });

  // A gap the scorer parked in the review band is waiting for a human, and this
  // tool is the surface that human (or their agent) queries. Leaving "review"
  // out of the enum made the whole review band unreachable.
  it("lists the gaps parked for human review", async () => {
    serveGaps();

    const result = await call("list_knowledge_gaps", { status: "review" });

    expect(isToolError(result)).toBe(false);
    expect(JSON.parse(toolText(result))).toEqual({ gaps: [{ id: 3, status: "review" }], stats: { total: 2 } });
  });

  it("returns every gap when no status is given", async () => {
    serveGaps();

    const result = await call("list_knowledge_gaps");

    expect(JSON.parse(toolText(result))).toEqual({
      gaps: [
        { id: 1, status: "resolved" },
        { id: 2, status: "triggered" },
        { id: 3, status: "review" },
      ],
      stats: { total: 2 },
    });
  });

  it("resolves a gap", async () => {
    harness.pharma.on("POST", "/api/knowledge/gaps/check-resolution", (_req, res) =>
      sendJson(res, 200, { resolved: true, new_response: "…", confidence_reason: "specific" })
    );

    await call("resolve_knowledge_gap", { gap_id: 7, original_query: "Who attacked Merck?" });

    expect(harness.pharma.requests[0].body).toEqual({ gap_id: 7, original_query: "Who attacked Merck?" });
  });
});

describe("operations tools", () => {
  it("maps health, metrics and news agent status to GET routes", async () => {
    harness.pharma.on("GET", "/api/health", (_req, res) => sendJson(res, 200, { status: "healthy", stack: "ollama" }));
    harness.pharma.on("GET", "/api/dashboard/metrics", (_req, res) => sendJson(res, 200, { questions_7d: 12 }));
    harness.pharma.on("GET", "/api/agent/status", (_req, res) => sendJson(res, 200, { isRunning: false }));

    expect(JSON.parse(toolText(await call("system_health")))).toEqual({ status: "healthy", stack: "ollama" });
    expect(JSON.parse(toolText(await call("dashboard_metrics")))).toEqual({ questions_7d: 12 });
    expect(JSON.parse(toolText(await call("news_agent_status")))).toEqual({ isRunning: false });
  });

  it("runs the news agent", async () => {
    harness.pharma.on("POST", "/api/agent/run", (_req, res) => sendJson(res, 200, { newArticles: 3, topics: 188 }));
    expect(JSON.parse(toolText(await call("run_news_agent")))).toEqual({ newArticles: 3, topics: 188 });
  });

  it("gives up on the news agent at 14 minutes, before Hermes' 900 s tool timeout", () => {
    expect(NEWS_AGENT_TIMEOUT_MS).toBe(840_000);
  });

  it("starts a reindex and reports its status", async () => {
    harness.pharma.on("POST", "/api/knowledge/reindex", (_req, res) => sendJson(res, 202, { job_id: "j-1", status: "running" }));
    harness.pharma.on("GET", "/api/knowledge/reindex/status", (_req, res) =>
      sendJson(res, 200, { job_id: "j-1", status: "running", progress: { raw_documents_done: 64, raw_documents_total: 7023 } })
    );

    expect(JSON.parse(toolText(await call("start_reindex")))).toEqual({ job_id: "j-1", status: "running" });
    expect(JSON.parse(toolText(await call("reindex_status")))).toMatchObject({ status: "running" });
  });

  it("surfaces a 409 when a reindex is already running", async () => {
    harness.pharma.on("POST", "/api/knowledge/reindex", (_req, res) => sendJson(res, 409, { error: "A reindex is already running" }));

    const result = await call("start_reindex");

    expect(isToolError(result)).toBe(true);
    expect(toolText(result)).toBe("PharmaITChat /api/knowledge/reindex failed (409): A reindex is already running");
  });
});

describe("feedback tools", () => {
  it("records feedback", async () => {
    harness.pharma.on("POST", "/api/feedback", (_req, res) => sendJson(res, 200, { id: 42 }));

    await call("record_feedback", { rating: 4, response_id: "r-9", comment: "Good sources" });

    expect(harness.pharma.requests[0].body).toEqual({ rating: 4, response_id: "r-9", comment: "Good sources" });
  });

  it("rejects an out-of-range rating before calling PharmaITChat", async () => {
    const result = await call("record_feedback", { rating: 9 });
    expect(isToolError(result)).toBe(true);
    expect(harness.pharma.requests).toHaveLength(0);
  });

  it("maps report kinds to routes", async () => {
    harness.pharma.on("GET", "/api/feedback/weekly-digest", (_req, res) => sendJson(res, 200, { week: "ok" }));
    expect(JSON.parse(toolText(await call("feedback_report", { kind: "weekly_digest" })))).toEqual({ week: "ok" });
  });
});

describe("payload size", () => {
  it("shortens the stored model answers a gap row carries", async () => {
    harness.pharma.on("GET", "/api/knowledge/gaps", (_req, res) =>
      sendJson(res, 200, {
        gaps: [
          {
            id: 9,
            timestamp: "2026-09-17T10:00:00.000Z",
            original_query: "Novartis breach cost",
            search_topic: "Novartis",
            reason: "low confidence",
            status: "triggered",
            retry_count: 0,
            gemma_response: "g".repeat(4000),
            resolved_response: "r".repeat(4000),
            resolved_at: null,
          },
        ],
      })
    );
    harness.pharma.on("GET", "/api/knowledge/gaps/stats", (_req, res) => sendJson(res, 200, { total_triggered: 1 }));

    const result = await call("list_knowledge_gaps", { status: "triggered" });

    const text = toolText(result);
    expect(text).not.toContain("gemma_response");
    expect(text).toContain("… (4000 chars)");
    expect(text.length).toBeLessThan(1200);
  });

  it("returns the topic count instead of every scrape topic", async () => {
    const topics = Array.from({ length: 188 }, (_, i) => `topic-${i}`);
    harness.pharma.on("GET", "/api/agent/status", (_req, res) =>
      sendJson(res, 200, { isRunning: false, lastRun: { newArticles: 21 }, topics, schedule: "daily" })
    );

    const result = await call("news_agent_status");

    const payload = JSON.parse(toolText(result)) as { topics: { count: number; sample: string[] }; lastRun: { newArticles: number } };
    expect(payload.topics.count).toBe(188);
    expect(payload.topics.sample).toHaveLength(20);
    expect(payload.lastRun.newArticles).toBe(21);
  });
});

describe("list_knowledge_gaps limit", () => {
  it("returns 20 gaps by default and honours a smaller limit", async () => {
    const gaps = Array.from({ length: 50 }, (_, i) => ({ id: i, status: "triggered", original_query: `q${i}` }));
    harness.pharma.on("GET", "/api/knowledge/gaps", (_req, res) => sendJson(res, 200, { gaps }));
    harness.pharma.on("GET", "/api/knowledge/gaps/stats", (_req, res) => sendJson(res, 200, { total_triggered: 50 }));

    const all = JSON.parse(toolText(await call("list_knowledge_gaps"))) as { gaps: unknown[] };
    const three = JSON.parse(toolText(await call("list_knowledge_gaps", { limit: 3 }))) as { gaps: unknown[] };

    expect(all.gaps).toHaveLength(20);
    expect(three.gaps).toHaveLength(3);
  });
});

