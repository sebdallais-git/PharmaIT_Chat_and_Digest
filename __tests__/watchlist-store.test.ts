import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import type { Domain } from "../src/services/watchlist-config.js";
import { openWatchlistStore, type NewItem, type WatchlistStore } from "../src/services/watchlist-store.js";

const base: NewItem = {
  urlCanonical: "https://a/0",
  contentHash: "h0",
  sourceKind: "rss",
  sourceName: "f",
  title: "t",
  summary: "s",
  signal: "it_move",
  importance: 3,
  publishedAt: "2026-09-12T00:00:00.000Z",
  fetchedAt: "2026-09-12T01:00:00.000Z",
  entities: ["roche"],
  domains: ["cloud"],
};

describe("watchlist store", () => {
  let store: WatchlistStore;

  beforeEach(() => {
    store = openWatchlistStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("stores an item with its entities, domains and sources, and reads it back", () => {
    const id = store.insertItem({
      urlCanonical: "https://a/1",
      contentHash: "h1",
      sourceKind: "rss",
      sourceName: "Roche IR",
      title: "Roche picks a cloud",
      summary: "s",
      signal: "it_move",
      importance: 4,
      publishedAt: "2026-09-18T00:00:00.000Z",
      fetchedAt: "2026-09-19T00:00:00.000Z",
      entities: ["roche", "aws"],
      domains: ["cloud"],
    });
    store.addSource(id, "news", "https://news/1");

    const item = store.findByHash("h1");
    expect(item?.entities.sort()).toEqual(["aws", "roche"]);
    expect(item?.domains).toEqual(["cloud"]);
    expect(item?.urls.sort()).toEqual(["https://a/1", "https://news/1"]);
  });

  it("finds an item by canonical url for dedupe", () => {
    store.insertItem({ ...base, urlCanonical: "https://a/2", contentHash: "h2" });

    expect(store.findByUrl("https://a/2")?.contentHash).toBe("h2");
    expect(store.findByUrl("https://a/never")).toBeNull();
  });

  it("filters a period by entity and domain, newest first", () => {
    store.insertItem({ ...base, urlCanonical: "u1", contentHash: "c1", publishedAt: "2026-09-10T00:00:00.000Z", entities: ["roche"], domains: ["cloud"] });
    store.insertItem({ ...base, urlCanonical: "u2", contentHash: "c2", publishedAt: "2026-09-12T00:00:00.000Z", entities: ["roche"], domains: ["cyber"] });
    store.insertItem({ ...base, urlCanonical: "u3", contentHash: "c3", publishedAt: "2026-09-12T00:00:00.000Z", entities: ["novartis"], domains: ["cloud"] });

    const window = { from: "2026-09-11T00:00:00.000Z", to: "2026-09-13T00:00:00.000Z" };
    expect(store.itemsInPeriod(window.from, window.to).map((i) => i.contentHash)).toEqual(["c2", "c3"]);
    expect(store.itemsInPeriod(window.from, window.to, { entities: ["roche"] }).map((i) => i.contentHash)).toEqual(["c2"]);
    expect(store.itemsInPeriod(window.from, window.to, { domains: ["cloud"] }).map((i) => i.contentHash)).toEqual(["c3"]);
  });

  it("counts items per entity in a period with the highest importance", () => {
    store.insertItem({ ...base, urlCanonical: "u1", contentHash: "c1", entities: ["roche"], importance: 2 });
    store.insertItem({ ...base, urlCanonical: "u2", contentHash: "c2", entities: ["roche", "aws"], importance: 5 });

    expect(store.countsByEntity("2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z")).toEqual(
      expect.arrayContaining([
        { entityId: "roche", items: 2, maxImportance: 5 },
        { entityId: "aws", items: 1, maxImportance: 5 },
      ])
    );
  });

  it("tracks feed state: success resets failures, failure increments", () => {
    expect(store.getFeedState("f1")).toEqual({ feedId: "f1", lastSeenAt: null, lastItemHash: null, consecutiveFailures: 0 });
    expect(store.recordFeedFailure("f1")).toBe(1);
    expect(store.recordFeedFailure("f1")).toBe(2);
    store.recordFeedSuccess("f1", "2026-09-19T00:00:00.000Z", "h9");
    expect(store.getFeedState("f1")).toMatchObject({ consecutiveFailures: 0, lastItemHash: "h9" });
  });

  // The digest footer names feeds that are failing right now, worst first
  it("lists feeds failing at least N times in a row, worst first", () => {
    store.recordFeedFailure("veeva:rss:x");
    store.recordFeedFailure("veeva:rss:x");
    store.recordFeedFailure("veeva:rss:x");
    store.recordFeedFailure("roche:rss:y");
    store.recordFeedFailure("ok:rss:z");
    store.recordFeedSuccess("ok:rss:z", null, null);
    expect(store.failingFeeds(1)).toEqual([
      { feedId: "veeva:rss:x", failures: 3 },
      { feedId: "roche:rss:y", failures: 1 },
    ]);
    expect(store.failingFeeds(2)).toEqual([{ feedId: "veeva:rss:x", failures: 3 }]);
  });

  it("clears a failure streak without inventing a watermark", () => {
    // A feed that fetched cleanly but resolved nothing has no watermark to
    // record; stamping one would push its unseen backlog behind an exclusive
    // `since` forever.
    expect(store.recordFeedFailure("f-null")).toBe(1);
    store.recordFeedSuccess("f-null", null, null);

    expect(store.getFeedState("f-null")).toEqual({
      feedId: "f-null",
      lastSeenAt: null,
      lastItemHash: null,
      consecutiveFailures: 0,
    });
  });

  it("records a run's stats, cap pressure and anomaly count included", () => {
    const runId = store.startRun("2026-09-19T02:30:00.000Z");
    store.finishRun(runId, "2026-09-19T03:10:00.000Z", {
      fetched: 40,
      deduped: 12,
      tagged: 28,
      failedFeeds: 1,
      skippedByCap: 7,
      skippedByBudget: 3,
      anomalies: 2,
    });

    expect(store.lastRun()).toMatchObject({
      id: runId,
      fetched: 40,
      deduped: 12,
      tagged: 28,
      failedFeeds: 1,
      skippedByCap: 7,
      skippedByBudget: 3,
      anomalies: 2,
      finishedAt: "2026-09-19T03:10:00.000Z",
    });
  });

  it("returns null from lastRun when no run has been recorded", () => {
    expect(store.lastRun()).toBeNull();
  });

  it("allows an item with zero domains (R1: general news carries entities but no IT domain)", () => {
    const id = store.insertItem({ ...base, urlCanonical: "u-nodomain", contentHash: "c-nodomain", domains: [] });

    const item = store.findByHash("c-nodomain");
    expect(item?.domains).toEqual([]);
    expect(id).toBeGreaterThan(0);
  });

  it("allows an item with zero entities (an unassigned item)", () => {
    const id = store.insertItem({ ...base, urlCanonical: "u-noentity", contentHash: "c-noentity", entities: [] });

    const item = store.findByHash("c-noentity");
    expect(item?.entities).toEqual([]);
    expect(id).toBeGreaterThan(0);
  });

  it("rejects an unknown domain at the storage boundary", () => {
    expect(() =>
      store.insertItem({ ...base, urlCanonical: "u-bad-domain", contentHash: "c-bad-domain", domains: ["teleportation"] as unknown as Domain[] })
    ).toThrow();
  });

  it("rejects an unknown signal at the storage boundary", () => {
    expect(() =>
      store.insertItem({ ...base, urlCanonical: "u-bad-signal", contentHash: "c-bad-signal", signal: "teleportation" as unknown as NewItem["signal"] })
    ).toThrow();
  });

  // R5: insertItem must be idempotent on a duplicate content_hash or
  // url_canonical, so an ingest orchestrator can call it unconditionally
  // without a check-then-insert race.
  it("is idempotent on a duplicate content_hash: same id, one row, original data kept", () => {
    const id1 = store.insertItem({ ...base, urlCanonical: "https://a/dup-hash-1", contentHash: "c-dup-hash", summary: "original summary", entities: ["roche"] });
    const id2 = store.insertItem({
      ...base,
      urlCanonical: "https://a/dup-hash-2",
      contentHash: "c-dup-hash",
      summary: "should not overwrite",
      entities: ["novartis", "aws"],
    });

    expect(id2).toBe(id1);
    const item = store.findByHash("c-dup-hash");
    expect(item?.summary).toBe("original summary");
    expect(item?.entities).toEqual(["roche"]);

    const matches = store
      .itemsInPeriod("2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z")
      .filter((i) => i.contentHash === "c-dup-hash");
    expect(matches).toHaveLength(1);
  });

  it("is idempotent on a duplicate url_canonical with a different hash: same id, one row, original data kept", () => {
    const id1 = store.insertItem({ ...base, urlCanonical: "https://a/dup-url", contentHash: "c-dup-url-1" });
    const id2 = store.insertItem({ ...base, urlCanonical: "https://a/dup-url", contentHash: "c-dup-url-2", summary: "should not overwrite" });

    expect(id2).toBe(id1);
    const item = store.findByUrl("https://a/dup-url");
    expect(item?.contentHash).toBe("c-dup-url-1");
    expect(item?.summary).toBe(base.summary);

    const matches = store
      .itemsInPeriod("2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z")
      .filter((i) => i.urlCanonical === "https://a/dup-url");
    expect(matches).toHaveLength(1);
  });

  it("lets a duplicate insert's returned id be used with addSource to record a second sighting", () => {
    const id1 = store.insertItem({ ...base, urlCanonical: "https://a/dup-sighting-1", contentHash: "c-dup-sighting" });
    const id2 = store.insertItem({ ...base, urlCanonical: "https://a/dup-sighting-2", contentHash: "c-dup-sighting" });
    store.addSource(id2, "news", "https://news/dup-sighting");

    const item = store.findByHash("c-dup-sighting");
    expect(item?.id).toBe(id1);
    expect(item?.urls.sort()).toEqual(["https://a/dup-sighting-1", "https://news/dup-sighting"]);
  });

  // R13/R15: the cross-source title-key lookup Task 7's orchestrator uses as
  // its third and last dedupe step.
  describe("findByTitleKey", () => {
    it("finds an item with the same title key from a different source kind inside the window", () => {
      store.insertItem({
        ...base,
        urlCanonical: "https://a/tk-1",
        contentHash: "c-tk-1",
        titleKey: "roche picks a cloud",
        sourceKind: "rss",
        publishedAt: "2026-09-16T00:00:00.000Z",
      });

      const found = store.findByTitleKey(
        "roche picks a cloud",
        "2026-09-15T00:00:00.000Z",
        "2026-09-21T00:00:00.000Z",
        "news",
      );
      expect(found?.contentHash).toBe("c-tk-1");
      expect(found?.titleKey).toBe("roche picks a cloud");
    });

    it("never matches an item from the same source kind", () => {
      store.insertItem({
        ...base,
        urlCanonical: "https://a/tk-2",
        contentHash: "c-tk-2",
        titleKey: "roche results",
        sourceKind: "rss",
        publishedAt: "2026-09-16T00:00:00.000Z",
      });

      expect(
        store.findByTitleKey("roche results", "2026-09-15T00:00:00.000Z", "2026-09-21T00:00:00.000Z", "rss"),
      ).toBeNull();
    });

    it("never matches outside the published-at window", () => {
      store.insertItem({
        ...base,
        urlCanonical: "https://a/tk-3",
        contentHash: "c-tk-3",
        titleKey: "roche opens a site",
        sourceKind: "rss",
        publishedAt: "2026-09-01T00:00:00.000Z",
      });

      expect(
        store.findByTitleKey("roche opens a site", "2026-09-15T00:00:00.000Z", "2026-09-21T00:00:00.000Z", "news"),
      ).toBeNull();
    });

    it("never matches an item stored without a title key", () => {
      store.insertItem({ ...base, urlCanonical: "https://a/tk-4", contentHash: "c-tk-4", sourceKind: "rss" });

      expect(store.findByTitleKey("", "2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z", "news")).toBeNull();
    });
  });

  // R6: the join tables declare ON DELETE CASCADE, but that constraint is a
  // no-op unless the deleting connection has foreign_keys enabled. Uses a
  // temp file (not :memory:) so a second raw connection can see the store's
  // committed rows and issue the delete.
  it("enforces ON DELETE CASCADE from items to its join tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "watchlist-store-cascade-"));
    const dbPath = join(dir, "watchlist.db");
    const cascadeStore = openWatchlistStore(dbPath);
    try {
      const id = cascadeStore.insertItem({ ...base, urlCanonical: "https://a/cascade", contentHash: "c-cascade", entities: ["roche"], domains: ["cloud"] });
      cascadeStore.addSource(id, "news", "https://news/cascade");

      const raw = new Database(dbPath);
      raw.pragma("foreign_keys = ON");
      try {
        raw.prepare("DELETE FROM items WHERE id = ?").run(id);

        const entityCount = raw.prepare("SELECT COUNT(*) AS c FROM item_entities WHERE item_id = ?").get(id) as { c: number };
        const domainCount = raw.prepare("SELECT COUNT(*) AS c FROM item_domains WHERE item_id = ?").get(id) as { c: number };
        const sourceCount = raw.prepare("SELECT COUNT(*) AS c FROM item_sources WHERE item_id = ?").get(id) as { c: number };
        expect(entityCount.c).toBe(0);
        expect(domainCount.c).toBe(0);
        expect(sourceCount.c).toBe(0);
      } finally {
        raw.close();
      }
    } finally {
      cascadeStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Task 8 fix (a): recordFeedSuccess's doc comment promises that passing
  // null "leaves the watermark alone", but the plain UPDATE used to write
  // NULL straight over the column -- ingest only survived because it always
  // passed the previous value back itself. COALESCE(?, last_seen_at) (and
  // the same for the hash) makes the contract true independent of the
  // caller.
  it("keeps a previous watermark when a later success call passes null (COALESCE, not overwrite)", () => {
    store.recordFeedSuccess("f-keep", "2026-09-18T00:00:00.000Z", "h-keep");
    // e.g. a later run that fetched cleanly but resolved nothing new
    store.recordFeedSuccess("f-keep", null, null);

    expect(store.getFeedState("f-keep")).toEqual({
      feedId: "f-keep",
      lastSeenAt: "2026-09-18T00:00:00.000Z",
      lastItemHash: "h-keep",
      consecutiveFailures: 0,
    });
  });

  // Task 8 fix (b): the `runs`/`title_key` schema additions went straight
  // into CREATE TABLE IF NOT EXISTS with no migration path, so a
  // pre-existing data/watchlist.db (items/feed_state only, no title_key
  // column) would throw at open -- CREATE INDEX IF NOT EXISTS on a
  // nonexistent column fails immediately. A PRAGMA user_version migration
  // must upgrade such a database in place instead.
  describe("schema migration (PRAGMA user_version)", () => {
    it("opens cleanly, survives a write, and keeps the row after closing and reopening", () => {
      const dir = mkdtempSync(join(tmpdir(), "watchlist-store-migrate-fresh-"));
      const dbPath = join(dir, "watchlist.db");
      try {
        const first = openWatchlistStore(dbPath);
        first.insertItem({ ...base, urlCanonical: "https://a/reopen", contentHash: "c-reopen" });
        first.close();

        const second = openWatchlistStore(dbPath);
        expect(second.findByHash("c-reopen")?.urlCanonical).toBe("https://a/reopen");
        second.close();

        const raw = new Database(dbPath);
        expect(raw.pragma("user_version", { simple: true })).toBe(3);
        raw.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("upgrades a pre-Task-7 database (items without title_key, no runs table) without throwing at open", () => {
      const dir = mkdtempSync(join(tmpdir(), "watchlist-store-migrate-legacy-"));
      const dbPath = join(dir, "watchlist.db");
      try {
        // A schema as it existed before Task 7 added title_key and runs.
        const legacy = new Database(dbPath);
        legacy.exec(`
          CREATE TABLE items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url_canonical TEXT NOT NULL UNIQUE,
            content_hash TEXT NOT NULL UNIQUE,
            source_kind TEXT NOT NULL,
            source_name TEXT NOT NULL,
            title TEXT NOT NULL,
            summary TEXT NOT NULL,
            signal TEXT,
            importance INTEGER,
            facts TEXT,
            published_at TEXT NOT NULL,
            fetched_at TEXT NOT NULL,
            flagged INTEGER NOT NULL DEFAULT 0
          );
          CREATE TABLE item_entities (item_id INTEGER NOT NULL, entity_id TEXT NOT NULL, PRIMARY KEY (item_id, entity_id));
          CREATE TABLE item_domains (item_id INTEGER NOT NULL, domain TEXT NOT NULL, PRIMARY KEY (item_id, domain));
          CREATE TABLE item_sources (item_id INTEGER NOT NULL, source_kind TEXT NOT NULL, url TEXT NOT NULL, PRIMARY KEY (item_id, url));
          CREATE TABLE feed_state (feed_id TEXT PRIMARY KEY, last_seen_at TEXT, last_item_hash TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0);
          INSERT INTO items (url_canonical, content_hash, source_kind, source_name, title, summary, signal, importance, published_at, fetched_at)
          VALUES ('https://a/legacy', 'legacy-hash', 'rss', 'Legacy Feed', 'Legacy title', 'Legacy summary', 'it_move', 3, '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z');
        `);
        legacy.close();

        expect(() => openWatchlistStore(dbPath)).not.toThrow();

        const migrated = openWatchlistStore(dbPath);
        const legacyItem = migrated.findByHash("legacy-hash");
        expect(legacyItem?.title).toBe("Legacy title");
        expect(legacyItem?.titleKey).toBe(""); // backfilled default, never matches findByTitleKey
        migrated.insertItem({ ...base, urlCanonical: "https://a/post-migration", contentHash: "post-migration" });
        migrated.startRun("2026-09-20T02:30:00.000Z"); // the runs table must now exist
        migrated.close();

        const raw = new Database(dbPath);
        expect(raw.pragma("user_version", { simple: true })).toBe(3);
        raw.close();

        // Reopening an already-migrated database must be a no-op, not a second migration attempt.
        const reopened = openWatchlistStore(dbPath);
        expect(reopened.findByHash("legacy-hash")?.title).toBe("Legacy title");
        expect(reopened.findByHash("post-migration")).not.toBeNull();
        reopened.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // C1: the run's wall-clock budget needs its own runs column, so a
    // database written by the Task 8 code (user_version 1, runs table with
    // no skipped_by_budget) must be upgraded in place rather than throwing
    // on the first finishRun of the night.
    it("adds skipped_by_budget to a version-1 runs table instead of failing the next run", () => {
      const dir = mkdtempSync(join(tmpdir(), "watchlist-store-migrate-v1-"));
      const dbPath = join(dir, "watchlist.db");
      try {
        const legacy = new Database(dbPath);
        legacy.exec(`
          CREATE TABLE runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            fetched INTEGER,
            deduped INTEGER,
            tagged INTEGER,
            failed_feeds INTEGER,
            skipped_by_cap INTEGER,
            anomalies INTEGER
          );
          INSERT INTO runs (started_at, finished_at, fetched, deduped, tagged, failed_feeds, skipped_by_cap, anomalies)
          VALUES ('2026-09-19T02:30:00.000Z', '2026-09-19T02:50:00.000Z', 5, 1, 4, 0, 0, 0);
        `);
        legacy.pragma("user_version = 1");
        legacy.close();

        expect(() => openWatchlistStore(dbPath)).not.toThrow();

        const migrated = openWatchlistStore(dbPath);
        // The pre-existing row has no value for the new column: it reads 0,
        // it does not crash the hydration.
        expect(migrated.lastRun()?.skippedByBudget).toBe(0);

        const runId = migrated.startRun("2026-09-20T02:30:00.000Z");
        migrated.finishRun(runId, "2026-09-20T03:15:00.000Z", {
          fetched: 90,
          deduped: 4,
          tagged: 60,
          failedFeeds: 0,
          skippedByCap: 0,
          skippedByBudget: 26,
          anomalies: 0,
        });
        expect(migrated.lastRun()?.skippedByBudget).toBe(26);
        migrated.close();

        const raw = new Database(dbPath);
        expect(raw.pragma("user_version", { simple: true })).toBe(3);
        raw.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // Fix round 2, Minor 2: the case most likely to exist on the owner's own
    // machine isn't the pre-Task-7 legacy schema above -- it's a database
    // written by the intermediate (round-0) code, which already had
    // title_key/runs in its CREATE TABLE IF NOT EXISTS block but stamped no
    // user_version at all, so PRAGMA user_version reads 0 despite the schema
    // already being current. The guard must recognize title_key is already
    // there and only stamp the version, never attempt a duplicate-column
    // ALTER.
    it("stamps a database that already has the current schema but user_version 0, without re-adding title_key", () => {
      const dir = mkdtempSync(join(tmpdir(), "watchlist-store-migrate-stamped-"));
      const dbPath = join(dir, "watchlist.db");
      try {
        const first = openWatchlistStore(dbPath);
        first.insertItem({
          ...base,
          urlCanonical: "https://a/pre-stamped",
          contentHash: "c-pre-stamped",
          titleKey: "pre stamped",
        });
        first.close();

        // Roll the version back to 0 to simulate a database the round-0 code
        // (current schema, no version stamp) would have produced.
        const raw = new Database(dbPath);
        raw.pragma("user_version = 0");
        raw.close();

        expect(() => openWatchlistStore(dbPath)).not.toThrow();

        const reopened = openWatchlistStore(dbPath);
        expect(reopened.findByHash("c-pre-stamped")?.titleKey).toBe("pre stamped");
        reopened.insertItem({ ...base, urlCanonical: "https://a/after-stamp", contentHash: "c-after-stamp" });
        reopened.close();

        const rawAfter = new Database(dbPath);
        expect(rawAfter.pragma("user_version", { simple: true })).toBe(3);
        rawAfter.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe("item body persistence", () => {
  // The fetched article body is what makes a watchlist chunk deep enough to
  // answer a comparison question. Before this, it was embedded into ChromaDB
  // and then dropped, so a reindex destroyed it with no way to rebuild.
  it("round-trips the fetched body", () => {
    const store = openWatchlistStore(":memory:");
    const body = "Dell announced PowerStore Prime, a mid-range array refresh.";

    store.insertItem({ ...base, urlCanonical: "https://a/body", contentHash: "h-body", body });

    expect(store.findByHash("h-body")?.body).toBe(body);
  });

  it("defaults the body to an empty string when none was fetched", () => {
    const store = openWatchlistStore(":memory:");

    store.insertItem({ ...base, urlCanonical: "https://a/nobody", contentHash: "h-nobody" });

    expect(store.findByHash("h-nobody")?.body).toBe("");
  });
});
