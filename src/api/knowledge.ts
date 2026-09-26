// API routes for knowledge base management

import { Router } from "express";
import type { Request, Response } from "express";
import multer from "multer";
import { join } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import {
  ingestText,
  ingestFile,
  searchKnowledge,
  saveIndex,
  getStats,
} from "../services/knowledge-store.js";
import {
  addToChromaDB,
  chromaDocumentExists,
  getChromaStatus,
  isChromaDBAvailable,
} from "../services/chromadb-store.js";
import { saveRawDocument } from "../services/raw-documents.js";
import { ingestTextDocument } from "../services/ingest-text.js";
import { buildResolutionContext } from "../services/gap-resolution-context.js";
import { reindexActiveStack } from "../services/reindex.js";
import { createReindexJobs } from "../services/reindex-jobs.js";
import { isSupportedFile, getSupportedExtensions, parseBuffer } from "../services/file-parser.js";
import {
  getRecentGaps,
  getGapStats,
  checkConfidence,
  resolveGap,
  markUnresolved,
  getGapById,
} from "../services/gap-detector.js";
import { getLlmClient, StackUnavailableError } from "../services/llm-client.js";
import { assertIndexUsable } from "../services/index-guard.js";
import type { ChatMessage } from "../services/llm-client.js";
import { getRunningJobs, isBenchmarkActive, trackJob } from "../services/bench-mode.js";
import type { GraphEntity, GraphRelationship } from "../services/graph-store.js";

const router = Router();

const KNOWLEDGE_DIR = join(process.cwd(), "knowledge");


// Multer configuration for file uploads
const upload = multer({ storage: multer.memoryStorage() });

// GET /api/knowledge/stats - Knowledge base statistics
router.get("/stats", (_req: Request, res: Response): void => {
  res.json(getStats());
});

// POST /api/knowledge/search - Search the knowledge base
router.post("/search", async (req: Request, res: Response): Promise<void> => {
  const { query, topK } = req.body as { query: string; topK?: number };

  if (!query) {
    res.status(400).json({ error: "The 'query' field is required" });
    return;
  }

  try {
    const results = await searchKnowledge(query, topK ?? 5);
    res.json({ results });
  } catch (err) {
    res.status(503).json({ error: err instanceof Error ? err.message : "Search failed" });
  }
});

// POST /api/knowledge/ingest-text - Ingest raw text
router.post("/ingest-text", async (req: Request, res: Response): Promise<void> => {
  const { text, source } = req.body as { text: string; source: string };

  if (!text || !source) {
    res.status(400).json({ error: "The 'text' and 'source' fields are required" });
    return;
  }

  let added: number;
  let chromaAdded: number;
  try {
    // Raw document, in-memory index and ChromaDB: chat retrieval reads ChromaDB first
    ({ added, chromaAdded } = await ingestTextDocument(text, source));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Ingestion failed";
    const unavailable = err instanceof StackUnavailableError || message.startsWith("Search refused");
    res.status(unavailable ? 503 : 500).json({ error: message });
    return;
  }
  // Deliberately no graph write: the vendor graph is built from parsed
  // frontmatter and declared install base only. See
  // docs/superpowers/specs/2026-09-21-vendor-intel-graph-design.md.

  res.json({ message: `${added} chunks added from '${source}'`, added, chromaAdded });
});

// POST /api/knowledge/upload - Upload a knowledge file
router.post(
  "/upload",
  upload.single("file"),
  async (req: Request, res: Response): Promise<void> => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No file provided" });
      return;
    }

    if (!isSupportedFile(file.originalname)) {
      res.status(400).json({
        error: `Unsupported file type. Accepted: ${getSupportedExtensions().join(", ")}`,
      });
      return;
    }

    // Save the file to knowledge/
    await mkdir(KNOWLEDGE_DIR, { recursive: true });
    const destPath = join(KNOWLEDGE_DIR, file.originalname);
    await writeFile(destPath, file.buffer);

    let text: string;
    let added: number;
    try {
      text = await parseBuffer(file.buffer, file.originalname);
      // Raw document first, so the text is included in the next rebuild even if indexing fails now
      await saveRawDocument(file.originalname, text, { type: "upload" });
      assertIndexUsable();
      added = await ingestText(text, file.originalname);
      await saveIndex();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Ingestion failed";
      const unavailable = err instanceof StackUnavailableError || message.startsWith("Search refused");
      res.status(unavailable ? 503 : 500).json({ error: message });
      return;
    }
  // Deliberately no graph write: the vendor graph is built from parsed
  // frontmatter and declared install base only. See
  // docs/superpowers/specs/2026-09-21-vendor-intel-graph-design.md.

    res.json({
      message: `File '${file.originalname}' ingested (${added} chunks)`,
      added,
    });
  }
);

// GET /api/knowledge/status - ChromaDB knowledge base status
router.get("/status", async (_req: Request, res: Response): Promise<void> => {
  try {
    const available = await isChromaDBAvailable();
    if (!available) {
      res.status(503).json({
        error: "ChromaDB server is not reachable",
        chromadb: false,
      });
      return;
    }

    const status = await getChromaStatus();
    res.json({
      chromadb: true,
      totalChunks: status.totalChunks,
      totalDocuments: status.sources.length,
      lastAdded: status.lastAdded,
      sources: status.sources,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// POST /api/knowledge/add - Add content to ChromaDB via URL or raw text
router.post("/add", async (req: Request, res: Response): Promise<void> => {
  const { url, text, source } = req.body as {
    url?: string;
    text?: string;
    source?: string;
  };

  if (!url && !text) {
    res.status(400).json({ error: "Provide either 'url' or 'text'" });
    return;
  }

  try {
    const available = await isChromaDBAvailable();
    if (!available) {
      res.status(503).json({ error: "ChromaDB server is not reachable" });
      return;
    }

    // Ingest from URL
    if (url) {
      // Check for duplicates
      const exists = await chromaDocumentExists(url);
      if (exists) {
        res.json({ message: "Document already exists in ChromaDB", added: 0, source: url });
        return;
      }

      // Fetch and extract text from the URL
      console.log(`[Knowledge] Fetching URL: ${url}`);
      const pageResp = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        },
        signal: AbortSignal.timeout(30000),
      });

      if (!pageResp.ok) {
        res.status(400).json({ error: `Failed to fetch URL (${pageResp.status})` });
        return;
      }

      const html = await pageResp.text();

      // Basic HTML-to-text extraction (strip tags, scripts, styles)
      const cleaned = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<nav[\s\S]*?<\/nav>/gi, "")
        .replace(/<header[\s\S]*?<\/header>/gi, "")
        .replace(/<footer[\s\S]*?<\/footer>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&[a-z]+;/gi, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 10000);

      // Save raw content for future re-indexing
      await saveRawDocument(url, cleaned, { type: "url" });

      const added = await addToChromaDB(
        [cleaned],
        [{ source: url }]
      );

      console.log(`[Knowledge] Added ${added} chunks from URL: ${url}`);
      res.json({ message: `Added ${added} chunks from URL`, added, source: url });
      return;
    }

    // Ingest raw text
    if (text) {
      const sourceName = source ?? `text-${Date.now()}`;

      // Save raw content for future re-indexing
      await saveRawDocument(sourceName, text, { type: "text" });

      const added = await addToChromaDB(
        [text],
        [{ source: sourceName }]
      );

      console.log(`[Knowledge] Added ${added} chunks from text (source: ${sourceName})`);
      res.json({ message: `Added ${added} chunks`, added, source: sourceName });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Knowledge] Add failed:", message);
    res.status(500).json({ error: message });
  }
});

// GET /api/knowledge/gaps - Recent knowledge gaps
router.get("/gaps", (_req: Request, res: Response): void => {
  try {
    const gaps = getRecentGaps(50);
    res.json({ gaps });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// GET /api/knowledge/gaps/stats - Gap statistics
router.get("/gaps/stats", (_req: Request, res: Response): void => {
  try {
    const stats = getGapStats();
    res.json(stats);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// POST /api/knowledge/gaps/check-resolution - Re-check if a gap is now resolved
router.post("/gaps/check-resolution", async (req: Request, res: Response): Promise<void> => {
  const { gap_id, original_query, search_topic, sources } = req.body as {
    gap_id?: number;
    original_query?: string;
    search_topic?: string;
    // Sources the gap-fill loop just stored; their chunks always lead the context
    sources?: unknown;
  };
  const storedSources = Array.isArray(sources)
    ? sources.filter((s): s is string => typeof s === "string" && s.length > 0).slice(0, 20)
    : [];

  if (!gap_id || !original_query) {
    res.status(400).json({ error: "gap_id and original_query are required" });
    return;
  }

  try {
    // Verify gap exists
    const gap = getGapById(gap_id);
    if (!gap) {
      res.status(404).json({ error: `Gap ${gap_id} not found` });
      return;
    }

    // Re-ask through the RAG pipeline: what the loop stored, the top ChromaDB hits,
    // or the in-memory index when ChromaDB is unavailable
    const context = await buildResolutionContext(original_query, storedSources);

    const systemPrompt = `You are PharmaBot, an expert in pharmaceutical cybersecurity. Use the following context to answer the question accurately and specifically.${context}`;

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: original_query },
    ];

    const newResponse = await trackJob("gap-resolution", () => getLlmClient().chat(messages));

    // Run confidence check on the new response
    const confidence = await trackJob("gap-resolution", () => checkConfidence(original_query, newResponse));

    if (confidence.confident) {
      resolveGap(gap_id, newResponse);
      console.log(`[Gap Resolution] Gap ${gap_id} RESOLVED for topic: "${search_topic ?? ""}"`);
      res.json({
        resolved: true,
        new_response: newResponse,
        confidence_reason: confidence.reason,
      });
    } else {
      markUnresolved(gap_id);
      console.log(`[Gap Resolution] Gap ${gap_id} still UNRESOLVED for topic: "${search_topic ?? ""}"`);
      res.json({
        resolved: false,
        new_response: newResponse,
        confidence_reason: confidence.reason,
      });
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[Gap Resolution] Error checking gap ${gap_id}:`, errMsg);
    res.status(500).json({ error: errMsg });
  }
});

// Background reindex jobs (a rebuild takes 12-16 minutes, longer than any HTTP client should wait)
const reindexJobs = createReindexJobs((onProgress) =>
  trackJob("reindex", () => reindexActiveStack(console.log, undefined, onProgress))
);

// POST /api/knowledge/reindex - Start rebuilding the active stack's indexes in the background
router.post("/reindex", (_req: Request, res: Response): void => {
  if (reindexJobs.isRunning() || getRunningJobs().includes("reindex")) {
    res.status(409).json({ error: "A reindex is already running" });
    return;
  }
  if (isBenchmarkActive()) {
    res.status(409).json({ error: "Benchmark in progress — reindex after it finishes" });
    return;
  }

  const { job_id } = reindexJobs.start();
  res.status(202).json({ job_id, status: "running" });
});

// GET /api/knowledge/reindex/status - State and progress of the most recent reindex job
router.get("/reindex/status", (_req: Request, res: Response): void => {
  res.json(reindexJobs.status());
});

export default router;
