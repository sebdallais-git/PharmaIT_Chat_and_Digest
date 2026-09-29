// Dashboard API and health check routes

import { join } from "node:path";
import Database from "better-sqlite3";
import { Router } from "express";
import type { Request, Response } from "express";
import { getDashboardMetrics, getChromaDBMisses, getChromaDBMissStats } from "../services/request-log.js";
import { isChromaDBAvailable, getChromaStatus } from "../services/chromadb-store.js";
import { isNeo4jAvailable } from "../services/graph-store.js";
import { getStats } from "../services/knowledge-store.js";
import { getActiveStack } from "../config/llm-stacks.js";
import { getIndexStatus } from "../services/index-guard.js";
import { isBenchmarkActive } from "../services/bench-mode.js";
import { aggregateHealth, isScorerConfigured, probeGeneration, probeUrl, stackProbeUrls } from "../services/health.js";
import type { HealthCheck } from "../services/health.js";
import { loadDecideConfig } from "../services/decide-config.js";
import { openCanaryStore, summarizeCanaryRuns } from "../services/kb-canary.js";
import type { CanaryStore } from "../services/kb-canary.js";

const router = Router();

const SEARXNG_URL = "http://localhost:8888";

// GET /api/dashboard/metrics
router.get("/metrics", async (_req: Request, res: Response): Promise<void> => {
  try {
    const metrics = getDashboardMetrics();

    // Enrich with live ChromaDB stats
    let totalChunks = 0;
    const knowledgeBySource: Record<string, number> = {};

    try {
      const chromaOk = await isChromaDBAvailable();
      if (chromaOk) {
        const status = await getChromaStatus();
        totalChunks = status.totalChunks;
        for (const src of status.sources) {
          const lower = src.toLowerCase();
          let category = "manual";
          if (lower.includes("rss") || lower.includes("news")) category = "rss";
          else if (lower.includes("n8n-gap") || lower.includes("http")) category = "web";
          else if (lower.includes("regulation") || lower.includes("fda")) category = "regulatory";
          else if (lower.includes("vendor-") || lower.includes("cyber-")) category = "research";
          knowledgeBySource[category] = (knowledgeBySource[category] ?? 0) + 1;
        }
      }
    } catch { /* ChromaDB unavailable */ }

    // Also count in-memory chunks
    const memStats = getStats();
    totalChunks += memStats.totalChunks ?? 0;

    res.json({
      ...metrics,
      total_knowledge_chunks: totalChunks,
      knowledge_by_source: knowledgeBySource,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// GET /api/health
router.get("/health", async (_req: Request, res: Response): Promise<void> => {
  const stack = getActiveStack();
  const urls = stackProbeUrls(stack);
  const checks: Record<string, HealthCheck> = {};

  // Active LLM stack only; the inactive stack is expected to be stopped
  // llm_chat asks the model for a token rather than pinging /v1/models. A
  // wedged MLX serves /v1/models perfectly while generating nothing -- on
  // 2026-09-22 this endpoint reported llm_chat "ok" for a server that timed out
  // a 5-token request at 90s. Liveness is not readiness.
  const [chat, embed] = await Promise.all([
    probeGeneration(stack),
    probeUrl(urls.llm_embed),
  ]);
  checks.llm_chat = chat;
  checks.llm_embed = embed;

  const indexStatus = getIndexStatus();
  checks.search_index = indexStatus.ok ? { status: "ok" } : { status: "error", detail: indexStatus.reason };

  // ChromaDB
  try {
    const start = Date.now();
    const ok = await isChromaDBAvailable();
    checks.chromadb = {
      status: ok ? "ok" : "unreachable",
      latency_ms: Date.now() - start,
    };
  } catch {
    checks.chromadb = { status: "unreachable" };
  }

  // The scorer (open-jev). Deliberately NOT in CRITICAL_CHECKS: only the
  // gap-resolution loop uses it, and that loop degrades to "no decision"
  // rather than to a wrong one.
  //
  // A GET /health is enough here, unlike llm_chat above. A wedged chat server
  // serves /v1/models while generating nothing, so its probe has to ask for a
  // token; a wedged scorer simply fails the decision, and the gap stays open --
  // it cannot quietly produce a bad answer, so liveness is the right question.
  //
  // Installing it is optional and skippable, so on a machine where it was
  // skipped there is nothing to probe: probing anyway reported "unreachable"
  // and pinned this endpoint at "degraded" forever. isScorerConfigured() asks
  // the same question scripts/hermes-setup.sh answers at install time.
  if (!isScorerConfigured()) {
    checks.jev = { status: "not_configured", detail: "open-jev is not installed; gap decisions are unavailable" };
  } else {
    try {
      checks.jev = await probeUrl(`${loadDecideConfig().baseUrl}/health`);
    } catch {
      // A missing or invalid config/decide.yaml must not take down /api/health.
      checks.jev = { status: "error", detail: "decide config unreadable" };
    }
  }

  // SearXNG
  checks.searxng = await probeUrl(`${SEARXNG_URL}/`);

  // Neo4j
  try {
    const start = Date.now();
    const neo4jOk = await isNeo4jAvailable();
    checks.neo4j = {
      status: neo4jOk ? "ok" : "unreachable",
      latency_ms: Date.now() - start,
    };
  } catch {
    checks.neo4j = { status: "unreachable" };
  }

  // SQLite
  checks.sqlite = { status: "ok" };

  // Informational, not a check: a benchmark doesn't make the app unhealthy
  res.json({ status: aggregateHealth(checks), stack: stack.name, benchmark_active: isBenchmarkActive(), checks });
});

// GET /api/dashboard/chromadb-misses — queries that ChromaDB couldn't answer
router.get("/chromadb-misses", (_req: Request, res: Response): void => {
  const stats = getChromaDBMissStats();
  const recent = getChromaDBMisses(50);
  res.json({ stats, recent });
});

// GET /api/dashboard/kb-health - KB canary runs (scripts/kb-canary.ts, daily Hermes job).
// Opened on first request, so importing this module opens nothing.
let canaryStore: CanaryStore | null = null;

router.get("/kb-health", (_req: Request, res: Response): void => {
  try {
    canaryStore ??= openCanaryStore(new Database(join(process.cwd(), "data", "gap_log.db")));
    res.json(summarizeCanaryRuns(canaryStore.list(30)));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
