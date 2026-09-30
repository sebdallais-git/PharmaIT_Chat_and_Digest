// Runs the digest agent against the live stores and the active stack. Shared
// by the web chat, POST /api/digest (Hermes' make_digest tool) and the Monday
// job (scripts/digest.ts, which calls the API).

import { getLlmClient } from "./llm-client.js";
import { loadWatchlist } from "./watchlist-config.js";
import { openWatchlistStore } from "./watchlist-store.js";
import { activeRole, openRoleStore } from "./role-store.js";
import { parseDigestRequest } from "./digest-request.js";
import { buildDigest, type CompleteFn, type DigestResult } from "./digest-builder.js";

// A feed is named in the footer once it has failed this many nights running
const FAILING_FEED_THRESHOLD = 3;

// Room for the rendered digest in one Telegram message (4096) after Hermes' own framing
export const TELEGRAM_DIGEST_BUDGET = 3900;
// The web chat has no limit worth enforcing; this only guards against a runaway
export const CHAT_DIGEST_BUDGET = 20_000;

const liveComplete: CompleteFn = (prompt, maxTokens) =>
  getLlmClient().chat([{ role: "user", content: prompt }], { temperature: 0.3, maxTokens });

export async function runDigest(requestText: string, budget: number, now: Date = new Date()): Promise<DigestResult> {
  const watchlist = loadWatchlist();
  const store = openWatchlistStore();
  try {
    return await buildDigest(parseDigestRequest(requestText, now, watchlist.entities.values()), {
      itemsInPeriod: (from, to) => store.itemsInPeriod(from, to),
      failingFeeds: () => store.failingFeeds(FAILING_FEED_THRESHOLD),
      watchlist,
      role: activeRole(openRoleStore().read()),
      complete: liveComplete,
      now: () => now,
    }, budget);
  } finally {
    store.close();
  }
}
