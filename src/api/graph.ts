// API routes for knowledge graph

import { Router } from "express";
import type { Request, Response } from "express";
import {
  isNeo4jAvailable,
  getNeo4jStats,
  searchGraph,
  clearGraph,
} from "../services/graph-store.js";
import { getActiveStack } from "../config/llm-stacks.js";
import { serviceUrl } from "../platform/host-config.js";

const router = Router();

// GET /api/graph/health
router.get("/health", async (_req: Request, res: Response): Promise<void> => {
  const start = Date.now();
  const available = await isNeo4jAvailable();
  const latency = Date.now() - start;

  res.json({
    neo4j: available,
    latency_ms: latency,
  });
});

// GET /api/graph/stats
router.get("/stats", async (_req: Request, res: Response): Promise<void> => {
  try {
    const available = await isNeo4jAvailable();
    if (!available) {
      res.status(503).json({ error: "Neo4j is not reachable" });
      return;
    }

    const stats = await getNeo4jStats();
    res.json(stats);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// POST /api/graph/search - Search graph by entity name
router.post("/search", async (req: Request, res: Response): Promise<void> => {
  const { name } = req.body as { name: string };

  if (!name) {
    res.status(400).json({ error: "The 'name' field is required" });
    return;
  }

  try {
    const results = await searchGraph(name);
    res.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
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
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

export default router;
