// Routes API pour le chat

import { chunkDateOf, knowledgeContextBlock, todayLine } from "../services/chunk-date.js";
import { Router } from "express";
import type { Request, Response } from "express";
import multer from "multer";
import { execFile } from "node:child_process";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isThinkingLevel, thinkingLevels, type ThinkingLevel } from "../services/thinking.js";
import { getActiveStack } from "../config/llm-stacks.js";
import { getLlmClient } from "../services/llm-client.js";
import type { ChatMessage, StatsCollector } from "../services/llm-client.js";
import { getIndexStatus } from "../services/index-guard.js";
import type { ChatTimings } from "../services/bench-mode.js";
import { searchKnowledge } from "../services/knowledge-store.js";
import { searchChromaDB } from "../services/chromadb-store.js";
import type { ChromaQueryResult } from "../services/chromadb-store.js";
import { searchWeb } from "../services/web-search.js";
import { handleGapDetection } from "../services/gap-detector.js";
import { createResponseEntry } from "../services/response-cache.js";
import { logRequest, logChromaDBMiss } from "../services/request-log.js";
import { isNeo4jAvailable, queryGraphForChat } from "../services/graph-store.js";
import { openRoleStore } from "../services/role-store.js";
import { activeRolePreamble, roleReplyFor } from "../services/role-dialogue.js";
import { isDigestRequest } from "../services/digest-request.js";
import { CHAT_DIGEST_BUDGET, runDigest } from "../services/digest-agent.js";

const router = Router();

// Extract key terms from a natural-language question for web search
// Google News is strict — extra words can kill results, so we aggressively
// filter to keep only the meaningful nouns and proper nouns.
function extractSearchQuery(message: string): string {
  const dropWords = new Set([
    // question words & pronouns
    "what", "why", "how", "when", "where", "who", "which", "whose",
    "is", "are", "was", "were", "am", "be", "been", "being",
    "do", "does", "did", "will", "would", "could", "should", "can", "may", "might",
    "has", "have", "had", "shall",
    "i", "me", "my", "we", "our", "you", "your", "he", "she", "it", "its",
    "they", "them", "their", "this", "that", "these", "those",
    // prepositions & conjunctions
    "the", "a", "an", "of", "in", "for", "on", "with", "to", "and", "or",
    "not", "at", "by", "from", "as", "into", "but", "so", "if", "then",
    "there", "here", "up", "out", "about", "over", "after", "before",
    // common verbs that hurt search specificity
    "tell", "know", "think", "explain", "describe", "talk", "say", "said",
    "get", "got", "make", "made", "take", "took", "give", "go", "going",
    "come", "came", "see", "look", "want", "need", "use", "used", "try",
    "keep", "let", "seem", "show", "hear", "believe", "happen", "happen",
    "mean", "means", "brags", "brag", "bragging", "claim", "claims",
    "says", "says", "discuss", "mention", "mentioned", "called",
    // fillers
    "please", "thanks", "really", "very", "just", "also", "recently",
    "actually", "basically", "currently", "new", "latest", "much",
  ]);

  const keywords = message
    .replace(/[^a-zA-Z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !dropWords.has(w.toLowerCase()));

  // Limit to 5 terms max for search precision
  return keywords.slice(0, 5).join(" ");
}

// Extract keywords from a question for graph search (no LLM call — instant)
function extractGraphKeywords(message: string): string[] {
  // Reuse the same drop-word filtering as web search, but keep longer terms
  // that are likely entity names (proper nouns, multi-word terms)
  const words = message
    .replace(/[^a-zA-Z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);

  // Keep capitalized words (likely entity names) and longer terms
  const keywords = words.filter((w) => /^[A-Z]/.test(w) || w.length > 4);
  return [...new Set(keywords)].slice(0, 5);
}

// Session-level toggle for naming companies in cyber incident responses
let nameCompanies = false;

const BASE_SYSTEM_PROMPT = `You are PharmaBot, an expert assistant in the pharmaceutical industry.
You answer questions on the following topics:
- Pharma business: mergers, acquisitions, commercial strategies, pipelines, pricing
- Pharma science: mechanisms of action, clinical trials, pharmacology, drug formulation
- Pharma news: FDA/EMA approvals, product launches, regulation
- Drug pipeline: Phase 3 candidates, peak sales estimates, market value forecasts, revenue projections
- Cyber threats: ransomware, data breaches, IP theft, manufacturing shutdowns, market impact
- Manufacturing: top pharma plants worldwide, facility investment value, production capacity, downtime costs per hour/day, batch loss values, geographic concentration risk (Basel, Ireland, RTP, Singapore)
- IT vendors: Dell, Everpure (formerly Pure Storage), NetApp, HPE, NVIDIA, VAST, WEKA, CrowdStrike, Splunk, SAP, ServiceNow, Snowflake, Databricks
- Cybersecurity partners: BBS (Bug Bounty Switzerland) — the leading Swiss platform for AI-driven security testing and ethical hacking, founded 2020, headquartered in Zurich

Abbreviations:
- BBS = Bug Bounty Switzerland (NOT "Business Breakthrough Solution"). Always interpret BBS as Bug Bounty Switzerland AG.

Rules:
- Use the following context as your PRIMARY source, then ENRICH with your general knowledge of the vendor's specific products, capabilities, and deployment models. The context anchors your answer but should never limit it — always add relevant product details, real-world capabilities, and pharma-specific use cases from your own knowledge.
- When discussing IT vendors and their cybersecurity solutions, ALWAYS cite specific product names (e.g., "Dell PowerProtect Cyber Recovery with CyberSense", not "data protection solutions"). Describe what each product specifically does, how it deploys, and map it to concrete pharmaceutical use cases (clinical trials, MES, LIMS, regulatory compliance). Never give generic vendor advice — ground every recommendation in a named product with its actual capabilities.
- When the context contains relevant data (tables, lists, numbers, costs, facility names, incident details, company names, dates), use it directly and specifically. Include concrete numbers, dollar amounts, company names, and dates. Never say "the context does not contain" when specific data points are available — aggregate them into a clear answer instead.
- If the context has no relevant information, answer based on your general knowledge. Whether or not context is provided, always aim for the same level of product-specific detail. Do NOT add disclaimers about confidence — the system handles that automatically.
- Cite sources when using the provided context.
- Respond in the same language as the question.`;

const NAMES_ON_PROMPT = `
- When discussing cyber incidents, data breaches, ransomware attacks, or security events, ALWAYS name the specific companies, organizations, and threat actors involved if this information is publicly known. Include dates, attack vectors, and financial impact where available. Do NOT anonymize or redact company names — the user wants full transparency on publicly reported incidents.`;

const NAMES_OFF_PROMPT = `
- When discussing cyber incidents, you may reference companies only in general terms without naming specific victims unless the user explicitly asks.`;

function getSystemPrompt(): string {
  // Today's date first: "Q2" or "last year" means nothing without it.
  return todayLine(new Date()) + "\n\n" + BASE_SYSTEM_PROMPT + (nameCompanies ? NAMES_ON_PROMPT : NAMES_OFF_PROMPT);
}

const GAP_DISCLAIMER = "\n\n---\n*I'm not fully confident in this answer. I'm researching this topic now and should know more soon.*";

// Same cap on both stacks so benchmark answers are comparable
const BENCHMARK_MAX_TOKENS = 1024;

// POST /api/chat - Send a message and receive a streaming response
router.post("/", async (req: Request, res: Response): Promise<void> => {
  // A "model" field in the body is ignored: the active stack's chat model is always used,
  // because mlx_lm.server would otherwise download and load any requested repository
  const { message, history, webSearch, benchmark, thinking } = req.body as {
    message: string;
    history?: ChatMessage[];
    webSearch?: boolean;
    benchmark?: boolean;
    thinking?: string;
  };

  if (!message) {
    res.status(400).json({ error: "The 'message' field is required" });
    return;
  }

  // Refused rather than downgraded: a level the stack cannot honour would
  // otherwise look like it worked and change nothing.
  const activeStack = getActiveStack();
  if (thinking !== undefined && !isThinkingLevel(activeStack, thinking)) {
    res.status(400).json({
      error: `thinking level "${thinking}" is not supported on the ${activeStack.name} stack`,
      supported: thinkingLevels(activeStack),
    });
    return;
  }

  // Handle /names toggle command
  const trimmed = message.trim().toLowerCase();
  if (trimmed === "/names") {
    nameCompanies = !nameCompanies;
    const state = nameCompanies ? "ON" : "OFF";
    const detail = nameCompanies
      ? "I will name specific companies in cyber incident responses."
      : "I will keep cyber incident responses generic.";
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.write(`data: ${JSON.stringify({ token: `Company names are now **${state}**. ${detail}` })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
    return;
  }

  // The user's role is set by chatting ("I am the Dell GAM for Roche...", "add Lonza to my accounts")
  const roleStore = openRoleStore();
  const roleReply = await roleReplyFor(message, { benchmark: benchmark === true, store: roleStore });
  if (roleReply !== null) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.write(`data: ${JSON.stringify({ token: roleReply })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
    return;
  }

  // "Make me a digest of what happened this week": the digest agent, built from the
  // watchlist, not a 5-chunk RAG answer
  if (benchmark !== true && isDigestRequest(message)) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.write(`data: ${JSON.stringify({ reasoning: "Building your digest from the watchlist (about a minute)...", sources: [] })}\n\n`);
    try {
      const digest = await runDigest(message, CHAT_DIGEST_BUDGET);
      res.write(`data: ${JSON.stringify({ token: digest.markdown })}\n\n`);
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: `Digest failed: ${err instanceof Error ? err.message : String(err)}` })}\n\n`);
    }
    res.end();
    return;
  }

  const llm = getLlmClient();
  const chatModel = llm.stack.chatModel;

  // Refuse early when the index was built by another stack or embedding model
  const indexStatus = getIndexStatus();
  if (!indexStatus.ok) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.write(`data: ${JSON.stringify({ error: `Search index unusable on the ${llm.stack.name} stack: ${indexStatus.reason}` })}\n\n`);
    res.end();
    return;
  }

  const requestStart = Date.now();

  // SSE streaming configuration — set up early so we can send reasoning steps
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sendReasoning = (text: string, sources?: string[]) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ reasoning: text, sources: sources ?? [] })}\n\n`);
    }
  };

  // ── Parallel RAG pipeline ──────────────────────────────────────────
  // Compute the query embedding ONCE, then fan out all searches in parallel.
  // This eliminates the sequential waterfall that was killing TTFT.
  let contextBlock = "";
  let chunkIds: string[] = [];
  let hadRagContext = false;
  let chromaMissReason = "";
  let hadInmemoryFallback = false;
  let graphContext = "";

  sendReasoning("Searching knowledge base...");

  // Step 1: Single embedding call (shared by ChromaDB + in-memory)
  let queryEmbedding: number[] | undefined;
  const embedStart = Date.now();
  try {
    queryEmbedding = await llm.embed(message, "query");
  } catch (err) {
    console.error("[RAG] Embedding failed, falling back to keyword-only search:", err);
    sendReasoning("Embedding service unavailable, using keyword search...");
  }
  const embedMs = Date.now() - embedStart;
  const retrievalStart = Date.now();

  // Step 2: Fan out ALL searches in parallel
  const chromaPromise = (async () => {
    if (!queryEmbedding) return false; // ChromaDB requires an embedding vector
    try {
      const chromaResults = await searchChromaDB(message, 5, queryEmbedding);
      if (chromaResults.length > 0) {
        contextBlock = knowledgeContextBlock(
          chromaResults.map((r: ChromaQueryResult) => ({
            source: String(r.metadata.source ?? "unknown"),
            date: chunkDateOf(r.metadata),
            text: r.document,
          })),
        );
        chunkIds = chromaResults.map((r: ChromaQueryResult) => r.id);
        hadRagContext = true;
        const sourceNames = chromaResults.map((r: ChromaQueryResult) => String(r.metadata.source ?? "unknown"));
        sendReasoning(`Found ${chromaResults.length} relevant chunks from ChromaDB`, sourceNames);
        console.log(`[RAG] ChromaDB returned ${chromaResults.length} chunks`);
        return true;
      }
      chromaMissReason = "no_results";
      return false;
    } catch (err) {
      chromaMissReason = "error";
      console.error("[RAG] ChromaDB search failed, falling back to in-memory:", err);
      return false;
    }
  })();

  const inmemoryPromise = (async () => {
    // Always compute in-memory results in parallel — use them only if ChromaDB misses
    try {
      return await searchKnowledge(message, 8, queryEmbedding);
    } catch (err) {
      console.error("[RAG] In-memory search failed:", err instanceof Error ? err.message : err);
      return [];
    }
  })();

  const graphSearchPromise = (async () => {
    try {
      const neo4jAvailable = await isNeo4jAvailable();
      if (!neo4jAvailable) return;

      const keywords = extractGraphKeywords(message);
      if (keywords.length === 0) return;

      sendReasoning("Searching knowledge graph...");

      const graphResult = await Promise.race([
        queryGraphForChat(keywords),
        new Promise<string>((resolve) => setTimeout(() => resolve(""), 3000)),
      ]);

      if (graphResult) {
        graphContext = graphResult;
        const entityNames = keywords.filter((k) => graphContext.toLowerCase().includes(k.toLowerCase()));
        sendReasoning(
          `Found ${entityNames.length} entities in knowledge graph`,
          entityNames
        );
      } else {
        sendReasoning("No graph matches found");
      }
    } catch {
      // Silent fail — graph is optional
    }
  })();

  const webSearchPromise = (async () => {
    // Benchmarks skip web search: live results would differ between runs
    if (webSearch === false || benchmark) return "";
    try {
      const searchQuery = extractSearchQuery(message);
      sendReasoning(`Searching the web for: "${searchQuery}"...`);
      const webResults = await searchWeb(searchQuery, 3);
      if (webResults.length > 0) {
        const webSources = webResults.map((r) => r.title);
        sendReasoning(`Found ${webResults.length} web results`, webSources);
        return "\n\nRecent news from web search:\n" +
          webResults
            .map((r) => `[${r.title}] (${r.date})\n${r.snippet}`)
            .join("\n\n---\n\n");
      }
      sendReasoning("No relevant web results found");
      return "";
    } catch {
      sendReasoning("Web search unavailable, skipping...");
      return "";
    }
  })();

  // Wait for all searches to complete in parallel
  const [chromaHit, inmemoryResults, , webContext] = await Promise.all([
    chromaPromise,
    inmemoryPromise,
    graphSearchPromise,
    webSearchPromise,
  ]);
  const retrievalMs = Date.now() - retrievalStart;

  // Use in-memory results as fallback only if ChromaDB missed
  if (!chromaHit && inmemoryResults.length > 0) {
    contextBlock = knowledgeContextBlock(
      inmemoryResults.map((c) => ({ source: c.source, date: c.date ?? null, text: c.content })),
    );
    chunkIds = inmemoryResults.map((c) => c.source);
    hadRagContext = true;
    hadInmemoryFallback = true;
    const sourceNames = [...new Set(inmemoryResults.map((c) => c.source))];
    sendReasoning(`Found ${inmemoryResults.length} chunks from knowledge base`, sourceNames);
    console.log(`[RAG] In-memory store returned ${inmemoryResults.length} chunks`);
  } else if (!chromaHit) {
    if (!chromaMissReason) chromaMissReason = "unavailable";
    sendReasoning("No relevant knowledge base context found");
  }

  // Append web results
  if (webContext) {
    contextBlock += webContext;
  }

  // Log ChromaDB miss for future KB growth
  if (chromaMissReason) {
    setImmediate(() => {
      logChromaDBMiss({ query: message, reason: chromaMissReason, hadInmemoryFallback });
    });
  }

  if (graphContext) {
    contextBlock += "\n\n" + graphContext;
  }

  sendReasoning(`Generating response with ${chatModel} on ${llm.stack.name.toUpperCase()}...`);

  const messages: ChatMessage[] = [
    { role: "system", content: getSystemPrompt() + activeRolePreamble({ benchmark: benchmark === true, store: roleStore }) + contextBlock },
    ...(history ?? []),
    { role: "user", content: message },
  ];

  try {
    // Collect the full response during streaming
    let fullResponse = "";
    const statsCollector: StatsCollector = {};

    // Thinking is emitted as its own event, never as `token`: the MCP client
    // consumes this same stream for the Telegram path and does
    // `answer += event.token`.
    for await (const token of llm.streamChat(
      messages,
      {
        temperature: benchmark ? 0 : undefined,
        maxTokens: benchmark ? BENCHMARK_MAX_TOKENS : undefined,
        thinking: thinking as ThinkingLevel | undefined,
        onReasoning: (text) => {
          if (!res.writableEnded) res.write(`data: ${JSON.stringify({ thinking: text })}\n\n`);
        },
      },
      statsCollector
    )) {
      fullResponse += token;
      res.write(`data: ${JSON.stringify({ token })}\n\n`);
    }

    // A turn can end cleanly having produced no answer at all: with thinking
    // on, reasoning spends the same budget, so the ceiling can be reached
    // before the answer starts. That used to render as an empty bubble beside
    // a token count, which looks like a broken app rather than a spent budget.
    if (statsCollector.result?.truncated && fullResponse.length === 0) {
      const note =
        thinking && thinking !== "off"
          ? "The model used its entire token budget reasoning and never started the answer. " +
            "Set Thinking to off for this question, or ask something narrower."
          : "The model hit its token limit before writing anything.";
      res.write(`data: ${JSON.stringify({ error: note })}\n\n`);
    } else if (statsCollector.result?.truncated) {
      res.write(`data: ${JSON.stringify({ truncated: true })}\n\n`);
    }

    // Store response metadata and generate response_id for feedback
    const responseId = createResponseEntry(
      message,
      fullResponse,
      chunkIds,
      hadRagContext,
      chatModel
    );

    const responseTimeMs = Date.now() - requestStart;
    const stats = statsCollector.result;
    const timings: ChatTimings = {
      embedMs,
      retrievalMs,
      ttftMs: stats?.ttftMs ?? 0,
      decodeTokPerSec: stats?.tokensPerSecond ?? 0,
      promptTokens: stats?.promptTokens ?? 0,
      completionTokens: stats?.completionTokens ?? 0,
      totalMs: responseTimeMs,
    };

    // Send done IMMEDIATELY — don't wait for gap detection
    res.write(`data: ${JSON.stringify({
      done: true,
      response_id: responseId,
      stack: llm.stack.name,
      tokenStats: stats ?? null,
      timings,
      ...(benchmark ? { chunkIds } : {}),
    })}\n\n`);
    res.end();

    // Benchmark runs skip gap detection and request logging: no background GPU work, no dashboard noise
    if (benchmark) return;

    // Gap detection + logging run in background (no longer blocks the response)
    setImmediate(() => {
      handleGapDetection(message, fullResponse)
        .then((gapDetected) => {
          if (gapDetected) {
            console.log(`[Gap Detector] Knowledge gap detected for: "${message.slice(0, 80)}..."`);
          }
          logRequest({
            query: message,
            responseTimeMs,
            hadRagContext,
            wasConfident: !gapDetected,
            chunksUsedCount: chunkIds.length,
            responseLength: fullResponse.length,
          });
        })
        .catch((err) => {
          console.error("[Gap Detector] Background check failed:", err instanceof Error ? err.message : err);
          logRequest({
            query: message,
            responseTimeMs,
            hadRagContext,
            wasConfident: true,
            chunksUsedCount: chunkIds.length,
            responseLength: fullResponse.length,
          });
        });
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    res.write(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
    res.end();
  }
});

// GET /api/chat/models - The active stack's chat model (the only model chat requests use)
router.get("/models", async (_req: Request, res: Response): Promise<void> => {
  const llm = getLlmClient();
  const stackInfo = {
    stack: llm.stack.name,
    chatModel: llm.stack.chatModel,
    embeddingModel: llm.stack.embeddingModel,
    // The UI renders exactly these and no more, so a level it offers is always
    // one the active stack can honour.
    thinkingLevels: thinkingLevels(llm.stack),
  };
  try {
    // Probe the stack so an unreachable stack still reports 503
    await llm.listModels();
    res.json({ ...stackInfo, models: [llm.stack.chatModel] });
  } catch (err) {
    res.status(503).json({
      ...stackInfo,
      error: err instanceof Error ? err.message : "LLM stack unavailable",
      models: [],
    });
  }
});

// POST /api/chat/transcribe - Transcribe audio via whisper.cpp
const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const WHISPER_BIN = join(process.cwd(), "node_modules", "whisper-node", "lib", "whisper.cpp", "main");
const WHISPER_MODEL = join(process.cwd(), "node_modules", "whisper-node", "lib", "whisper.cpp", "models", "ggml-base.en.bin");
const TMP_DIR = join(process.cwd(), "data", "tmp");

router.post("/transcribe", audioUpload.single("audio"), async (req: Request, res: Response): Promise<void> => {
  if (!req.file) {
    res.status(400).json({ error: "No audio file provided" });
    return;
  }

  const id = randomUUID();
  // Determine extension from original filename (webm, mp4, ogg, etc.)
  const origName = req.file.originalname ?? "audio.webm";
  const ext = origName.split(".").pop() ?? "webm";
  const inputPath = join(TMP_DIR, `${id}.${ext}`);
  const wavPath = join(TMP_DIR, `${id}.wav`);

  try {
    await mkdir(TMP_DIR, { recursive: true });
    await writeFile(inputPath, req.file.buffer);
    console.log(`[Transcribe] Received ${req.file.size} bytes (${ext}), saved to ${inputPath}`);

    // Convert any audio format to 16kHz mono WAV using ffmpeg
    await new Promise<void>((resolve, reject) => {
      execFile("ffmpeg", ["-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath, "-y"],
        { timeout: 15000 },
        (err, _stdout, stderr) => {
          if (err) {
            console.error("[Transcribe] ffmpeg error:", stderr);
            reject(new Error("Audio conversion failed: " + (stderr || err.message)));
            return;
          }
          resolve();
        }
      );
    });

    // Run whisper.cpp
    const transcript = await new Promise<string>((resolve, reject) => {
      execFile(WHISPER_BIN, ["-m", WHISPER_MODEL, "-f", wavPath, "-nt", "-l", "en"],
        { timeout: 30000 },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(stderr || err.message));
            return;
          }
          // whisper.cpp outputs text lines with timestamps — extract text only
          const text = stdout
            .split("\n")
            .map((line) => line.replace(/^\[.*?\]\s*/, "").trim())
            .filter(Boolean)
            .join(" ")
            .trim();
          resolve(text);
        }
      );
    });

    res.json({ text: transcript });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Transcription failed";
    console.error("[Transcribe]", msg);
    res.status(500).json({ error: msg });
  } finally {
    // Cleanup temp files
    unlink(inputPath).catch(() => {});
    unlink(wavPath).catch(() => {});
  }
});

export default router;
