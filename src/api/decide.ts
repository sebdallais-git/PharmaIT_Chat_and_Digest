// Decision endpoint for external workflows (n8n), so they reach the scorer
// through the app instead of calling it directly -- the same arrangement as
// /api/llm/complete. The scorer's address and key stay here; n8n sends only
// the app's API token.
//
// This file does NOT add /api/decide to src/api/auth.ts's BROWSER_ROUTES.
// That list is an allowlist of UNPROTECTED routes; absence from it already
// means protected, which is what a route holding another service's key needs.

import { Router } from "express";
import type { Request, Response } from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decide, ScorerResponseError, ScorerUnavailableError } from "../services/decide.js";
import type { Decision, DecisionQuestion } from "../services/decide.js";
import { loadDecideConfig } from "../services/decide-config.js";

export interface DecideRequest {
  question: DecisionQuestion;
  state: string;
}

export function parseDecideRequest(body: unknown): DecideRequest | { error: string } {
  const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (typeof fields.state !== "string" || fields.state.trim() === "") {
    return { error: "The 'state' field is required" };
  }
  const q = typeof fields.question === "object" && fields.question !== null
    ? (fields.question as Record<string, unknown>)
    : {};
  for (const key of ["id", "instructions", "whenTrue", "whenFalse"]) {
    if (typeof q[key] !== "string" || (q[key] as string).trim() === "") {
      return { error: `question.${key} is required` };
    }
  }
  return {
    state: fields.state,
    question: {
      id: q.id as string,
      instructions: q.instructions as string,
      whenTrue: q.whenTrue as string,
      whenFalse: q.whenFalse as string,
    },
  };
}

export interface DecideRouterDeps {
  decide(question: DecisionQuestion, state: string): Promise<Decision>;
}

// One fixed string per failure class. They are constants, not templates: no
// value from the scorer, from undici, or from an exception message reaches a
// response body, so no leak is possible by construction rather than by
// inspecting what third-party text happens to contain today.
export const DECIDE_ERROR_MESSAGES = {
  unavailable: "The decision service is unavailable",
  invalidResponse: "The decision service returned an unusable response",
  internal: "The decision could not be made",
} as const;

interface DecideFailure {
  status: number;
  message: string;
  logLabel: string;
}

export function classifyDecideFailure(err: unknown): DecideFailure {
  if (err instanceof ScorerUnavailableError) {
    return { status: 503, message: DECIDE_ERROR_MESSAGES.unavailable, logLabel: "scorer unavailable" };
  }
  if (err instanceof ScorerResponseError) {
    return { status: 500, message: DECIDE_ERROR_MESSAGES.invalidResponse, logLabel: "unusable scorer response" };
  }
  return { status: 500, message: DECIDE_ERROR_MESSAGES.internal, logLabel: "decision failed" };
}

export function createDecideRouter(deps: DecideRouterDeps): Router {
  const router = Router();

  router.post("/", async (req: Request, res: Response): Promise<void> => {
    const parsed = parseDecideRequest(req.body);
    if ("error" in parsed) {
      res.status(400).json(parsed);
      return;
    }
    try {
      const decision = await deps.decide(parsed.question, parsed.state);
      res.json(decision);
    } catch (err) {
      // Fixed message per failure class, detail to the server log only.
      //
      // Forwarding err.message was a guarantee about text nobody here wrote:
      // decide.ts interpolates JSON.stringify(noul) out of a SCORER-CONTROLLED
      // body and undici's own err.message into its errors, so "decide.ts never
      // builds a message containing the key" says nothing about what those
      // strings contain. 503 for an outage, so n8n retries; 500 otherwise.
      const failure = classifyDecideFailure(err);
      console.error(
        `[decide] ${failure.logLabel}: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
      );
      res.status(failure.status).json({ error: failure.message });
    }
  });

  return router;
}

// Reads data/run/jev-token if present. Mode 600, never .env, never an argument.
// Exported because src/api/knowledge.ts (Task 5) reuses it rather than
// re-deriving the token path.
export function readScorerKey(): string | null {
  const path = join(process.env.PHARMALLM_RUN_DIR ?? join(process.cwd(), "data", "run"), "jev-token");
  try {
    const value = readFileSync(path, "utf8").trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

// Lazily built so that importing this module opens no file and reads no
// config: every test imports it for parseDecideRequest or createDecideRouter.
let live: DecideRouterDeps | null = null;
function liveDeps(): DecideRouterDeps {
  return (live ??= {
    decide: (question, state) =>
      decide(question, state, { config: loadDecideConfig(), apiKey: readScorerKey(), fetchImpl: fetch }),
  });
}

export default createDecideRouter({
  decide: (question, state) => liveDeps().decide(question, state),
});
