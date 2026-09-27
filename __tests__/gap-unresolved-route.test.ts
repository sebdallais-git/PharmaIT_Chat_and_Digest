import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { markGapUnresolved } from "../src/services/gap-status.js";
import type { GapStatusDeps } from "../src/services/gap-status.js";

// When the gap-fill loop finds nothing relevant it has nothing to re-check,
// but the gap should still move from "triggered" to "unresolved". A full
// check-resolution call would spend a 27B re-answer to learn nothing new, so
// the workflow calls POST /api/knowledge/gaps/:id/unresolved instead.

function fakeDeps(status: string | undefined) {
  const marked: number[] = [];
  const deps: GapStatusDeps = {
    getGapById: (id) => (status === undefined ? undefined : { id, status }),
    markUnresolved: (id) => {
      marked.push(id);
    },
  };
  return { deps, marked };
}

describe("markGapUnresolved", () => {
  it("marks a triggered gap unresolved", () => {
    const { deps, marked } = fakeDeps("triggered");
    expect(markGapUnresolved("78", deps)).toEqual({ status: 200, body: { gap_id: 78, status: "unresolved" } });
    expect(marked).toEqual([78]);
  });

  it("never downgrades a gap that is already resolved", () => {
    const { deps, marked } = fakeDeps("resolved");
    expect(markGapUnresolved("78", deps)).toEqual({ status: 409, body: { error: "Gap 78 is already resolved" } });
    expect(marked).toEqual([]);
  });

  it("answers 404 for a gap that does not exist", () => {
    const { deps, marked } = fakeDeps(undefined);
    expect(markGapUnresolved("999", deps).status).toBe(404);
    expect(marked).toEqual([]);
  });

  it("answers 400 for an id that is not a positive integer", () => {
    for (const id of ["abc", "0", "-3", "1.5", ""]) {
      const { deps, marked } = fakeDeps("triggered");
      expect(markGapUnresolved(id, deps).status).toBe(400);
      expect(marked).toEqual([]);
    }
  });
});

describe("POST /api/knowledge/gaps/:id/unresolved", () => {
  it("is routed through markGapUnresolved", () => {
    const route = readFileSync("src/api/knowledge.ts", "utf8");
    const start = route.indexOf('router.post("/gaps/:id/unresolved"');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(route.slice(start, route.indexOf("\n});", start))).toMatch(/markGapUnresolved\(/);
  });

  it("is not one of the open browser routes, so it needs the API token", () => {
    const auth = readFileSync("src/api/auth.ts", "utf8");
    expect(auth).not.toMatch(/gaps\/[^"]*unresolved/);
  });
});
