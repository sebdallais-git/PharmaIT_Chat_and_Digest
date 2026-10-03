import { describe, expect, it } from "@jest/globals";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeEmbedding,
  encodeEmbedding,
  getIndexMeta,
  loadIndex,
  fillChunkDates,
  parseIndexFile,
  serializeIndex,
} from "../src/services/knowledge-store.js";

const meta = { stack: "ollama", embeddingModel: "qwen3-embedding:0.6b-q8_0", dim: 3 };

describe("embedding encoding", () => {
  it("round-trips vectors through base64 Float32", () => {
    const decoded = decodeEmbedding(encodeEmbedding([0.25, -1.5, 3.125]));
    expect(Array.from(decoded)).toEqual([0.25, -1.5, 3.125]);
  });

  it("decodes small vectors whose Buffer comes from Node's shared pool", () => {
    // Small Buffers share a pool and can start at an offset that isn't a multiple of 4
    const decoded = decodeEmbedding(encodeEmbedding([0.1, 0.2, 0.3]));
    expect(decoded[0]).toBeCloseTo(0.1, 6);
    expect(decoded[2]).toBeCloseTo(0.3, 6);
  });
});

describe("index file format", () => {
  const chunk = { id: "a-0", source: "a.md", content: "hello", embedding: Float32Array.from([1, 0, 0]) };

  it("round-trips metadata and chunks", () => {
    const json = serializeIndex(meta, [chunk]);
    const parsed = parseIndexFile(JSON.parse(json) as unknown);
    expect(parsed.meta).toEqual(meta);
    expect(parsed.complete).toBe(false);
    expect(parsed.chunks).toHaveLength(1);
    expect(parsed.chunks[0]).toMatchObject({ id: "a-0", source: "a.md", content: "hello" });
    expect(Array.from(parsed.chunks[0].embedding)).toEqual([1, 0, 0]);
  });

  it("writes the completeness marker only for a finished rebuild", () => {
    expect(JSON.parse(serializeIndex(meta, [chunk]))).not.toHaveProperty("complete");
    const json = serializeIndex(meta, [chunk], true);
    expect(JSON.parse(json)).toMatchObject({ version: 2, complete: true });
    expect(parseIndexFile(JSON.parse(json) as unknown).complete).toBe(true);
  });

  it("treats a legacy array index as having no metadata and no usable chunks", () => {
    const parsed = parseIndexFile([{ id: "x", source: "x", content: "x", embedding: [1, 2] }]);
    expect(parsed).toEqual({ meta: null, complete: false, chunks: [] });
  });
});

describe("loadIndex", () => {
  it("starts with no metadata when the index file is missing, so the startup guard refuses search", async () => {
    const log = console.log;
    console.log = () => {};
    try {
      await loadIndex(join(tmpdir(), "pharmaitchat-missing-index", ".index-missing.json"));
    } finally {
      console.log = log;
    }
    expect(getIndexMeta()).toBeNull();
  });
});

describe("chunk dates in the in-memory index", () => {
  const meta = { stack: "mlx", embeddingModel: "m", dimension: 3 } as unknown as Parameters<typeof serializeIndex>[0];
  const chunk = (source: string, date?: { date: string; date_kind: "published" | "retrieved" | "document" }) => ({
    id: `${source}-0`,
    source,
    content: "text",
    embedding: Float32Array.from([1, 2, 3]),
    ...(date !== undefined ? { date } : {}),
  });

  it("keeps a chunk's date through save and load", () => {
    const dated = chunk("news-2026-01-17", { date: "2026-01-17", date_kind: "published" });
    const parsed = parseIndexFile(JSON.parse(serializeIndex(meta, [dated, chunk("undated.md")])) as unknown);
    expect(parsed.chunks.map((c) => c.date)).toEqual([{ date: "2026-01-17", date_kind: "published" }, undefined]);
  });

  it("fills dates the resolver knows, leaves stamped and unknown ones alone, and counts what it filled", () => {
    const items = [
      chunk("news-2026-01-17"),
      chunk("pharma-basics.md", { date: "2026-03-10", date_kind: "document" }),
      chunk("mystery"),
    ];
    const filled = fillChunkDates(items, (source) =>
      source.startsWith("news-") ? { date: source.slice(5), date_kind: "published" } : source === "pharma-basics.md" ? { date: "2099-01-01", date_kind: "document" } : null,
    );
    expect(filled).toBe(1);
    expect(items.map((c) => c.date)).toEqual([
      { date: "2026-01-17", date_kind: "published" },
      { date: "2026-03-10", date_kind: "document" },
      undefined,
    ]);
  });
});
