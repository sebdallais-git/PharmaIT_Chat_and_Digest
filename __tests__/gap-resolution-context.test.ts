import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { buildResolutionContext } from "../src/services/gap-resolution-context.js";
import type { ContextChunk, ResolutionContextDeps } from "../src/services/gap-resolution-context.js";
import { sourceLookupBody } from "../src/services/chromadb-store.js";

// The gap-fill loop stores what it found, then asks the check-resolution
// endpoint to re-answer the question. The endpoint only searched ChromaDB for
// the top 5 of ~9,400 chunks, and on 2026-09-26 (gap #77) the chunk the loop
// had stored seconds earlier, "Sandoz runs an MES core based on PAS-X",
// lost to generic Sandoz profile chunks, so the gap was reported still open.
// The loop now passes the sources it stored, and those chunks are always in
// the context.

const chunk = (source: string, document: string): ContextChunk => ({ document, metadata: { source } });

function fakeDeps(overrides: Partial<ResolutionContextDeps> = {}) {
  const lookups: string[][] = [];
  const deps: ResolutionContextDeps = {
    isChromaDBAvailable: async () => true,
    searchChromaDB: async () => [chunk("profile", "Sandoz is headquartered in Basel."), chunk("revenue", "Revenue was $10bn.")],
    getChromaChunksBySource: async (sources) => {
      lookups.push(sources);
      return [chunk("n8n-gap|https://c.test", "Sandoz runs an MES core based on PAS-X.")];
    },
    searchKnowledge: async () => [{ source: "memory", content: "From the in-memory index." }],
    ...overrides,
  };
  return { deps, lookups };
}

describe("buildResolutionContext", () => {
  it("includes what the loop stored even when the search ranks it out of the top 5", async () => {
    const { deps, lookups } = fakeDeps();
    const context = await buildResolutionContext("Which company is Sandoz's MES partner?", ["n8n-gap|https://c.test"], deps);
    expect(lookups).toEqual([["n8n-gap|https://c.test"]]);
    expect(context).toContain("[Source: n8n-gap|https://c.test]\nSandoz runs an MES core based on PAS-X.");
    expect(context).toContain("Sandoz is headquartered in Basel.");
  });

  it("puts the stored chunks first", async () => {
    const { deps } = fakeDeps();
    const context = await buildResolutionContext("q", ["n8n-gap|https://c.test"], deps);
    expect(context.indexOf("PAS-X")).toBeLessThan(context.indexOf("Basel"));
  });

  it("lists a chunk once when the search also returned it", async () => {
    const stored = chunk("n8n-gap|https://c.test", "Sandoz runs an MES core based on PAS-X.");
    const { deps } = fakeDeps({ searchChromaDB: async () => [stored, chunk("profile", "Basel.")] });
    const context = await buildResolutionContext("q", ["n8n-gap|https://c.test"], deps);
    expect(context.split("PAS-X").length - 1).toBe(1);
  });

  it("behaves as before when no sources are passed", async () => {
    const { deps, lookups } = fakeDeps();
    const context = await buildResolutionContext("q", [], deps);
    expect(lookups).toEqual([]);
    expect(context).toBe(
      "\n\nRelevant context from the knowledge base:\n" +
        "[Source: profile]\nSandoz is headquartered in Basel.\n\n---\n\n[Source: revenue]\nRevenue was $10bn.",
    );
  });

  it("falls back to the in-memory index when ChromaDB is down", async () => {
    const { deps } = fakeDeps({ isChromaDBAvailable: async () => false });
    const context = await buildResolutionContext("q", ["n8n-gap|https://c.test"], deps);
    expect(context).toBe("\n\nRelevant context from the knowledge base:\n[Source: memory]\nFrom the in-memory index.");
  });

  it("falls back to the in-memory index when a ChromaDB call fails", async () => {
    const { deps } = fakeDeps({
      searchChromaDB: async () => {
        throw new Error("ChromaDB query failed (500)");
      },
    });
    const context = await buildResolutionContext("q", [], deps);
    expect(context).toContain("From the in-memory index.");
  });

  it("returns no context when nothing is found anywhere", async () => {
    const { deps } = fakeDeps({ searchChromaDB: async () => [], searchKnowledge: async () => [] });
    expect(await buildResolutionContext("q", [], deps)).toBe("");
  });
});

describe("sourceLookupBody", () => {
  it("asks ChromaDB for the documents stored under any of the sources, capped", () => {
    expect(sourceLookupBody(["n8n-gap|a", "n8n-gap|b"], 10)).toEqual({
      where: { source: { $in: ["n8n-gap|a", "n8n-gap|b"] } },
      limit: 10,
      include: ["documents", "metadatas"],
    });
  });
});

describe("POST /api/knowledge/gaps/check-resolution", () => {
  const route = readFileSync("src/api/knowledge.ts", "utf8");
  const start = route.indexOf('router.post("/gaps/check-resolution"');
  const handler = route.slice(start, route.indexOf("\n});", start));

  it("builds its context with buildResolutionContext, passing the stored sources", () => {
    expect(handler).toMatch(/buildResolutionContext\(original_query,\s*storedSources\)/);
    expect(handler).toMatch(/sources/);
  });
});
