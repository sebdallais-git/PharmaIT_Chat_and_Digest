// The live services behind competitive_position, shared by the graph route and
// the chat. Nothing connects at import time: each call binds them lazily.
import { join } from "node:path";
import type { CompetitiveDeps } from "./competitive-graph.js";
import { normaliseName } from "./competitive-position.js";
import { liveReader } from "./export-wiring.js";
import { loadBriefExcerpts } from "./vendor-brief-excerpts.js";
import { loadWatchlist } from "./watchlist-config.js";

/** Normalised alias and name -> entity id, from config/watchlist.yaml (e.g. "pure-storage" -> "everpure"). */
function watchlistAliases(): Record<string, string> {
  try {
    const aliases: Record<string, string> = {};
    for (const entity of loadWatchlist().entities.values()) {
      for (const name of [entity.name, ...entity.aliases]) aliases[normaliseName(name)] = entity.id;
    }
    return aliases;
  } catch (err) {
    // An invalid watchlist must not take the query down: ids still resolve without aliases.
    console.error("[Graph] watchlist aliases unavailable:", err instanceof Error ? err.message : "Unknown error");
    return {};
  }
}

export function liveCompetitiveDeps(): CompetitiveDeps {
  const reader = liveReader();
  return {
    runCypher: (query, params) => reader.runCypher(query, params),
    briefs: () => loadBriefExcerpts(join(process.cwd(), "knowledge", "vendors")),
    vendorAliases: watchlistAliases,
  };
}
