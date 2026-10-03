// API routes for the vendor-intelligence graph.
//
// createGraphRouter takes its services as arguments so route tests never reach
// Neo4j, the watchlist database or the brief files; the default export binds
// the live ones lazily (nothing connects at import time).
import { Router } from "express";
import type { Request, Response } from "express";
import { join } from "node:path";
import { competitivePosition, type CompetitiveDeps } from "../services/competitive-graph.js";
import { liveCompetitiveDeps } from "../services/competitive-graph-live.js";
import { watchlistEvidence } from "../services/graph-evidence.js";
import { getDriver, getNeo4jStats, isNeo4jAvailable } from "../services/graph-store.js";
import { neo4jWriteTransaction, rebuildVendorGraph, type RebuildResult } from "../services/vendor-graph-rebuild.js";

export interface GraphRouterDeps {
  isAvailable(): Promise<boolean>;
  stats(): Promise<Awaited<ReturnType<typeof getNeo4jStats>>>;
  competitive(): CompetitiveDeps;
  /** Wipe and rewrite the graph from briefs, needs and accounts, in one transaction. */
  rebuild(): Promise<RebuildResult>;
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
    if (body.history !== undefined && body.history !== "recent" && body.history !== "full") {
      res.status(400).json({ error: 'history must be "recent" or "full" when given' });
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
        history: body.history as "recent" | "full" | undefined,
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

  // POST /api/graph/rebuild - rebuild the graph from knowledge/vendors, config/needs.yaml and
  // config/accounts.local.yaml. Deterministic, no model call, so it works on every stack.
  let rebuilding = false;
  router.post("/rebuild", async (_req: Request, res: Response): Promise<void> => {
    if (rebuilding) {
      res.status(409).json({ error: "A graph rebuild is already running" });
      return;
    }
    rebuilding = true;
    try {
      if (!(await deps.isAvailable())) {
        res.status(503).json({ error: "Neo4j is not reachable" });
        return;
      }
      const result = await deps.rebuild();
      console.log(`[Graph Rebuild] ${result.nodes} nodes, ${result.relationships} relationships`);
      res.json({ message: "Graph rebuild complete", nodes: result.nodes, relationships: result.relationships, output: result.lines });
    } catch (err) {
      console.error("[Graph Rebuild] Error:", errorMessage(err));
      res.status(500).json({ error: errorMessage(err) });
    } finally {
      rebuilding = false;
    }
  });

  return router;
}

export function liveGraphRouterDeps(): GraphRouterDeps {
  return {
    isAvailable: isNeo4jAvailable,
    stats: getNeo4jStats,
    rebuild: () =>
      rebuildVendorGraph(
        { root: process.cwd(), evidence: watchlistEvidence(join(process.cwd(), "data", "watchlist.db")) },
        neo4jWriteTransaction(getDriver()),
      ),
    competitive: liveCompetitiveDeps,
  };
}

export default createGraphRouter(liveGraphRouterDeps());
