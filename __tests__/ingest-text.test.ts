import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { ingestTextDocument } from "../src/services/ingest-text.js";
import type { IngestTextDeps } from "../src/services/ingest-text.js";

// POST /api/knowledge/ingest-text is where the gap-fill loop stores what it
// found. It wrote the raw document and the in-memory index but never ChromaDB,
// and chat retrieval reads ChromaDB first, falling back to the in-memory index
// only when ChromaDB returns nothing. So on 2026-09-26 the loop stored "Novartis
// selected Werum as its global MES partner" (gap #76), and the resolution check
// 28 s later retrieved five older ChromaDB chunks and reported the gap still
// open. Anything the loop ingested stayed invisible until the next full rebuild.

function fakeDeps(overrides: Partial<IngestTextDeps> = {}): { deps: IngestTextDeps; calls: string[]; chroma: unknown[] } {
  const calls: string[] = [];
  const chroma: unknown[] = [];
  const deps: IngestTextDeps = {
    saveRawDocument: async (source) => {
      calls.push(`raw:${source}`);
    },
    assertIndexUsable: () => {
      calls.push("assertIndexUsable");
    },
    ingestText: async () => {
      calls.push("ingestText");
      return 2;
    },
    saveIndex: async () => {
      calls.push("saveIndex");
    },
    addToChromaDB: async (texts, metadatas) => {
      calls.push("addToChromaDB");
      chroma.push({ texts, metadatas });
      return 3;
    },
    ...overrides,
  };
  return { deps, calls, chroma };
}

describe("ingestTextDocument", () => {
  it("adds the text to ChromaDB, where chat retrieval looks first", async () => {
    const { deps, chroma } = fakeDeps();
    await ingestTextDocument("Werum is the global MES partner.", "n8n-gap|https://example.test/a", deps);
    expect(chroma).toEqual([
      { texts: ["Werum is the global MES partner."], metadatas: [{ source: "n8n-gap|https://example.test/a", type: "text" }] },
    ]);
  });

  it("tags the ChromaDB entry exactly as a rebuild from raw documents would", async () => {
    // reindex.ts adds raw documents with { source, ...metadata }, and the raw
    // document is saved with { type: "text" }
    const saved: Record<string, unknown>[] = [];
    const { deps, chroma } = fakeDeps({
      saveRawDocument: async (_source, _text, metadata) => {
        saved.push(metadata);
      },
    });
    await ingestTextDocument("text", "src", deps);
    const [{ metadatas }] = chroma as { metadatas: Record<string, unknown>[] }[];
    expect(metadatas[0]).toEqual({ source: "src", ...saved[0] });
  });

  it("saves the raw document first, so a rebuild includes it whatever fails next", async () => {
    const { deps, calls } = fakeDeps();
    await ingestTextDocument("text", "src", deps);
    expect(calls).toEqual(["raw:src", "assertIndexUsable", "ingestText", "saveIndex", "addToChromaDB"]);
  });

  it("reports the chunks added to each store", async () => {
    const { deps } = fakeDeps();
    expect(await ingestTextDocument("text", "src", deps)).toEqual({ added: 2, chromaAdded: 3 });
  });

  it("fails when ChromaDB rejects the text, instead of reporting a success chat cannot see", async () => {
    const { deps, calls } = fakeDeps({
      addToChromaDB: async () => {
        throw new Error("ChromaDB is not reachable");
      },
    });
    await expect(ingestTextDocument("text", "src", deps)).rejects.toThrow("ChromaDB is not reachable");
    // Still recoverable: the raw document is on disk for the next rebuild
    expect(calls[0]).toBe("raw:src");
  });

  it("indexes nothing while the index is unusable, but keeps the raw document", async () => {
    const { deps, calls, chroma } = fakeDeps({
      assertIndexUsable: () => {
        throw new Error("Search refused: reindex in progress");
      },
    });
    await expect(ingestTextDocument("text", "src", deps)).rejects.toThrow("Search refused");
    expect(calls).toEqual(["raw:src"]);
    expect(chroma).toEqual([]);
  });
});

describe("POST /api/knowledge/ingest-text", () => {
  it("goes through ingestTextDocument", () => {
    const route = readFileSync("src/api/knowledge.ts", "utf8");
    const handler = route.slice(route.indexOf('router.post("/ingest-text"'), route.indexOf('router.post("/', route.indexOf('router.post("/ingest-text"') + 1));
    expect(handler).toMatch(/ingestTextDocument\(/);
  });
});
