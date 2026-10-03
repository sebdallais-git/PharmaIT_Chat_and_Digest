// The live inputs of chunk-date.ts: git dates of knowledge files, saved raw
// documents and watchlist items. Used by the reindex (knowledge file dates),
// at startup (dates for chunks stored before dates existed) and by
// scripts/backfill-chunk-dates.ts (ChromaDB).
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createDateResolver, knowledgeFileDate, type ChunkDate } from "./chunk-date.js";
import { listKnowledgeFiles, type KnowledgeFile } from "./knowledge-store.js";
import { listRawDocuments } from "./raw-documents.js";
import { openWatchlistStore } from "./watchlist-store.js";

/** The day of the file's last commit, or null when it is untracked or git is unavailable. */
function gitDate(path: string): string | null {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%cs", "--", path], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.trim() || null;
  } catch {
    return null;
  }
}

export async function liveKnowledgeFileDate(file: KnowledgeFile): Promise<ChunkDate> {
  return knowledgeFileDate(gitDate(file.path), statSync(file.path).mtime);
}

/** source -> date, from everything a chunk can come from. Read-only. */
export async function liveDateResolver(root: string = process.cwd()): Promise<(source: string) => ChunkDate | null> {
  const knowledge: Record<string, ChunkDate> = {};
  for (const file of await listKnowledgeFiles()) knowledge[file.name] = await liveKnowledgeFileDate(file);

  const watchlist: Array<{ url: string; publishedAt: string }> = [];
  const dbPath = join(root, "data", "watchlist.db");
  // openWatchlistStore would create a missing database: only read one that exists.
  if (existsSync(dbPath)) {
    const store = openWatchlistStore(dbPath);
    try {
      for (const item of store.itemsInPeriod("0000-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z")) {
        watchlist.push({ url: item.urlCanonical, publishedAt: item.publishedAt });
      }
    } finally {
      store.close();
    }
  }

  return createDateResolver({ knowledge, raw: await listRawDocuments(), watchlist });
}
