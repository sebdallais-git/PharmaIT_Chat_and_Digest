import { describe, expect, it } from "@jest/globals";
import {
  chunkDateOf,
  createDateResolver,
  formatSourceLabel,
  knowledgeFileDate,
  rawDocumentDate,
  todayLine,
  watchlistDate,
} from "../src/services/chunk-date.js";

describe("date rules", () => {
  it("dates archive news by the day in its source name", () => {
    expect(
      rawDocumentDate({ source: "news-2025-10-16", metadata: { type: "news" }, saved_at: "2026-09-18T05:08:30Z" }),
    ).toEqual({ date: "2025-10-16", date_kind: "published" });
  });

  it("dates a fetched page by when it was saved: its own date is unknown", () => {
    expect(
      rawDocumentDate({ source: "n8n-gap|https://example.test/a", metadata: { type: "text" }, saved_at: "2026-09-20T11:00:00Z" }),
    ).toEqual({ date: "2026-09-20", date_kind: "retrieved" });
  });

  it("prefers a published date a raw document carries", () => {
    expect(
      rawDocumentDate({ source: "x", metadata: { published_at: "2026-01-02T00:00:00Z" }, saved_at: "2026-09-20T11:00:00Z" }),
    ).toEqual({ date: "2026-01-02", date_kind: "published" });
  });

  it("dates watchlist items by publication and knowledge files by their last commit, else their mtime", () => {
    expect(watchlistDate("2026-09-28T08:00:00.000Z")).toEqual({ date: "2026-09-28", date_kind: "published" });
    expect(knowledgeFileDate("2026-03-10", new Date("2026-09-01T00:00:00Z"))).toEqual({ date: "2026-03-10", date_kind: "document" });
    expect(knowledgeFileDate(null, new Date("2026-09-01T10:00:00Z"))).toEqual({ date: "2026-09-01", date_kind: "document" });
  });
});

describe("chunkDateOf", () => {
  it("reads a stamped date first, then a published date, then a news source name", () => {
    expect(chunkDateOf({ date: "2026-01-01", date_kind: "document", published_at: "2025-01-01" })).toEqual({
      date: "2026-01-01",
      date_kind: "document",
    });
    expect(chunkDateOf({ published_at: "2026-09-28T08:00:00Z" })).toEqual({ date: "2026-09-28", date_kind: "published" });
    expect(chunkDateOf({ source: "news-2026-01-17" })).toEqual({ date: "2026-01-17", date_kind: "published" });
    expect(chunkDateOf({ source: "pharma-basics.md" })).toBeNull();
  });

  it("ignores a stamped date that is not a calendar date", () => {
    expect(chunkDateOf({ date: "soon", date_kind: "document" })).toBeNull();
  });
});

describe("createDateResolver", () => {
  const resolve = createDateResolver({
    knowledge: { "pharma-basics.md": { date: "2026-03-10", date_kind: "document" } },
    raw: [{ source: "n8n-gap|https://example.test/a", metadata: { type: "text" }, saved_at: "2026-09-20T11:00:00Z" }],
    watchlist: [{ url: "https://news.test/dell", publishedAt: "2026-09-28T08:00:00Z" }],
  });

  it("resolves each kind of source, and archive news by name alone", () => {
    expect(resolve("pharma-basics.md")).toEqual({ date: "2026-03-10", date_kind: "document" });
    expect(resolve("n8n-gap|https://example.test/a")).toEqual({ date: "2026-09-20", date_kind: "retrieved" });
    expect(resolve("https://news.test/dell")).toEqual({ date: "2026-09-28", date_kind: "published" });
    expect(resolve("news-2025-10-16")).toEqual({ date: "2025-10-16", date_kind: "published" });
    expect(resolve("unknown-source")).toBeNull();
  });
});

describe("what the model sees", () => {
  it("labels a chunk with its date and how that date is known", () => {
    expect(formatSourceLabel("news-2026-01-17", { date: "2026-01-17", date_kind: "published" })).toBe(
      "[Source: news-2026-01-17 | 2026-01-17, published]",
    );
    expect(formatSourceLabel("pharma-basics.md", null)).toBe("[Source: pharma-basics.md | date unknown]");
  });

  it("tells the model today's date and how to use it", () => {
    const line = todayLine(new Date("2026-10-03T09:00:00Z"));
    expect(line).toContain("Today is 2026-10-03.");
    expect(line).toContain("Q2");
  });
});
