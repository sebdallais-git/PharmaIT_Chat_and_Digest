// Status-only updates to a knowledge gap, without re-answering it.
//
// When the gap-fill loop finds nothing relevant there is nothing new to check,
// so spending a 27B re-answer on POST /gaps/check-resolution would learn
// nothing. The workflow marks the gap unresolved directly instead, which also
// records the attempt (markUnresolved increments retry_count).

import { getGapById, markUnresolved } from "./gap-detector.js";

export interface GapStatusDeps {
  getGapById: (gapId: number) => { id: number; status: string } | undefined;
  markUnresolved: (gapId: number) => void;
}

export interface GapStatusResult {
  status: number;
  body: Record<string, unknown>;
}

const defaultDeps: GapStatusDeps = { getGapById, markUnresolved };

export function markGapUnresolved(rawId: string, deps: GapStatusDeps = defaultDeps): GapStatusResult {
  const gapId = Number(rawId);
  if (rawId.trim() === "" || !Number.isInteger(gapId) || gapId <= 0) {
    return { status: 400, body: { error: "The gap id must be a positive integer" } };
  }

  const gap = deps.getGapById(gapId);
  if (!gap) {
    return { status: 404, body: { error: `Gap ${gapId} not found` } };
  }
  // A late or repeated run must not undo a resolution
  if (gap.status === "resolved") {
    return { status: 409, body: { error: `Gap ${gapId} is already resolved` } };
  }

  deps.markUnresolved(gapId);
  return { status: 200, body: { gap_id: gapId, status: "unresolved" } };
}
