import { describe, expect, it } from "@jest/globals";
import { removeSource } from "../src/services/remove-source.js";
import type { RemoveSourceDeps } from "../src/services/remove-source.js";
import { chromaSourceFilter } from "../src/services/chromadb-store.js";
import { parseIndexFile, serializeIndex } from "../src/services/knowledge-store.js";

// A source can reach three stores: ChromaDB, the in-memory index file and
// data/raw_documents/ (which a rebuild reads from). Removing it from fewer than
// all three brings it back: ChromaDB answers chat, the index answers when
// ChromaDB misses, and a rebuild re-adds whatever a raw document still holds.
// Needed on 2026-09-27, when the gap loop stored a "not relevant" explanation.

const JUNK = "n8n-gap|https://finance.yahoo.com/news/novartis-nvs-spins-off-sandoz-154700044.html";
const meta = { stack: "mlx", embeddingModel: "m", dim: 2 };

function indexWith(sources: string[], complete = true): string {
  return serializeIndex(
    meta,
    sources.map((source, i) => ({ id: `c${i}`, source, content: `text ${i}`, embedding: Float32Array.from([i, 1]) })),
    complete,
  );
}

function fakeDeps(index: string | null, opts: { raw?: boolean; chroma?: number } = {}) {
  const state = { index, raw: opts.raw ?? true, chroma: opts.chroma ?? 1, writes: 0 };
  const deps: RemoveSourceDeps = {
    readIndex: async () => state.index,
    writeIndex: async (text) => {
      state.index = text;
      state.writes++;
    },
    rawDocumentExists: async () => state.raw,
    deleteRawDocument: async () => {
      state.raw = false;
    },
    countChroma: async () => state.chroma,
    deleteChroma: async () => {
      state.chroma = 0;
    },
  };
  return { deps, state };
}

describe("removeSource", () => {
  it("reports what it would remove and changes nothing without apply", async () => {
    const { deps, state } = fakeDeps(indexWith(["keep", JUNK]));
    const report = await removeSource(JUNK, false, deps);
    expect(report).toEqual({ source: JUNK, indexChunks: 1, rawDocument: true, chromaChunks: 1, applied: false });
    expect(state).toMatchObject({ raw: true, chroma: 1, writes: 0 });
  });

  it("removes the source from all three stores with apply", async () => {
    const { deps, state } = fakeDeps(indexWith(["keep", JUNK, JUNK]), { chroma: 1 });
    const report = await removeSource(JUNK, true, deps);
    expect(report).toEqual({ source: JUNK, indexChunks: 2, rawDocument: true, chromaChunks: 1, applied: true });
    expect(state.raw).toBe(false);
    expect(state.chroma).toBe(0);
    expect(parseIndexFile(JSON.parse(state.index ?? "")).chunks.map((c) => c.source)).toEqual(["keep"]);
  });

  it("keeps every other chunk, the index metadata and its completeness marker intact", async () => {
    const original = indexWith(["a", JUNK, "b"]);
    const { deps, state } = fakeDeps(original);
    await removeSource(JUNK, true, deps);
    const before = parseIndexFile(JSON.parse(original));
    const after = parseIndexFile(JSON.parse(state.index ?? ""));
    expect(after.meta).toEqual(before.meta);
    expect(after.complete).toBe(true);
    expect(after.chunks).toEqual(before.chunks.filter((c) => c.source !== JUNK));
  });

  it("does not rewrite the index when the source is not in it", async () => {
    const { deps, state } = fakeDeps(indexWith(["a"]), { raw: false, chroma: 0 });
    const report = await removeSource(JUNK, true, deps);
    expect(report).toMatchObject({ indexChunks: 0, rawDocument: false, chromaChunks: 0 });
    expect(state.writes).toBe(0);
  });

  it("refuses an empty source rather than matching everything", async () => {
    const { deps } = fakeDeps(indexWith(["a"]));
    await expect(removeSource("  ", true, deps)).rejects.toThrow(/source/);
  });
});

describe("chromaSourceFilter", () => {
  it("matches exactly one source", () => {
    expect(chromaSourceFilter(JUNK)).toEqual({ where: { source: JUNK } });
  });
});
