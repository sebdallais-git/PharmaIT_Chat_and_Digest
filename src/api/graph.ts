// API routes for the vendor-intelligence graph.
//
// createGraphRouter takes its services as arguments so route tests never reach
// Neo4j, the watchlist database or the brief files; the default export binds
// the live ones lazily (nothing connects at import time).
import { Router } from "express";
import type { Request, Response } from "express";
import { join } from "node:path";
import { getActiveStack } from "../config/llm-stacks.js";
import { serviceUrl } from "../platform/host-config.js";
import { competitivePosition, type CompetitiveDeps } from "../services/competitive-graph.js";
import { normaliseName } from "../services/competitive-position.js";
import { liveReader } from "../services/export-wiring.js";
import { clearGraph, getNeo4jStats, isNeo4jAvailable } from "../services/graph-store.js";
import { loadBriefExcerpts } from "../services/vendor-brief-excerpts.js";
import { loadWatchlist } from "../services/watchlist-config.js";

export interface GraphRouterDeps {
  isAvailable(): Promise<boolean>;
  stats(): Promise<Awaited<ReturnType<typeof getNeo4jStats>>>;
  competitive(): CompetitiveDeps;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

export function createGraphRouter(deps: GraphRouterDeps): Router {
  const router = Router();

  // GET /api/graph/health
  router.get("/health", async (_req: Request, res: Response): Promise<void> => {
    const start = Date.now();
    const available = await deps.isAvailable();
    res.json({ neo4j: available, latency_ms: Date.now() - start });
  });

  // GET /api/graph/stats
  router.get("/stats", async (_req: Request, res: Response): Promise<void> => {
    try {
      if (!(await deps.isAvailable())) {
        res.status(503).json({ error: "Neo4j is not reachable" });
        return;
      }
      res.json(await deps.stats());
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // POST /api/graph/competitive-position - a vendor's standing per account segment, incumbency first
  router.post("/competitive-position", async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!optionalString(body.vendor) || !optionalString(body.account) || !optionalString(body.segment)) {
      res.status(400).json({ error: "vendor, account and segment must be strings when given" });
      return;
    }
    try {
      if (!(await deps.isAvailable())) {
        res.status(503).json({ error: "Neo4j is not reachable" });
        return;
      }
      const result = await competitivePosition(deps.competitive(), {
        vendor: body.vendor,
        account: body.account,
        segment: body.segment,
      });
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json(result.answer);
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // POST /api/graph/rebuild - Trigger full graph rebuild (calls Python script)
  router.post("/rebuild", async (_req: Request, res: Response): Promise<void> => {
    // Checked before clearing anything: the builder would otherwise wipe the graph and then fail
    if (getActiveStack().name !== "ollama") {
      res.status(409).json({
        error: "Graph rebuild uses python/graph_builder.py, which calls Ollama directly; switch to the Ollama stack first",
      });
      return;
    }

    const { execFile } = await import("node:child_process");

    try {
      const available = await isNeo4jAvailable();
      if (!available) {
        res.status(503).json({ error: "Neo4j is not reachable" });
        return;
      }

      await clearGraph();

      execFile(
        "python3",
        ["python/graph_builder.py"],
        {
          cwd: process.cwd(),
          timeout: 600000,
          // The builder has no defaults of its own: endpoints come from config/host.yaml
          env: { ...process.env, NEO4J_URI: serviceUrl("neo4j"), OLLAMA_URL: serviceUrl("ollama") },
        },
        (err, stdout, stderr) => {
          if (err) {
            console.error("[Graph Rebuild] Error:", stderr);
            if (!res.writableEnded) {
              res.status(500).json({ error: stderr || err.message });
            }
            return;
          }
          console.log("[Graph Rebuild]", stdout);
          if (!res.writableEnded) {
            res.json({ message: "Graph rebuild complete", output: stdout });
          }
        }
      );
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  return router;
}

/** Normalised alias and name -> entity id, from config/watchlist.yaml (e.g. "pure-storage" -> "everpure"). */
function watchlistAliases(): Record<string, string> {
  try {
    const aliases: Record<string, string> = {};
    for (const entity of loadWatchlist().entities.values()) {
      for (const name of [entity.name, ...entity.aliases]) aliases[normaliseName(name)] = entity.id;
    }
    return aliases;
  } catch (err) {
    // An invalid watchlist must not take the query down: ids still resolve without aliases.
    console.error("[Graph] watchlist aliases unavailable:", errorMessage(err));
    return {};
  }
}

export function liveGraphRouterDeps(): GraphRouterDeps {
  return {
    isAvailable: isNeo4jAvailable,
    stats: getNeo4jStats,
    competitive: () => {
      const reader = liveReader();
      return {
        runCypher: (query, params) => reader.runCypher(query, params),
        recentItems: (entity, domains, limit) => reader.itemsFor(entity, limit, domains),
        briefs: () => loadBriefExcerpts(join(process.cwd(), "knowledge", "vendors")),
        vendorAliases: watchlistAliases,
      };
    },
  };
}

export default createGraphRouter(liveGraphRouterDeps());
