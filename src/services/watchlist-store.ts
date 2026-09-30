// Watchlist item store.
//
// Persists ingested watchlist items (news/filings/etc.) with the entities and
// domains tagged onto them, tracks per-feed fetch state for the ingest loop,
// and records per-run stats. Follows the same better-sqlite3 pattern as
// src/services/feedback-store.ts: WAL journal mode, CREATE TABLE IF NOT
// EXISTS, prepared statements.
//
// R1: an item may legitimately have zero domains (general pharma news with
// no IT angle) and zero entities (unassigned). Both empty sets are valid and
// stored as empty. What must never be stored is an *unknown* domain or
// signal -- those are validated against the closed vocabularies imported
// from watchlist-config.ts at the storage boundary, in insertItem, before
// any row is written.

import Database from "better-sqlite3";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { DOMAINS, SIGNALS, type Domain, type Signal } from "./watchlist-config.js";

const DOMAIN_SET: ReadonlySet<string> = new Set(DOMAINS);
const SIGNAL_SET: ReadonlySet<string> = new Set(SIGNALS);

function isKnownDomain(value: string): value is Domain {
  return DOMAIN_SET.has(value);
}

function isKnownSignal(value: string): value is Signal {
  return SIGNAL_SET.has(value);
}

export interface StoredItem {
  id: number;
  urlCanonical: string;
  contentHash: string;
  // R13/R15: the cross-source dedupe key (watchlist-sources.ts's titleKey).
  // Empty for a row stored without one; an empty key never matches.
  titleKey: string;
  sourceKind: string;
  sourceName: string;
  title: string;
  summary: string;
  signal: Signal | null;
  importance: number | null;
  facts: Record<string, unknown> | null;
  publishedAt: string;
  fetchedAt: string;
  // The fetched article text. "" when the fetch yielded nothing, or for rows
  // stored before the body was persisted (schema v3).
  body: string;
  entities: string[];
  domains: Domain[];
  urls: string[];
  flagged: boolean;
}

export interface NewItem {
  urlCanonical: string;
  contentHash: string;
  // Optional so callers that have no key (or predate R13) keep working; it is
  // stored as "" and findByTitleKey never matches an empty key.
  titleKey?: string;
  sourceKind: string;
  sourceName: string;
  title: string;
  summary: string;
  signal: Signal | null;
  importance: number | null;
  facts?: Record<string, unknown> | null;
  publishedAt: string;
  fetchedAt: string;
  // Optional so callers that fetched no body keep working; stored as "".
  body?: string;
  entities: string[];
  domains: Domain[];
  flagged?: boolean;
}

export interface FeedState {
  feedId: string;
  lastSeenAt: string | null;
  lastItemHash: string | null;
  consecutiveFailures: number;
}

export interface RunRecord {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  fetched: number;
  deduped: number;
  tagged: number;
  failedFeeds: number;
  // Cap pressure and anomalies are persisted, not just logged: a starved feed
  // is recorded as a SUCCESS with its failure streak cleared, so the run row
  // is the only place "the vendors have been starved for six nights" can be
  // told apart from "the vendors were quiet".
  skippedByCap: number;
  // Items the run fetched but had no time left to tag (C1's wall-clock
  // budget). Kept apart from skippedByCap: "the model is too slow for this
  // feed list" and "the cap is too small" call for different answers.
  skippedByBudget: number;
  anomalies: number;
}

export interface WatchlistStore {
  // Idempotent on a duplicate content_hash or url_canonical (R5): the row is
  // not re-inserted or updated -- no summary/tag overwrite, no extra join
  // rows -- and the id of the EXISTING item is returned unchanged. Callers
  // (e.g. an ingest orchestrator re-processing a feed) can call this
  // unconditionally without a separate check-then-insert race, and can pass
  // the returned id to addSource to record a new sighting's URL.
  insertItem(item: NewItem): number; // returns the (possibly pre-existing) item id
  findByHash(contentHash: string): StoredItem | null;
  findByUrl(urlCanonical: string): StoredItem | null;
  addSource(itemId: number, sourceKind: string, url: string): void;
  // R13/R15: the third and last cross-source dedupe step. Returns the oldest
  // item with this exact title_key, published within [fromIso, toIso] and
  // stored under a source kind OTHER than excludeSourceKind -- titleKey strips
  // a trailing dash clause, so two different releases from one company can
  // share a key and a same-source-kind match would wrongly collapse them.
  // An empty titleKey never matches.
  findByTitleKey(titleKey: string, fromIso: string, toIso: string, excludeSourceKind: string): StoredItem | null;
  itemsInPeriod(from: string, to: string, options?: { entities?: string[]; domains?: Domain[] }): StoredItem[];
  countsByEntity(from: string, to: string): Array<{ entityId: string; items: number; maxImportance: number }>;
  getFeedState(feedId: string): FeedState;
  // Feeds failing right now, worst first: the digest footer names them
  failingFeeds(minFailures: number): Array<{ feedId: string; failures: number }>;
  // lastSeenAt/lastItemHash are nullable: a feed that fetched cleanly but
  // resolved nothing it is allowed to move past (an empty feed, or one whose
  // whole first batch was dropped by an ingest cap) has no watermark to
  // record. Passing null clears the failure streak while leaving the
  // watermark alone (the SQL COALESCEs a null argument onto the existing
  // column rather than overwriting it), so the next run still backfills
  // that feed -- stamping a made-up watermark would push its unseen backlog
  // behind an exclusive `since` permanently.
  recordFeedSuccess(feedId: string, lastSeenAt: string | null, lastItemHash: string | null): void;
  recordFeedFailure(feedId: string): number; // returns consecutiveFailures after increment
  startRun(startedAt: string): number;
  finishRun(
    runId: number,
    finishedAt: string,
    stats: {
      fetched: number;
      deduped: number;
      tagged: number;
      failedFeeds: number;
      skippedByCap: number;
      skippedByBudget: number;
      anomalies: number;
    },
  ): void;
  lastRun(): RunRecord | null;
  close(): void;
}

// Raw row shapes as better-sqlite3 hands them back (snake_case columns).
interface ItemRow {
  id: number;
  url_canonical: string;
  content_hash: string;
  title_key: string;
  source_kind: string;
  source_name: string;
  title: string;
  summary: string;
  signal: string | null;
  importance: number | null;
  facts: string | null;
  published_at: string;
  fetched_at: string;
  flagged: number;
  // Absent on rows read from a pre-v3 database mid-migration; mapped to "".
  body: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function openWatchlistStore(path: string = join(process.cwd(), "data", "watchlist.db")): WatchlistStore {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  // SQLite disables foreign key enforcement per connection by default; the
  // join tables' ON DELETE CASCADE (R6) is a no-op unless this is set here.
  db.pragma("foreign_keys = ON");

  // Task 8 fix (b): the `runs` table and `items.title_key` column were added
  // straight into CREATE TABLE IF NOT EXISTS with no migration path -- fine
  // for a brand-new database, but a pre-existing data/watchlist.db (from
  // before Task 7) already has an `items` table without title_key, and
  // CREATE INDEX IF NOT EXISTS on that column below would throw immediately.
  // PRAGMA user_version tracks which schema a database is on (0 for any
  // database this module has never stamped, current or legacy alike) so a
  // one-time ALTER can backfill what's missing BEFORE the schema below runs,
  // and Phase 2 can add its own columns the same way behind `< 2`, `< 3`, etc.
  const schemaVersion = db.pragma("user_version", { simple: true }) as number;
  if (schemaVersion < 1) {
    const hasItemsTable =
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'items'`).get() !== undefined;
    if (hasItemsTable) {
      const itemsColumns = (db.prepare(`PRAGMA table_info(items)`).all() as Array<{ name: string }>).map(
        (column) => column.name,
      );
      if (!itemsColumns.includes("title_key")) {
        db.exec(`ALTER TABLE items ADD COLUMN title_key TEXT NOT NULL DEFAULT ''`);
      }
    }
    // A wholly missing table (e.g. `runs`, on a database old enough to
    // predate it) needs no ALTER: CREATE TABLE IF NOT EXISTS below creates
    // it fresh, with title_key-dependent objects now safe to create too.
    db.pragma("user_version = 1");
  }
  if (schemaVersion < 2) {
    // The nightly run's wall-clock budget (C1) defers items it had no time
    // to tag. That pressure has to be tellable from cap pressure tomorrow,
    // not only in tonight's stdout, so it gets its own column rather than
    // being folded into skipped_by_cap.
    const hasRunsTable =
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runs'`).get() !== undefined;
    if (hasRunsTable) {
      const runsColumns = (db.prepare(`PRAGMA table_info(runs)`).all() as Array<{ name: string }>).map(
        (column) => column.name,
      );
      if (!runsColumns.includes("skipped_by_budget")) {
        db.exec(`ALTER TABLE runs ADD COLUMN skipped_by_budget INTEGER`);
      }
    }
    db.pragma("user_version = 2");
  }
  if (schemaVersion < 3) {
    // The fetched body used to be embedded into ChromaDB and then dropped, so a
    // reindex -- which rebuilds the collection from knowledge/ and
    // raw_documents/ only -- destroyed every watchlist chunk with nothing on
    // disk to rebuild it from. Keeping the body makes the index reproducible.
    const hasItemsTable =
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'items'`).get() !== undefined;
    if (hasItemsTable) {
      const itemsColumns = (db.prepare(`PRAGMA table_info(items)`).all() as Array<{ name: string }>).map(
        (column) => column.name,
      );
      if (!itemsColumns.includes("body")) {
        db.exec(`ALTER TABLE items ADD COLUMN body TEXT NOT NULL DEFAULT ''`);
      }
    }
    db.pragma("user_version = 3");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url_canonical TEXT NOT NULL UNIQUE,
      content_hash TEXT NOT NULL UNIQUE,
      title_key TEXT NOT NULL DEFAULT '',
      source_kind TEXT NOT NULL,
      source_name TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      signal TEXT,
      importance INTEGER,
      facts TEXT,
      published_at TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      flagged INTEGER NOT NULL DEFAULT 0,
      body TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_items_published_at ON items(published_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_items_content_hash ON items(content_hash);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_items_url_canonical ON items(url_canonical);
    CREATE INDEX IF NOT EXISTS idx_items_title_key ON items(title_key);

    CREATE TABLE IF NOT EXISTS item_entities (
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      entity_id TEXT NOT NULL,
      PRIMARY KEY (item_id, entity_id)
    );

    CREATE INDEX IF NOT EXISTS idx_item_entities_entity_id ON item_entities(entity_id);

    CREATE TABLE IF NOT EXISTS item_domains (
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      domain TEXT NOT NULL,
      PRIMARY KEY (item_id, domain)
    );

    CREATE TABLE IF NOT EXISTS item_sources (
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      source_kind TEXT NOT NULL,
      url TEXT NOT NULL,
      PRIMARY KEY (item_id, url)
    );

    CREATE TABLE IF NOT EXISTS feed_state (
      feed_id TEXT PRIMARY KEY,
      last_seen_at TEXT,
      last_item_hash TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      fetched INTEGER,
      deduped INTEGER,
      tagged INTEGER,
      failed_feeds INTEGER,
      skipped_by_cap INTEGER,
      skipped_by_budget INTEGER,
      anomalies INTEGER
    );
  `);

  // ---- prepared statements -------------------------------------------------

  // ON CONFLICT DO NOTHING with no column list applies to any constraint
  // violation (both the content_hash and url_canonical UNIQUE constraints),
  // making the insert idempotent (R5) -- see insertItemTxn below for how a
  // no-op insert is resolved back to the existing row's id.
  const insertItemStmt = db.prepare(`
    INSERT INTO items (url_canonical, content_hash, title_key, source_kind, source_name, title, summary, signal, importance, facts, published_at, fetched_at, flagged, body)
    VALUES (@urlCanonical, @contentHash, @titleKey, @sourceKind, @sourceName, @title, @summary, @signal, @importance, @facts, @publishedAt, @fetchedAt, @flagged, @body)
    ON CONFLICT DO NOTHING
  `);
  const insertEntityStmt = db.prepare(`INSERT OR IGNORE INTO item_entities (item_id, entity_id) VALUES (?, ?)`);
  const insertDomainStmt = db.prepare(`INSERT OR IGNORE INTO item_domains (item_id, domain) VALUES (?, ?)`);
  const insertSourceStmt = db.prepare(`INSERT OR IGNORE INTO item_sources (item_id, source_kind, url) VALUES (?, ?, ?)`);

  const selectItemByHashStmt = db.prepare(`SELECT * FROM items WHERE content_hash = ?`);
  const selectItemByUrlStmt = db.prepare(`SELECT * FROM items WHERE url_canonical = ?`);
  const selectItemByTitleKeyStmt = db.prepare(`
    SELECT * FROM items
    WHERE title_key = ? AND title_key <> ''
      AND published_at >= ? AND published_at <= ?
      AND source_kind <> ?
    ORDER BY id ASC
    LIMIT 1
  `);
  const selectEntitiesStmt = db.prepare(`SELECT entity_id FROM item_entities WHERE item_id = ?`);
  const selectDomainsStmt = db.prepare(`SELECT domain FROM item_domains WHERE item_id = ?`);
  const selectUrlsStmt = db.prepare(`
    SELECT url FROM item_sources WHERE item_id = ?
    UNION
    SELECT url_canonical AS url FROM items WHERE id = ?
  `);

  const selectItemsInPeriodStmt = db.prepare(`
    SELECT * FROM items WHERE published_at >= ? AND published_at <= ? ORDER BY published_at DESC, id ASC
  `);

  const getFeedStateStmt = db.prepare(`SELECT * FROM feed_state WHERE feed_id = ?`);
  const failingFeedsStmt = db.prepare(
    `SELECT feed_id, consecutive_failures FROM feed_state WHERE consecutive_failures >= ? ORDER BY consecutive_failures DESC, feed_id ASC`,
  );
  const insertFeedStateStmt = db.prepare(`INSERT OR IGNORE INTO feed_state (feed_id, last_seen_at, last_item_hash, consecutive_failures) VALUES (?, NULL, NULL, 0)`);
  // COALESCE(?, last_seen_at/last_item_hash): a null argument leaves the
  // existing column untouched instead of overwriting it with NULL (Task 8
  // fix (a) -- the doc comment on recordFeedSuccess promised this, but the
  // plain UPDATE used to write NULL over a real watermark whenever a caller
  // passed null).
  const recordFeedSuccessStmt = db.prepare(`
    UPDATE feed_state
    SET last_seen_at = COALESCE(?, last_seen_at), last_item_hash = COALESCE(?, last_item_hash), consecutive_failures = 0
    WHERE feed_id = ?
  `);
  const incrementFeedFailureStmt = db.prepare(`
    UPDATE feed_state SET consecutive_failures = consecutive_failures + 1 WHERE feed_id = ?
  `);

  const startRunStmt = db.prepare(`INSERT INTO runs (started_at) VALUES (?)`);
  const finishRunStmt = db.prepare(`
    UPDATE runs
    SET finished_at = ?, fetched = ?, deduped = ?, tagged = ?, failed_feeds = ?, skipped_by_cap = ?,
        skipped_by_budget = ?, anomalies = ?
    WHERE id = ?
  `);
  const lastRunStmt = db.prepare(`SELECT * FROM runs ORDER BY id DESC LIMIT 1`);

  const countsByEntityStmt = db.prepare(`
    SELECT ie.entity_id AS entityId, COUNT(*) AS items, MAX(COALESCE(i.importance, 0)) AS maxImportance
    FROM item_entities ie
    JOIN items i ON i.id = ie.item_id
    WHERE i.published_at >= ? AND i.published_at <= ?
    GROUP BY ie.entity_id
  `);

  // ---- row -> domain object mapping ----------------------------------------

  function hydrateItem(row: ItemRow): StoredItem {
    const entities = (selectEntitiesStmt.all(row.id) as Array<{ entity_id: string }>).map((r) => r.entity_id);
    const domains = (selectDomainsStmt.all(row.id) as Array<{ domain: string }>).map((r) => r.domain as Domain);
    const urls = (selectUrlsStmt.all(row.id, row.id) as Array<{ url: string }>).map((r) => r.url);

    let facts: Record<string, unknown> | null = null;
    if (row.facts !== null) {
      const parsed: unknown = JSON.parse(row.facts);
      facts = isRecord(parsed) ? parsed : null;
    }

    return {
      id: row.id,
      urlCanonical: row.url_canonical,
      contentHash: row.content_hash,
      titleKey: row.title_key,
      sourceKind: row.source_kind,
      sourceName: row.source_name,
      title: row.title,
      summary: row.summary,
      signal: row.signal !== null && isKnownSignal(row.signal) ? row.signal : null,
      importance: row.importance,
      facts,
      publishedAt: row.published_at,
      fetchedAt: row.fetched_at,
      body: row.body ?? "",
      entities,
      domains,
      urls,
      flagged: row.flagged === 1,
    };
  }

  // ---- validation -----------------------------------------------------------

  function assertKnownDomains(domains: Domain[]): void {
    for (const domain of domains) {
      if (!isKnownDomain(domain)) {
        throw new Error(`unknown domain "${domain}"`);
      }
    }
  }

  function assertKnownSignal(signal: Signal | null): void {
    if (signal !== null && !isKnownSignal(signal)) {
      throw new Error(`unknown signal "${signal}"`);
    }
  }

  // ---- public API -------------------------------------------------------

  const insertItemTxn = db.transaction((item: NewItem): number => {
    assertKnownDomains(item.domains);
    assertKnownSignal(item.signal);

    const result = insertItemStmt.run({
      urlCanonical: item.urlCanonical,
      contentHash: item.contentHash,
      titleKey: item.titleKey ?? "",
      sourceKind: item.sourceKind,
      sourceName: item.sourceName,
      title: item.title,
      summary: item.summary,
      signal: item.signal,
      importance: item.importance,
      facts: item.facts !== undefined && item.facts !== null ? JSON.stringify(item.facts) : null,
      publishedAt: item.publishedAt,
      fetchedAt: item.fetchedAt,
      flagged: item.flagged ?? false ? 1 : 0,
      body: item.body ?? "",
    });

    if (result.changes === 0) {
      // ON CONFLICT DO NOTHING fired: a row with this content_hash or
      // url_canonical already exists. Idempotent no-op (R5) -- resolve and
      // return the existing row's id without touching any data or join rows.
      const existing =
        (selectItemByHashStmt.get(item.contentHash) as ItemRow | undefined) ??
        (selectItemByUrlStmt.get(item.urlCanonical) as ItemRow | undefined);
      if (existing === undefined) {
        // Should be unreachable: a conflict happened but neither lookup
        // finds the row that caused it.
        throw new Error(
          `insertItem: conflict on content_hash "${item.contentHash}" or url_canonical "${item.urlCanonical}" but no existing row was found`
        );
      }
      return existing.id;
    }

    const itemId = Number(result.lastInsertRowid);

    for (const entityId of item.entities) {
      insertEntityStmt.run(itemId, entityId);
    }
    for (const domain of item.domains) {
      insertDomainStmt.run(itemId, domain);
    }
    // The canonical URL is itself a source (its ingest origin).
    insertSourceStmt.run(itemId, item.sourceKind, item.urlCanonical);

    return itemId;
  });

  return {
    // See the WatchlistStore interface doc: idempotent on a duplicate
    // content_hash/url_canonical (R5), returning the existing id untouched.
    insertItem(item: NewItem): number {
      return insertItemTxn(item);
    },

    findByHash(contentHash: string): StoredItem | null {
      const row = selectItemByHashStmt.get(contentHash) as ItemRow | undefined;
      return row === undefined ? null : hydrateItem(row);
    },

    findByUrl(urlCanonical: string): StoredItem | null {
      const row = selectItemByUrlStmt.get(urlCanonical) as ItemRow | undefined;
      return row === undefined ? null : hydrateItem(row);
    },

    addSource(itemId: number, sourceKind: string, url: string): void {
      insertSourceStmt.run(itemId, sourceKind, url);
    },

    findByTitleKey(titleKey: string, fromIso: string, toIso: string, excludeSourceKind: string): StoredItem | null {
      if (titleKey.length === 0) return null;
      const row = selectItemByTitleKeyStmt.get(titleKey, fromIso, toIso, excludeSourceKind) as ItemRow | undefined;
      return row === undefined ? null : hydrateItem(row);
    },

    itemsInPeriod(from: string, to: string, options?: { entities?: string[]; domains?: Domain[] }): StoredItem[] {
      const rows = selectItemsInPeriodStmt.all(from, to) as ItemRow[];
      let items = rows.map(hydrateItem);

      if (options?.entities !== undefined) {
        const wanted = new Set(options.entities);
        items = items.filter((item) => item.entities.some((e) => wanted.has(e)));
      }
      if (options?.domains !== undefined) {
        const wanted = new Set(options.domains);
        items = items.filter((item) => item.domains.some((d) => wanted.has(d)));
      }

      return items;
    },

    countsByEntity(from: string, to: string): Array<{ entityId: string; items: number; maxImportance: number }> {
      return countsByEntityStmt.all(from, to) as Array<{ entityId: string; items: number; maxImportance: number }>;
    },

    failingFeeds(minFailures: number): Array<{ feedId: string; failures: number }> {
      return (failingFeedsStmt.all(minFailures) as Array<{ feed_id: string; consecutive_failures: number }>).map((row) => ({
        feedId: row.feed_id,
        failures: row.consecutive_failures,
      }));
    },
    getFeedState(feedId: string): FeedState {
      insertFeedStateStmt.run(feedId);
      const row = getFeedStateStmt.get(feedId) as {
        feed_id: string;
        last_seen_at: string | null;
        last_item_hash: string | null;
        consecutive_failures: number;
      };
      return {
        feedId: row.feed_id,
        lastSeenAt: row.last_seen_at,
        lastItemHash: row.last_item_hash,
        consecutiveFailures: row.consecutive_failures,
      };
    },

    recordFeedSuccess(feedId: string, lastSeenAt: string | null, lastItemHash: string | null): void {
      insertFeedStateStmt.run(feedId);
      recordFeedSuccessStmt.run(lastSeenAt, lastItemHash, feedId);
    },

    recordFeedFailure(feedId: string): number {
      insertFeedStateStmt.run(feedId);
      incrementFeedFailureStmt.run(feedId);
      const row = getFeedStateStmt.get(feedId) as { consecutive_failures: number };
      return row.consecutive_failures;
    },

    startRun(startedAt: string): number {
      const result = startRunStmt.run(startedAt);
      return Number(result.lastInsertRowid);
    },

    finishRun(
      runId: number,
      finishedAt: string,
      stats: {
        fetched: number;
        deduped: number;
        tagged: number;
        failedFeeds: number;
        skippedByCap: number;
        skippedByBudget: number;
        anomalies: number;
      },
    ): void {
      finishRunStmt.run(
        finishedAt,
        stats.fetched,
        stats.deduped,
        stats.tagged,
        stats.failedFeeds,
        stats.skippedByCap,
        stats.skippedByBudget,
        stats.anomalies,
        runId,
      );
    },

    lastRun(): RunRecord | null {
      const row = lastRunStmt.get() as
        | {
            id: number;
            started_at: string;
            finished_at: string | null;
            fetched: number | null;
            deduped: number | null;
            tagged: number | null;
            failed_feeds: number | null;
            skipped_by_cap: number | null;
            skipped_by_budget: number | null;
            anomalies: number | null;
          }
        | undefined;
      if (row === undefined) return null;
      return {
        id: row.id,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        fetched: row.fetched ?? 0,
        deduped: row.deduped ?? 0,
        tagged: row.tagged ?? 0,
        failedFeeds: row.failed_feeds ?? 0,
        skippedByCap: row.skipped_by_cap ?? 0,
        skippedByBudget: row.skipped_by_budget ?? 0,
        anomalies: row.anomalies ?? 0,
      };
    },

    close(): void {
      db.close();
    },
  };
}
