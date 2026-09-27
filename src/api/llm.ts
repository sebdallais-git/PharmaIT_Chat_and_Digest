// Completion endpoint for external workflows (n8n), so they use the active LLM stack instead of calling Ollama directly

import { Router } from "express";
import type { Request, Response } from "express";
import { getLlmClient, StackUnavailableError } from "../services/llm-client.js";
import { isBenchmarkActive, trackJob } from "../services/bench-mode.js";
import { checkPageRelevance, pageRelevanceDeps } from "../services/page-relevance.js";
import type { PageRelevanceInput, PageRelevanceResult } from "../services/page-relevance.js";
import { readScorerKey } from "./decide.js";

const router = Router();

export interface CompletionRequest {
  prompt: string;
  temperature?: number;
  // A fetched page the gap workflow wants summarised: the scorer is asked
  // first whether it is about the topic (services/page-relevance.ts)
  relevance?: PageRelevanceInput;
}

// Malformed relevance is dropped, not rejected: the completion itself is valid
function parseRelevance(raw: unknown): PageRelevanceInput | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.topic !== "string" || typeof r.page !== "string") return undefined;
  return { topic: r.topic, page: r.page, url: typeof r.url === "string" && r.url ? r.url : "unknown" };
}

export function parseCompletionRequest(body: unknown): CompletionRequest | { error: string } {
  const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (typeof fields.prompt !== "string" || !fields.prompt.trim()) {
    return { error: "The 'prompt' field is required" };
  }
  // Ollama /api/generate bodies carry the temperature in "options"; a top-level value wins
  const options = typeof fields.options === "object" && fields.options !== null
    ? (fields.options as Record<string, unknown>)
    : {};
  const temperature = typeof fields.temperature === "number" ? fields.temperature : options.temperature;
  const relevance = parseRelevance(fields.relevance);
  return {
    prompt: fields.prompt,
    ...(typeof temperature === "number" ? { temperature } : {}),
    ...(relevance ? { relevance } : {}),
  };
}

export interface CompleteOrSkipDeps {
  checkRelevance(input: PageRelevanceInput): Promise<PageRelevanceResult>;
  complete(prompt: string, temperature?: number): Promise<string>;
}

export interface CompletionResult {
  response: string;
  skipped?: boolean;
  relevance_probability?: number | null;
}

/**
 * Runs the completion, unless the request carries a page the scorer is nearly
 * certain is off-topic: then NOT_RELEVANT, the answer the extraction prompt
 * asks the 27B for in that case, so the workflow's filter drops it unchanged.
 */
export async function completeOrSkip(req: CompletionRequest, deps: CompleteOrSkipDeps): Promise<CompletionResult> {
  if (!req.relevance) return { response: await deps.complete(req.prompt, req.temperature) };
  const check = await deps.checkRelevance(req.relevance);
  if (check.skip) return { response: "NOT_RELEVANT", skipped: true, relevance_probability: check.probability };
  return { response: await deps.complete(req.prompt, req.temperature), skipped: false, relevance_probability: check.probability };
}

// POST /api/llm/complete - Ollama /api/generate-shaped completion on the active stack
router.post("/complete", async (req: Request, res: Response): Promise<void> => {
  const parsed = parseCompletionRequest(req.body);
  if ("error" in parsed) {
    res.status(400).json(parsed);
    return;
  }
  if (isBenchmarkActive()) {
    res.status(503).json({ error: "Benchmark in progress — try again later" });
    return;
  }

  const llm = getLlmClient();
  try {
    const result = await completeOrSkip(parsed, {
      checkRelevance: (input) => checkPageRelevance(input, pageRelevanceDeps(readScorerKey())),
      complete: (prompt, temperature) =>
        trackJob("n8n-completion", () => llm.chat([{ role: "user", content: prompt }], { temperature })),
    });
    res.json({ ...result, done: true, stack: llm.stack.name, model: llm.stack.chatModel });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Completion failed";
    res.status(err instanceof StackUnavailableError ? 503 : 500).json({ error: message });
  }
});

export default router;
