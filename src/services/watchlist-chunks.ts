// Rebuilds the embedded form of a stored watchlist item. The text and metadata
// here must match what watchlist-ingest.ts embeds at collection time, or a
// rebuilt chunk would not be the chunk it replaces.
import { watchlistDate } from "./chunk-date.js";
import { openWatchlistStore, type StoredItem } from "./watchlist-store.js";
import type { WatchlistChunk } from "./reindex.js";

export function toWatchlistChunk(item: StoredItem): WatchlistChunk {
  return {
    text: [item.title, item.summary, item.body].filter((part) => part.length > 0).join("\n\n"),
    metadata: {
      source: item.urlCanonical,
      title: item.title,
      entity: item.entities.join(","),
      domain: item.domains.join(","),
      signal: item.signal ?? "",
      published_at: item.publishedAt,
      ...watchlistDate(item.publishedAt),
      source_kind: item.sourceKind,
      importance: item.importance ?? 0,
      watchlist_item_id: item.id,
    },
  };
}

/** Every stored watchlist item, in the form a rebuild should re-embed. */
export function listWatchlistChunks(path?: string): WatchlistChunk[] {
  const store = openWatchlistStore(path);
  try {
    // Deliberately unbounded: a rebuild restores the whole store, not a window.
    return store.itemsInPeriod("0000-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z").map(toWatchlistChunk);
  } finally {
    store.close();
  }
}
