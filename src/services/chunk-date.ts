// Every chunk the chat can retrieve carries a date, and says how that date is
// known: "Q2 earnings" means nothing without the year, and an answer can only
// relate a fact to the past if it knows when the fact was true.
//
//   published  the source's own publication date (news, watchlist items)
//   retrieved  when the page was fetched; its own date is unknown (gap loop, URLs)
//   document   when the knowledge file was last changed (git commit, else mtime)
//
// Pure: callers supply git dates, raw documents and watchlist items.
export type DateKind = "published" | "retrieved" | "document";

export interface ChunkDate {
  date: string;
  date_kind: DateKind;
}

export interface DatedRawDocument {
  source: string;
  metadata: Record<string, unknown>;
  saved_at: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}/;
const NEWS_SOURCE = /^news-(\d{4}-\d{2}-\d{2})$/;
const KINDS: readonly DateKind[] = ["published", "retrieved", "document"];

function day(value: unknown): string | null {
  return typeof value === "string" && DAY.test(value) ? value.slice(0, 10) : null;
}

/** The archive's Google News sources are named by their day: news-2025-10-16. */
export function newsSourceDate(source: string): string | null {
  return NEWS_SOURCE.exec(source)?.[1] ?? null;
}

export function rawDocumentDate(doc: DatedRawDocument): ChunkDate {
  const fromName = newsSourceDate(doc.source);
  if (fromName !== null) return { date: fromName, date_kind: "published" };
  const published = day(doc.metadata.published_at);
  if (published !== null) return { date: published, date_kind: "published" };
  return { date: doc.saved_at.slice(0, 10), date_kind: "retrieved" };
}

export function watchlistDate(publishedAt: string): ChunkDate {
  return { date: publishedAt.slice(0, 10), date_kind: "published" };
}

/** gitDate: the file's last commit day (YYYY-MM-DD), or null when untracked. */
export function knowledgeFileDate(gitDate: string | null, mtime: Date): ChunkDate {
  return { date: day(gitDate) ?? mtime.toISOString().slice(0, 10), date_kind: "document" };
}

/** The date a stored chunk's metadata already carries, if any. */
export function chunkDateOf(metadata: Record<string, unknown>): ChunkDate | null {
  const stamped = day(metadata.date);
  if (stamped !== null && KINDS.includes(metadata.date_kind as DateKind)) {
    return { date: stamped, date_kind: metadata.date_kind as DateKind };
  }
  const published = day(metadata.published_at);
  if (published !== null) return { date: published, date_kind: "published" };
  const fromName = typeof metadata.source === "string" ? newsSourceDate(metadata.source) : null;
  return fromName !== null ? { date: fromName, date_kind: "published" } : null;
}

export interface DateSources {
  /** Knowledge file name -> its date. */
  knowledge: Record<string, ChunkDate>;
  raw: DatedRawDocument[];
  watchlist: Array<{ url: string; publishedAt: string }>;
}

/** source -> date, for chunks stored before dates were stamped (index load, ChromaDB backfill). */
export function createDateResolver(sources: DateSources): (source: string) => ChunkDate | null {
  const bySource = new Map<string, ChunkDate>(Object.entries(sources.knowledge));
  for (const doc of sources.raw) bySource.set(doc.source, rawDocumentDate(doc));
  for (const item of sources.watchlist) bySource.set(item.url, watchlistDate(item.publishedAt));
  return (source) => {
    const known = bySource.get(source);
    if (known !== undefined) return known;
    const fromName = newsSourceDate(source);
    return fromName !== null ? { date: fromName, date_kind: "published" } : null;
  };
}

/** How a retrieved chunk is introduced in the prompt. */
export function formatSourceLabel(source: string, date: ChunkDate | null): string {
  return `[Source: ${source} | ${date !== null ? `${date.date}, ${date.date_kind}` : "date unknown"}]`;
}

/** The first line of the system prompt: what "now" is, and how to use it. */
export function todayLine(now: Date): string {
  return (
    `Today is ${now.toISOString().slice(0, 10)}. Every source below carries a date: anchor relative periods ` +
    `(Q2, "last year", "recently") to the actual year, compare dated facts with each other and with today, and ` +
    "say when a fact may be outdated."
  );
}
