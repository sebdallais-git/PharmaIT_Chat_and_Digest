// POST /api/digest {request?, budget?} -> {markdown, period, items}
// For Hermes (make_digest, and the Monday job through scripts/digest.ts). The
// web chat reaches the same agent from /api/chat.

import { Router } from "express";
import type { Request, Response } from "express";
import { CHAT_DIGEST_BUDGET, TELEGRAM_DIGEST_BUDGET, runDigest } from "../services/digest-agent.js";
import type { DigestResult } from "../services/digest-builder.js";

const router = Router();

export interface DigestCall {
  request: string;
  budget: number;
}

export function parseDigestCall(body: unknown): DigestCall | { error: string } {
  const raw = (typeof body === "object" && body !== null ? body : {}) as { request?: unknown; budget?: unknown };
  if (raw.request !== undefined && typeof raw.request !== "string") return { error: "'request' must be a string" };
  const request = typeof raw.request === "string" && raw.request.trim() ? raw.request.trim() : "digest of the last 7 days";
  let budget = TELEGRAM_DIGEST_BUDGET;
  if (raw.budget !== undefined) {
    if (typeof raw.budget !== "number" || !Number.isInteger(raw.budget) || raw.budget < 500 || raw.budget > CHAT_DIGEST_BUDGET) {
      return { error: `'budget' must be an integer between 500 and ${CHAT_DIGEST_BUDGET}` };
    }
    budget = raw.budget;
  }
  return { request, budget };
}

export type DigestRunner = (request: string, budget: number) => Promise<DigestResult>;

export async function digestResponse(body: unknown, run: DigestRunner): Promise<{ status: number; body: object }> {
  const call = parseDigestCall(body);
  if ("error" in call) return { status: 400, body: call };
  try {
    return { status: 200, body: await run(call.request, call.budget) };
  } catch (err) {
    return { status: 503, body: { error: `Digest failed: ${err instanceof Error ? err.message : String(err)}` } };
  }
}

router.post("/", async (req: Request, res: Response): Promise<void> => {
  const { status, body } = await digestResponse(req.body, (request, budget) => runDigest(request, budget));
  res.status(status).json(body);
});

export default router;
