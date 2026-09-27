// Ingest orchestrator tests.
//
// Everything is injected: fake adapters, a fake tagger, a fake embed writer
// and an in-memory store. No network, no ChromaDB, no local model, no
// data/watchlist.db -- this suite must never touch a live service.

import { describe, expect, it } from "@jest/globals";
import type { Entity, Feed, TopicQuery, Watchlist } from "../src/services/watchlist-config.js";
import {
  canonicalUrl,
  contentHash,
  rssAdapter,
  titleKey,
  type FetchLike,
  type RawItem,
} from "../src/services/watchlist-sources.js";
import type { IrPageResult } from "../src/services/watchlist-edgar.js";
import type { Tagging } from "../src/services/watchlist-tagger.js";
import { openWatchlistStore, type WatchlistStore } from "../src/services/watchlist-store.js";
import {
  computeCandidateIds,
  createIngestRun,
  DEFAULT_INGEST_BUDGET_MS,
  DISABLED_FEED_KINDS,
  feedIdFor,
  FIRST_RUN_BACKFILL_MS,
  topicFeedId,
  type IngestDeps,
  type IngestResult,
} from "../src/services/watchlist-ingest.js";

// ---- fixtures ---------------------------------------------------------------

function makeEntity(over: Partial<Entity> & { id: string }): Entity {
  return {
    id: over.id,
    name: over.name ?? over.id,
    kind: over.kind ?? "customer",
    aliases: over.aliases ?? [],
    domains: over.domains ?? [],
    peers: over.peers ?? [],
    feeds: over.feeds ?? [],
  };
}

function makeWatchlist(entities: Entity[], topics: TopicQuery[] = []): Watchlist {
  return {
    entities: new Map(entities.map((entity) => [entity.id, entity])),
    topics,
    // Tests build the priority list in the same customers -> peers -> vendors
    // order parseWatchlist produces.
    priority: entities.map((entity) => entity.id),
    notes: [],
  };
}

function rawItem(over: Partial<RawItem> & { title: string; url: string }): RawItem {
  const title = over.title;
  return {
    title,
    url: over.url,
    publishedAt: over.publishedAt ?? "2026-09-18T00:00:00.000Z",
    body: over.body ?? `body of ${title}`,
    sourceKind: over.sourceKind ?? "rss",
    sourceName: over.sourceName ?? "fixture",
    titleKey: over.titleKey ?? titleKey(title),
  };
}

const defaultTagging: Tagging = {
  summary: "a summary",
  entities: [],
  domains: ["cloud"],
  signal: "it_move",
  importance: 3,
  facts: null,
  flagged: false,
};

interface Harness {
  deps: IngestDeps;
  store: WatchlistStore;
  tagCalls: Array<{ item: RawItem; candidateIds: string[] }>;
  embedCalls: Array<{ texts: string[]; metadatas: Record<string, unknown>[] }>;
  rssCalls: Array<{ feed: Feed; entity: Entity; since: string | null }>;
  newsCalls: Array<{ query: string; since: string | null }>;
  edgarCalls: Array<{ cik: string; since: string | null; at: number }>;
  irPageCalls: Array<{ url: string; entity: Entity; since: string | null }>;
  logs: string[];
  run(options?: { since?: string; only?: string[] }): Promise<IngestResult>;
}

interface HarnessOptions {
  watchlist: Watchlist;
  store?: WatchlistStore;
  limit?: number;
  rss?(feed: Feed, entity: Entity, since: string | null): Promise<RawItem[]>;
  news?(query: string, since: string | null): Promise<RawItem[]>;
  edgar?(cik: string, entity: Entity, since: string | null): Promise<RawItem[]>;
  irPage?(url: string, entity: Entity, since: string | null): Promise<IrPageResult>;
  tag?(item: RawItem, candidateIds: string[]): Promise<Tagging>;
  edgarMinIntervalMs?: number;
  now?: Date;
  // An advancing clock, for the tests that need wall-clock time to pass
  // (C1's budget). Takes precedence over the fixed `now` above.
  clock?(): Date;
  budgetMs?: number;
  // R20: overrides the production default (DISABLED_FEED_KINDS) so a test
  // can re-enable a disabled kind to exercise its own fetch/anomaly logic
  // (e.g. ir_page's R16 check), without changing what ships by default.
  disabledKinds?: ReadonlySet<Feed["kind"]>;
}

function makeHarness(options: HarnessOptions): Harness {
  const store = options.store ?? openWatchlistStore(":memory:");
  const tagCalls: Harness["tagCalls"] = [];
  const embedCalls: Harness["embedCalls"] = [];
  const rssCalls: Harness["rssCalls"] = [];
  const newsCalls: Harness["newsCalls"] = [];
  const edgarCalls: Harness["edgarCalls"] = [];
  const irPageCalls: Harness["irPageCalls"] = [];
  const logs: string[] = [];

  const deps: IngestDeps = {
    watchlist: options.watchlist,
    store,
    adapters: {
      async rss(feed, entity, since) {
        rssCalls.push({ feed, entity, since });
        return options.rss !== undefined ? await options.rss(feed, entity, since) : [];
      },
      async news(query, since) {
        newsCalls.push({ query, since });
        return options.news !== undefined ? await options.news(query, since) : [];
      },
      async edgar(cik, entity, since) {
        edgarCalls.push({ cik, since, at: Date.now() });
        return options.edgar !== undefined ? await options.edgar(cik, entity, since) : [];
      },
      async irPage(url, entity, since) {
        irPageCalls.push({ url, entity, since });
        return options.irPage !== undefined
          ? await options.irPage(url, entity, since)
          : { items: [], linksScanned: 0, datedLinks: 0 };
      },
    },
    async tag(item, candidateIds) {
      tagCalls.push({ item, candidateIds });
      return options.tag !== undefined ? await options.tag(item, candidateIds) : defaultTagging;
    },
    async embed(texts, metadatas) {
      embedCalls.push({ texts, metadatas });
      return texts.length;
    },
    now: () => options.clock?.() ?? options.now ?? FIXED_NOW,
    limit: options.limit ?? 250,
    log: (line) => logs.push(line),
    edgarMinIntervalMs: options.edgarMinIntervalMs,
    budgetMs: options.budgetMs,
    disabledKinds: options.disabledKinds,
  };

  return {
    deps,
    store,
    tagCalls,
    embedCalls,
    rssCalls,
    newsCalls,
    edgarCalls,
    irPageCalls,
    logs,
    run: (runOptions) => createIngestRun(deps)(runOptions),
  };
}

const ALL_TIME = { from: "2000-01-01T00:00:00.000Z", to: "2100-01-01T00:00:00.000Z" };

// The clock every harness runs on unless a test injects its own, and the
// `since` I1's 30-day first-run backfill derives from it for a feed this
// store has never seen.
const FIXED_NOW = new Date("2026-09-20T06:00:00.000Z");
const BACKFILL_SINCE = new Date(FIXED_NOW.getTime() - FIRST_RUN_BACKFILL_MS).toISOString();

// ---- tests ------------------------------------------------------------------

describe("watchlist ingest", () => {
  it("fetches every due feed and stores its items with their tagging", async () => {
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche]),
      async rss() {
        return [
          rawItem({ title: "Roche picks a cloud", url: "https://roche.com/a" }),
          rawItem({ title: "Roche opens a datacentre", url: "https://roche.com/b" }),
        ];
      },
      async tag(item) {
        return { ...defaultTagging, summary: `S:${item.title}` };
      },
    });

    const result = await harness.run();

    expect(result.fetched).toBe(2);
    expect(result.stored).toBe(2);
    expect(result.tagged).toBe(2);
    expect(result.deduped).toBe(0);
    expect(result.failedFeeds).toEqual([]);

    const stored = harness.store.itemsInPeriod(ALL_TIME.from, ALL_TIME.to);
    expect(stored.map((item) => item.summary).sort()).toEqual([
      "S:Roche opens a datacentre",
      "S:Roche picks a cloud",
    ]);
    expect(stored[0].domains).toEqual(["cloud"]);
    expect(stored[0].signal).toBe("it_move");
    harness.store.close();
  });

  it("stores the same article seen by two adapters once, records both urls and tags it once", async () => {
    // Same title and body, different urls: the content hash matches (R15
    // step 2) so the news sighting must never reach the model.
    const title = "Roche picks a cloud";
    const body = "Roche said today it picked a cloud provider.";
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche], [{ query: "roche cloud", domains: ["cloud"] }]),
      async rss() {
        return [rawItem({ title, url: "https://roche.com/a", body })];
      },
      async news() {
        return [
          rawItem({
            title,
            url: "https://news.google.com/rss/articles/OPAQUE",
            body,
            sourceKind: "news",
            sourceName: "Google News",
          }),
        ];
      },
    });

    const result = await harness.run();

    expect(result.fetched).toBe(2);
    expect(result.stored).toBe(1);
    expect(result.deduped).toBe(1);
    expect(harness.tagCalls).toHaveLength(1);

    const stored = harness.store.findByHash(contentHash(title, body));
    expect(stored?.urls.sort()).toEqual(
      [canonicalUrl("https://news.google.com/rss/articles/OPAQUE"), canonicalUrl("https://roche.com/a")].sort(),
    );
    harness.store.close();
  });

  it("dedupes across source kinds on the title key inside the +/-3 day window", async () => {
    // Different url AND different body (Google News re-typesets), so only the
    // title key can catch this pair (R13).
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche], [{ query: "roche", domains: [] }]),
      async rss() {
        return [
          rawItem({
            title: "Roche picks a cloud",
            url: "https://roche.com/a",
            body: "Publisher copy of the release.",
            publishedAt: "2026-09-16T00:00:00.000Z",
          }),
        ];
      },
      async news() {
        return [
          rawItem({
            title: "Roche picks a cloud",
            url: "https://news.google.com/rss/articles/OPAQUE",
            body: "A different, re-typeset copy.",
            publishedAt: "2026-09-18T00:00:00.000Z",
            sourceKind: "news",
            sourceName: "Google News",
          }),
        ];
      },
    });

    const result = await harness.run();

    expect(result.stored).toBe(1);
    expect(result.deduped).toBe(1);
    expect(harness.tagCalls).toHaveLength(1);
    expect(harness.store.itemsInPeriod(ALL_TIME.from, ALL_TIME.to)).toHaveLength(1);
    harness.store.close();
  });

  it("never matches a title key against another item from the same source kind", async () => {
    // titleKey strips a trailing dash clause, so two genuinely different
    // releases from one company can share a key (R13/R15).
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche]),
      async rss() {
        return [
          rawItem({ title: "Roche results - Q3 revenue up", url: "https://roche.com/a", body: "one" }),
          rawItem({ title: "Roche results - new CFO named", url: "https://roche.com/b", body: "two" }),
        ];
      },
    });

    // Both items reduce to the same title key, and both come from "rss".
    expect(titleKey("Roche results - Q3 revenue up")).toBe(titleKey("Roche results - new CFO named"));

    const result = await harness.run();

    expect(result.stored).toBe(2);
    expect(result.deduped).toBe(0);
    expect(harness.tagCalls).toHaveLength(2);
    harness.store.close();
  });

  it("does not match a title key outside the +/-3 day published window", async () => {
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche], [{ query: "roche", domains: [] }]),
      async rss() {
        return [
          rawItem({
            title: "Roche picks a cloud",
            url: "https://roche.com/a",
            body: "one",
            publishedAt: "2026-09-10T00:00:00.000Z",
          }),
        ];
      },
      async news() {
        return [
          rawItem({
            title: "Roche picks a cloud",
            url: "https://news.google.com/rss/articles/OPAQUE",
            body: "two",
            publishedAt: "2026-09-18T00:00:00.000Z",
            sourceKind: "news",
          }),
        ];
      },
    });

    const result = await harness.run();

    expect(result.stored).toBe(2);
    expect(result.deduped).toBe(0);
    harness.store.close();
  });

  it("skips an item already stored by a previous run without calling the model", async () => {
    const store = openWatchlistStore(":memory:");
    const title = "Roche picks a cloud";
    const body = "the body";
    store.insertItem({
      urlCanonical: canonicalUrl("https://roche.com/a"),
      contentHash: contentHash(title, body),
      titleKey: titleKey(title),
      sourceKind: "rss",
      sourceName: "Roche",
      title,
      summary: "already summarised",
      signal: "it_move",
      importance: 3,
      publishedAt: "2026-09-18T00:00:00.000Z",
      fetchedAt: "2026-09-19T00:00:00.000Z",
      entities: ["roche"],
      domains: ["cloud"],
    });

    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche]),
      store,
      async rss() {
        return [rawItem({ title, url: "https://roche.com/a", body })];
      },
    });

    const result = await harness.run();

    expect(result.deduped).toBe(1);
    expect(result.stored).toBe(0);
    expect(harness.tagCalls).toHaveLength(0);
    expect(harness.embedCalls).toHaveLength(0);
    store.close();
  });

  it("applies the cap in priority order and counts what it drops", async () => {
    const feedOf = (id: string): Feed => ({ kind: "rss", url: `https://${id}.example/feed.xml` });
    const customer = makeEntity({ id: "roche", name: "Roche", kind: "customer", feeds: [feedOf("roche")] });
    const peer = makeEntity({ id: "novartis", name: "Novartis", kind: "peer", feeds: [feedOf("novartis")] });
    const vendor = makeEntity({ id: "aws", name: "Amazon Web Services", kind: "vendor", feeds: [feedOf("aws")] });

    const harness = makeHarness({
      watchlist: makeWatchlist([customer, peer, vendor]),
      limit: 2,
      async rss(_feed, entity) {
        return [rawItem({ title: `${entity.name} does a thing`, url: `https://${entity.id}.example/a` })];
      },
    });

    const result = await harness.run();

    expect(result.fetched).toBe(3);
    expect(result.stored).toBe(2);
    expect(result.skippedByCap).toBe(1);
    expect(harness.tagCalls.map((call) => call.item.title)).toEqual([
      "Roche does a thing",
      "Novartis does a thing",
    ]);
    const storedTitles = harness.store.itemsInPeriod(ALL_TIME.from, ALL_TIME.to).map((item) => item.title).sort();
    expect(storedTitles).toEqual(["Novartis does a thing", "Roche does a thing"]);
    harness.store.close();
  });

  it("does not advance a watermark past items the cap dropped, newest-first", async () => {
    // The realistic ordering: feeds are newest-first and adapters preserve
    // feed order, so the cap bites part-way DOWN the list. Stamping the
    // newest item would push the capped older ones behind an exclusive
    // `since` and lose them for good.
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche]),
      limit: 1,
      async rss() {
        return [
          rawItem({ title: "Newest", url: "https://roche.com/c", publishedAt: "2026-09-19T00:00:00.000Z" }),
          rawItem({ title: "Middle", url: "https://roche.com/b", publishedAt: "2026-09-17T00:00:00.000Z" }),
          rawItem({ title: "Oldest", url: "https://roche.com/a", publishedAt: "2026-09-16T00:00:00.000Z" }),
        ];
      },
    });

    const result = await harness.run();

    expect(result.stored).toBe(1);
    expect(result.skippedByCap).toBe(2);
    // No resolved item is older than the oldest capped one, so the watermark
    // cannot move at all.
    expect(harness.store.getFeedState(feedIdFor(roche, rssFeed)).lastSeenAt).toBeNull();
    harness.store.close();
  });

  it("clamps the watermark strictly below the oldest item the cap dropped", async () => {
    // Oldest-first ordering: the two oldest were resolved, the newest was
    // capped, so the watermark may advance -- but only to an item strictly
    // older than the capped one (`since` is exclusive).
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche]),
      limit: 2,
      async rss() {
        return [
          rawItem({ title: "Oldest", url: "https://roche.com/a", publishedAt: "2026-09-16T00:00:00.000Z" }),
          rawItem({ title: "Middle", url: "https://roche.com/b", publishedAt: "2026-09-17T00:00:00.000Z" }),
          rawItem({ title: "Newest", url: "https://roche.com/c", publishedAt: "2026-09-19T00:00:00.000Z" }),
        ];
      },
    });

    const result = await harness.run();

    expect(result.stored).toBe(2);
    expect(result.skippedByCap).toBe(1);
    expect(harness.store.getFeedState(feedIdFor(roche, rssFeed)).lastSeenAt).toBe("2026-09-17T00:00:00.000Z");
    harness.store.close();
  });

  it("leaves a never-seen feed's watermark null when the cap ate its whole first batch", async () => {
    // The first production run is exactly the one that blows the cap: every
    // feed backfills over I1's 30-day window. A feed that resolved nothing
    // must stay unstamped so the next run backfills it again.
    const rocheFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const awsFeed: Feed = { kind: "rss", url: "https://aws.example/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", kind: "customer", feeds: [rocheFeed] });
    const aws = makeEntity({ id: "aws", name: "Amazon Web Services", kind: "vendor", feeds: [awsFeed] });
    const store = openWatchlistStore(":memory:");
    const watchlist = makeWatchlist([roche, aws]);
    const rss = async (_feed: Feed, entity: Entity): Promise<RawItem[]> => [
      rawItem({
        title: `${entity.name} does a thing`,
        url: `https://${entity.id}.example/a`,
        publishedAt: "2026-09-19T00:00:00.000Z",
      }),
    ];

    const starved = makeHarness({ watchlist, store, limit: 1, rss });
    const first = await starved.run();

    expect(first.skippedByCap).toBe(1);
    expect(store.getFeedState(feedIdFor(aws, awsFeed)).lastSeenAt).toBeNull();
    // A starved feed still fetched cleanly, so its failure streak is clear.
    expect(store.getFeedState(feedIdFor(aws, awsFeed)).consecutiveFailures).toBe(0);

    // Next run, with room again: the vendor's item comes back and is stored.
    const roomy = makeHarness({ watchlist, store, limit: 250, rss });
    const second = await roomy.run();

    // The customer's feed resolved its item and advanced; the starved
    // vendor's is still backfilling from scratch.
    expect(roomy.rssCalls.map((call) => call.since)).toEqual(["2026-09-19T00:00:00.000Z", BACKFILL_SINCE]);
    expect(second.stored + second.deduped).toBe(2);
    expect(store.itemsInPeriod(ALL_TIME.from, ALL_TIME.to).map((item) => item.title).sort()).toEqual([
      "Amazon Web Services does a thing",
      "Roche does a thing",
    ]);
    store.close();
  });

  it("persists skippedByCap and the anomaly count with the run", async () => {
    // Starvation has to be visible in the DB tomorrow, not only in tonight's
    // stdout: a starved feed is recorded as a success, so the run row is the
    // only place the pressure shows up.
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const irFeed: Feed = { kind: "ir_page", url: "https://roche.com/investors" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed, irFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche]),
      limit: 1,
      // R20 disables ir_page by default; this test is about skippedByCap and
      // the anomaly count together, so it re-enables ir_page to still get an
      // anomaly out of the same run (see the dedicated R20 tests below for
      // ir_page's own skipped-not-failed behaviour under the real default).
      disabledKinds: new Set(),
      async rss() {
        return [
          rawItem({ title: "One", url: "https://roche.com/a", publishedAt: "2026-09-16T00:00:00.000Z" }),
          rawItem({ title: "Two", url: "https://roche.com/b", publishedAt: "2026-09-17T00:00:00.000Z" }),
        ];
      },
      async irPage() {
        return { items: [], linksScanned: 9, datedLinks: 0 };
      },
    });

    const result = await harness.run();
    const run = harness.store.lastRun();

    expect(result.skippedByCap).toBe(1);
    expect(run?.skippedByCap).toBe(1);
    expect(run?.anomalies).toBe(1);
    harness.store.close();
  });

  // ---- C2: a same-date sibling of the watermark ---------------------------

  // The real adapter is wired in here, with an injected fetch and no network:
  // the cutoff being tested lives in the adapter, but what matters is the
  // whole path -- the second item of the watermark's own day must survive the
  // cutoff, be recognised as new, and be tagged exactly once while the item
  // already stored is deduped away before the model.
  it("stores the second item of the watermark's own day and never re-tags the first", async () => {
    const feedUrl = "https://roche.com/feed.xml";
    const rssFeed: Feed = { kind: "rss", url: feedUrl };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    const store = openWatchlistStore(":memory:");
    const watchlist = makeWatchlist([roche]);

    // Both items carry the same day-precision timestamp, the way an IR page
    // or an EDGAR filing list dates everything it published that day.
    const item = (title: string, slug: string): string => `
    <item>
      <title>${title}</title>
      <link>https://roche.com/${slug}</link>
      <pubDate>Wed, 16 Sep 2026 00:00:00 GMT</pubDate>
    </item>`;
    const feedBody = (items: string): string =>
      `<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`;

    let body = feedBody(item("First of the day", "first"));
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, text: async () => body });
    const rss = rssAdapter({ fetchImpl, now: () => FIXED_NOW, userAgent: "PharmaITChat-Test/1.0" });

    const firstRun = makeHarness({ watchlist, store, rss });
    await firstRun.run();
    expect(store.getFeedState(feedIdFor(roche, rssFeed)).lastSeenAt).toBe("2026-09-16T00:00:00.000Z");

    // The next night the feed also lists a sibling published the same day.
    body = feedBody(item("First of the day", "first") + item("Second of the day", "second"));
    const secondRun = makeHarness({ watchlist, store, rss });
    const result = await secondRun.run();

    expect(result.fetched).toBe(2); // the watermark's own item is re-offered, not filtered out
    expect(result.deduped).toBe(1); // ...and recognised by url, before the cap and before the model
    expect(result.stored).toBe(1);
    // Exactly one model call in this run, for the new item only.
    expect(secondRun.tagCalls.map((call) => call.item.title)).toEqual(["Second of the day"]);
    expect(store.itemsInPeriod(ALL_TIME.from, ALL_TIME.to).map((i) => i.title).sort()).toEqual([
      "First of the day",
      "Second of the day",
    ]);
    store.close();
  });

  // ---- C1: the run's wall-clock budget ------------------------------------

  it("stops tagging when the wall-clock budget is spent, defers the rest and finishes the run", async () => {
    // Hermes SIGKILLs a no-agent script at cron.script_timeout_seconds and
    // the `finally` that calls finishRun never runs, so the run row stays
    // unfinished and the job alerts every night. The run has to stop itself
    // first. Here each tagging costs 20 minutes of the 45-minute budget.
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    let nowMs = FIXED_NOW.getTime();
    const harness = makeHarness({
      watchlist: makeWatchlist([roche]),
      budgetMs: 45 * 60 * 1000,
      clock: () => new Date(nowMs),
      async rss() {
        // Newest first, exactly as a real feed lists them.
        return [1, 2, 3, 4, 5].map((n) =>
          rawItem({
            title: `Item ${n}`,
            url: `https://roche.com/${n}`,
            publishedAt: `2026-09-${19 - n}T00:00:00.000Z`,
          }),
        );
      },
      async tag() {
        nowMs += 20 * 60 * 1000;
        return defaultTagging;
      },
    });

    const result = await harness.run();

    expect(result.tagged).toBe(3);
    expect(result.stored).toBe(3);
    expect(result.skippedByBudget).toBe(2);
    expect(result.skippedByCap).toBe(0);
    // The run closed out normally: a finished row, not the unfinished one an
    // external kill would have left behind.
    const run = harness.store.lastRun();
    expect(run?.id).toBe(result.runId);
    expect(run?.finishedAt).not.toBeNull();
    expect(run?.skippedByBudget).toBe(2);
    expect(harness.logs.some((line) => line.includes("budget spent"))).toBe(true);
    harness.store.close();
  });

  it("never advances a watermark past an item the budget deferred", async () => {
    // An item left untagged because time ran out is exactly like one the cap
    // dropped: the same clamp has to hold, or the deferred tail disappears
    // behind an exclusive `since` for good.
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    let nowMs = FIXED_NOW.getTime();
    const harness = makeHarness({
      watchlist: makeWatchlist([roche]),
      budgetMs: 10 * 60 * 1000,
      clock: () => new Date(nowMs),
      async rss() {
        return [
          rawItem({ title: "Newest", url: "https://roche.com/c", publishedAt: "2026-09-19T00:00:00.000Z" }),
          rawItem({ title: "Middle", url: "https://roche.com/b", publishedAt: "2026-09-18T00:00:00.000Z" }),
          rawItem({ title: "Oldest", url: "https://roche.com/a", publishedAt: "2026-09-17T00:00:00.000Z" }),
        ];
      },
      async tag() {
        nowMs += 10 * 60 * 1000;
        return defaultTagging;
      },
    });

    const result = await harness.run();

    expect(result.tagged).toBe(1);
    expect(result.skippedByBudget).toBe(2);
    // "Newest" was stored, but the two older items were deferred: the
    // watermark must stay strictly below the oldest of them, which here
    // means it never moves at all.
    expect(harness.store.getFeedState(feedIdFor(roche, rssFeed)).lastSeenAt).toBeNull();
    harness.store.close();
  });

  it("treats a non-positive budget as the default, never as 'no time at all'", async () => {
    // Same rule as `limit` and the EDGAR interval: 0 means unset. Read
    // literally it would defer every item of every run forever.
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche]),
      budgetMs: 0,
      async rss() {
        return [
          rawItem({ title: "One", url: "https://roche.com/a" }),
          rawItem({ title: "Two", url: "https://roche.com/b" }),
        ];
      },
    });

    const result = await harness.run();

    expect(DEFAULT_INGEST_BUDGET_MS).toBeGreaterThan(0);
    expect(result.tagged).toBe(2);
    expect(result.skippedByBudget).toBe(0);
    harness.store.close();
  });

  // ---- I1: the spec's 30-day first-run backfill ----------------------------

  it("asks a never-seen feed for the last 30 days, not its entire history", async () => {
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    const harness = makeHarness({ watchlist: makeWatchlist([roche]) });

    await harness.run();

    expect(harness.rssCalls.map((call) => call.since)).toEqual([
      new Date(FIXED_NOW.getTime() - FIRST_RUN_BACKFILL_MS).toISOString(),
    ]);
    harness.store.close();
  });

  it("lets an explicit since win over the first-run backfill", async () => {
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    const harness = makeHarness({ watchlist: makeWatchlist([roche]) });

    await harness.run({ since: "2025-01-01T00:00:00.000Z" });

    expect(harness.rssCalls.map((call) => call.since)).toEqual(["2025-01-01T00:00:00.000Z"]);
    harness.store.close();
  });

  // ---- I4: a dead model is not a quiet night -------------------------------

  it("counts tagger failures separately from the feeds they fail", async () => {
    // Only feeds that actually have new items ever call the tagger, so a
    // total tagging outage fails a handful of feeds out of ~150 -- which
    // "every feed failed" cannot see. The count is what makes it visible.
    const rocheFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const quietFeed: Feed = { kind: "rss", url: "https://novartis.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rocheFeed] });
    const novartis = makeEntity({ id: "novartis", name: "Novartis", feeds: [quietFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche, novartis]),
      async rss(_feed, entity) {
        return entity.id === "roche" ? [rawItem({ title: "One", url: "https://roche.com/a" })] : [];
      },
      async tag() {
        throw new Error("model is not answering");
      },
    });

    const result = await harness.run();

    expect(result.taggerFailures).toBe(1);
    expect(result.failedFeeds).toEqual([feedIdFor(roche, rocheFeed)]);
    expect(result.stored).toBe(0);
    harness.store.close();
  });

  it("reports no tagger failures on an ordinary run", async () => {
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche]),
      async rss() {
        return [rawItem({ title: "One", url: "https://roche.com/a" })];
      },
    });

    const result = await harness.run();

    expect(result.taggerFailures).toBe(0);
    harness.store.close();
  });

  it("dedupes on the canonical url alone and leaves the stored item untouched", async () => {
    // Same page, re-typeset body: the content hash differs, so only step 1 of
    // the ladder can catch it -- and the tagging already stored must survive.
    const store = openWatchlistStore(":memory:");
    const title = "Roche picks a cloud";
    store.insertItem({
      urlCanonical: canonicalUrl("https://roche.com/a"),
      contentHash: contentHash(title, "the original body"),
      titleKey: titleKey(title),
      sourceKind: "rss",
      sourceName: "Roche",
      title,
      summary: "already summarised",
      signal: "it_move",
      importance: 4,
      publishedAt: "2026-09-18T00:00:00.000Z",
      fetchedAt: "2026-09-19T00:00:00.000Z",
      entities: ["roche"],
      domains: ["cloud"],
    });

    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche]),
      store,
      async rss() {
        return [rawItem({ title, url: "https://roche.com/a?utm_source=news", body: "a re-typeset body" })];
      },
      async tag() {
        return { ...defaultTagging, summary: "MUST NOT REPLACE" };
      },
    });

    const result = await harness.run();

    expect(result.deduped).toBe(1);
    expect(result.stored).toBe(0);
    expect(harness.tagCalls).toHaveLength(0);
    const kept = store.findByUrl(canonicalUrl("https://roche.com/a"));
    expect(kept?.summary).toBe("already summarised");
    expect(kept?.importance).toBe(4);
    store.close();
  });

  it("records a throwing feed as a failure, keeps going, and never advances its watermark", async () => {
    const brokenFeed: Feed = { kind: "rss", url: "https://broken.example/feed.xml" };
    const goodFeed: Feed = { kind: "rss", url: "https://good.example/feed.xml" };
    const broken = makeEntity({ id: "broken", name: "Broken", feeds: [brokenFeed] });
    const good = makeEntity({ id: "good", name: "Good", feeds: [goodFeed] });

    const harness = makeHarness({
      watchlist: makeWatchlist([broken, good]),
      async rss(_feed, entity) {
        if (entity.id === "broken") throw new Error("HTTP 503");
        return [
          rawItem({ title: "Good news", url: "https://good.example/a", publishedAt: "2026-09-18T00:00:00.000Z" }),
        ];
      },
    });

    const result = await harness.run();

    expect(result.failedFeeds).toEqual([feedIdFor(broken, brokenFeed)]);
    expect(result.stored).toBe(1);
    expect(harness.store.getFeedState(feedIdFor(broken, brokenFeed)).consecutiveFailures).toBe(1);
    expect(harness.store.getFeedState(feedIdFor(broken, brokenFeed)).lastSeenAt).toBeNull();
    expect(harness.store.getFeedState(feedIdFor(good, goodFeed)).lastSeenAt).toBe("2026-09-18T00:00:00.000Z");
    harness.store.close();
  });

  it("passes the stored watermark back to the adapter on the next run", async () => {
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    let batch = 0;
    const harness = makeHarness({
      watchlist: makeWatchlist([roche]),
      async rss() {
        batch += 1;
        if (batch > 1) return [];
        return [rawItem({ title: "First", url: "https://roche.com/a", publishedAt: "2026-09-18T00:00:00.000Z" })];
      },
    });

    await harness.run();
    await harness.run();

    expect(harness.rssCalls.map((call) => call.since)).toEqual([BACKFILL_SINCE, "2026-09-18T00:00:00.000Z"]);
    harness.store.close();
  });

  it("embeds every stored item once with entity, domain, signal and published_at", async () => {
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche]),
      async rss() {
        return [rawItem({ title: "Roche picks a cloud", url: "https://roche.com/a" })];
      },
      async tag() {
        return { ...defaultTagging, entities: ["roche"], domains: ["cloud"], signal: "it_move" };
      },
    });

    await harness.run();

    expect(harness.embedCalls).toHaveLength(1);
    const [call] = harness.embedCalls;
    expect(call.texts).toHaveLength(1);
    expect(call.texts[0]).toContain("Roche picks a cloud");
    const metadata = call.metadatas[0];
    expect(metadata.entity).toBe("roche");
    expect(metadata.domain).toBe("cloud");
    expect(metadata.signal).toBe("it_move");
    expect(metadata.published_at).toBe("2026-09-18T00:00:00.000Z");
    harness.store.close();
  });

  it("records the run with startRun/finishRun", async () => {
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche]),
      async rss() {
        return [rawItem({ title: "Roche picks a cloud", url: "https://roche.com/a" })];
      },
    });

    const result = await harness.run();
    const run = harness.store.lastRun();

    expect(run?.id).toBe(result.runId);
    expect(run?.startedAt).toBe("2026-09-20T06:00:00.000Z");
    expect(run?.finishedAt).toBe("2026-09-20T06:00:00.000Z");
    expect(run?.fetched).toBe(1);
    expect(run?.tagged).toBe(1);
    expect(run?.failedFeeds).toBe(0);
    harness.store.close();
  });

  // R20 disables ir_page by default in production, but its own R16
  // anomaly-detection logic must keep working for Phase 2, when it is
  // re-enabled -- these two tests exercise it directly via disabledKinds.
  it("records an IR page that scanned links but recognised no dates as an anomaly (R16)", async () => {
    const irFeed: Feed = { kind: "ir_page", url: "https://roche.com/investors/reports" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [irFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche]),
      disabledKinds: new Set(),
      async irPage() {
        return { items: [], linksScanned: 12, datedLinks: 0 };
      },
    });

    const result = await harness.run();

    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]).toContain("roche");
    expect(result.failedFeeds).toEqual([]);
    harness.store.close();
  });

  it("treats an IR page with no links at all as ordinary silence (R16)", async () => {
    const irFeed: Feed = { kind: "ir_page", url: "https://roche.com/investors/reports" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [irFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche]),
      disabledKinds: new Set(),
      async irPage() {
        return { items: [], linksScanned: 0, datedLinks: 0 };
      },
    });

    const result = await harness.run();

    expect(result.anomalies).toEqual([]);
    harness.store.close();
  });

  // What this proves is the wiring: the gate applies to EDGAR calls and not to
  // RSS. The gate's own spacing is proven deterministically in
  // min-interval-gate.test.ts. The numbers leave room for scheduling jitter:
  // at 40 ms with a 35 ms floor, and a 40 ms budget for the whole RSS run, a
  // busy full-suite run failed this now and then without anything being wrong.
  it("rate-limits EDGAR calls across the whole run, and only EDGAR calls (R17)", async () => {
    const entities = ["a", "b", "c"].map((id) =>
      makeEntity({ id, name: id.toUpperCase(), feeds: [{ kind: "edgar", cik: `000000000${id.charCodeAt(0)}` }] }),
    );
    const harness = makeHarness({
      watchlist: makeWatchlist(entities),
      edgarMinIntervalMs: 150,
      async edgar() {
        return [];
      },
    });

    await harness.run();

    expect(harness.edgarCalls).toHaveLength(3);
    const [first, second, third] = harness.edgarCalls;
    expect(second.at - first.at).toBeGreaterThanOrEqual(120);
    expect(third.at - second.at).toBeGreaterThanOrEqual(120);
    harness.store.close();

    // The same three feeds as RSS are not throttled.
    const rssEntities = ["a", "b", "c"].map((id) =>
      makeEntity({ id, name: id.toUpperCase(), feeds: [{ kind: "rss", url: `https://${id}.example/f.xml` }] }),
    );
    const rssHarness = makeHarness({
      watchlist: makeWatchlist(rssEntities),
      // Throttled, three feeds would take at least 2 s
      edgarMinIntervalMs: 1000,
      async rss() {
        return [];
      },
    });
    const startedAt = Date.now();
    await rssHarness.run();
    expect(Date.now() - startedAt).toBeLessThan(500);
    rssHarness.store.close();
  });

  it("treats a non-positive EDGAR interval as the default, never as 'no gate' (R17)", async () => {
    const entities = ["a", "b"].map((id) =>
      makeEntity({ id, name: id.toUpperCase(), feeds: [{ kind: "edgar", cik: `000000000${id.charCodeAt(0)}` }] }),
    );
    const harness = makeHarness({
      watchlist: makeWatchlist(entities),
      edgarMinIntervalMs: 0,
      async edgar() {
        return [];
      },
    });

    await harness.run();

    const [first, second] = harness.edgarCalls;
    // EDGAR_MIN_INTERVAL_MS is 100ms; 0 must not switch the SEC's limit off.
    expect(second.at - first.at).toBeGreaterThanOrEqual(90);
    harness.store.close();
  });

  it("gives the tagger the feed's own entity plus entities named in the item", async () => {
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", aliases: ["Genentech"], feeds: [rssFeed] });
    const novartis = makeEntity({ id: "novartis", name: "Novartis", kind: "peer" });
    const aws = makeEntity({ id: "aws", name: "Amazon Web Services", kind: "vendor", aliases: ["AWS"] });
    const unmentioned = makeEntity({ id: "bayer", name: "Bayer", kind: "peer" });

    const harness = makeHarness({
      watchlist: makeWatchlist([roche, novartis, aws, unmentioned]),
      async rss() {
        return [
          rawItem({
            title: "Genentech and Novartis compare notes",
            url: "https://roche.com/a",
            body: "No cloud vendor was named in this one.",
          }),
        ];
      },
    });

    await harness.run();

    const candidates = harness.tagCalls[0].candidateIds;
    expect(candidates).toContain("roche");
    expect(candidates).toContain("novartis");
    expect(candidates).not.toContain("bayer");
    harness.store.close();
  });

  it("ignores aliases shorter than four characters when building candidates", () => {
    const roche = makeEntity({ id: "roche", name: "Roche" });
    const shortAlias = makeEntity({ id: "gne", name: "Some Vendor", kind: "vendor", aliases: ["GNE"] });
    const watchlist = makeWatchlist([roche, shortAlias]);
    const item = rawItem({
      title: "A GNE update",
      url: "https://x.example/a",
      body: "GNE shipped something; Roche said nothing.",
    });

    const candidates = computeCandidateIds(item, watchlist, null);

    expect(candidates).toContain("roche");
    expect(candidates).not.toContain("gne");
  });

  it("matches names and aliases on word boundaries only", () => {
    const sapEntity = makeEntity({ id: "sap", name: "SAP", kind: "vendor" });
    const watchlist = makeWatchlist([sapEntity]);
    const embedded = rawItem({ title: "Asaptic resins", url: "https://x.example/a", body: "nothing to see" });
    const named = rawItem({ title: "An SAP rollout", url: "https://x.example/b", body: "nothing to see" });

    expect(computeCandidateIds(embedded, watchlist, null)).toEqual([]);
    expect(computeCandidateIds(named, watchlist, null)).toEqual(["sap"]);
  });

  it("runs topic queries as news feeds with their own watermark", async () => {
    const topics: TopicQuery[] = [{ query: "pharma ransomware breach", domains: ["cyber"] }];
    const harness = makeHarness({
      watchlist: makeWatchlist([], topics),
      async news() {
        return [
          rawItem({
            title: "A pharma breach",
            url: "https://news.example/a",
            sourceKind: "news",
            publishedAt: "2026-09-19T00:00:00.000Z",
          }),
        ];
      },
    });

    const result = await harness.run();

    expect(harness.newsCalls).toEqual([{ query: "pharma ransomware breach", since: BACKFILL_SINCE }]);
    expect(result.stored).toBe(1);
    expect(harness.store.getFeedState(topicFeedId("pharma ransomware breach")).lastSeenAt).toBe(
      "2026-09-19T00:00:00.000Z",
    );
    harness.store.close();
  });

  it("restricts the run to the requested entities with `only`", async () => {
    const rocheFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const novartisFeed: Feed = { kind: "rss", url: "https://novartis.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rocheFeed] });
    const novartis = makeEntity({ id: "novartis", name: "Novartis", feeds: [novartisFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche, novartis], [{ query: "topic", domains: [] }]),
      async rss() {
        return [];
      },
    });

    await harness.run({ only: ["roche"] });

    expect(harness.rssCalls.map((call) => call.entity.id)).toEqual(["roche"]);
    expect(harness.newsCalls).toEqual([]);
    harness.store.close();
  });

  it("overrides every feed's watermark with an explicit `since`", async () => {
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche]),
      async rss() {
        return [];
      },
    });

    await harness.run({ since: "2026-09-01T00:00:00.000Z" });

    expect(harness.rssCalls[0].since).toBe("2026-09-01T00:00:00.000Z");
    harness.store.close();
  });

  it("keeps a stored item when the ChromaDB writer fails, and reports it", async () => {
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    const store = openWatchlistStore(":memory:");
    const harness = makeHarness({
      watchlist: makeWatchlist([roche]),
      store,
      async rss() {
        return [rawItem({ title: "Roche picks a cloud", url: "https://roche.com/a" })];
      },
    });
    harness.deps.embed = async () => {
      throw new Error("chroma down");
    };

    const result = await createIngestRun(harness.deps)();

    expect(result.stored).toBe(1);
    expect(result.failedFeeds).toEqual([]);
    expect(result.anomalies.join(" ")).toContain("embed");
    store.close();
  });

  it("finishes the run even when a store read throws for one feed", async () => {
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    const store = openWatchlistStore(":memory:");
    const harness = makeHarness({
      watchlist: makeWatchlist([roche]),
      store,
      async rss() {
        return [];
      },
    });
    const realGetFeedState = store.getFeedState.bind(store);
    let firstRead = true;
    harness.deps.store = {
      ...store,
      getFeedState(feedId: string) {
        if (firstRead) {
          firstRead = false;
          throw new Error("database is locked");
        }
        return realGetFeedState(feedId);
      },
    };

    const result = await createIngestRun(harness.deps)();

    expect(result.failedFeeds).toEqual([feedIdFor(roche, rssFeed)]);
    expect(store.lastRun()?.finishedAt).not.toBeNull();
    store.close();
  });

  it("fails the feed, not the run, when the tagger throws", async () => {
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche]),
      async rss() {
        return [rawItem({ title: "Roche picks a cloud", url: "https://roche.com/a" })];
      },
      async tag() {
        throw new Error("model offline");
      },
    });

    const result = await harness.run();

    expect(result.stored).toBe(0);
    expect(result.failedFeeds).toEqual([feedIdFor(roche, rssFeed)]);
    expect(harness.store.getFeedState(feedIdFor(roche, rssFeed)).lastSeenAt).toBeNull();
    harness.store.close();
  });

  // Task 8 fix (c): startRun (and buildTasks/the initial log call) used to
  // sit outside the guarded try/finally, so a throw from either of them left
  // an unfinished `runs` row -- indistinguishable from a run still in
  // flight. deps.log is made to throw on its very first call (right after
  // buildTasks, before any per-feed work) to exercise exactly that window.
  it("still finishes the run row when the initial log call throws before the per-feed loop", async () => {
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [] });
    const harness = makeHarness({ watchlist: makeWatchlist([roche]) });
    harness.deps.log = () => {
      throw new Error("logger exploded");
    };

    await expect(createIngestRun(harness.deps)()).rejects.toThrow("logger exploded");

    const lastRun = harness.store.lastRun();
    expect(lastRun).not.toBeNull();
    expect(lastRun?.finishedAt).not.toBeNull();
    harness.store.close();
  });
});

// ---- R20: ir_page disabled by default in the nightly run -------------------

describe("R20: disabled feed kinds", () => {
  it("DISABLED_FEED_KINDS disables ir_page", () => {
    // Pinned so a future edit that quietly re-enables ir_page (or disables
    // something else instead) is caught here rather than only showing up as
    // the live run's noise coming back.
    expect(DISABLED_FEED_KINDS.has("ir_page")).toBe(true);
  });

  it("tags only the rss items when an entity has both an rss and an ir_page feed, reporting the ir_page as skipped rather than failed, and never calling the ir-page adapter", async () => {
    const rssFeed: Feed = { kind: "rss", url: "https://roche.com/feed.xml" };
    const irFeed: Feed = { kind: "ir_page", url: "https://roche.com/investors" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [rssFeed, irFeed] });
    const harness = makeHarness({
      watchlist: makeWatchlist([roche]),
      // No `disabledKinds` override: this is the real production default.
      async rss() {
        return [rawItem({ title: "Roche picks a cloud", url: "https://roche.com/a" })];
      },
      async irPage() {
        // If this were ever called it would report a broken-extraction
        // anomaly -- proving the assertions below aren't passing by luck.
        return { items: [], linksScanned: 50, datedLinks: 0 };
      },
    });

    const result = await harness.run();

    expect(result.tagged).toBe(1);
    expect(result.stored).toBe(1);
    expect(harness.irPageCalls).toEqual([]);
    expect(result.anomalies).toEqual([]);
    expect(result.failedFeeds).toEqual([]);
    expect(result.skippedKinds).toBe(1);

    const stored = harness.store.itemsInPeriod(ALL_TIME.from, ALL_TIME.to);
    expect(stored).toHaveLength(1);
    expect(stored[0].title).toBe("Roche picks a cloud");

    // The ir_page feed's own watermark must never move: buildTasks skipped
    // it entirely, so it was never fetched, let alone resolved.
    expect(harness.store.getFeedState(feedIdFor(roche, irFeed)).lastSeenAt).toBeNull();
    harness.store.close();
  });

  it("counts a skipped ir_page feed in the log line and IngestResult without touching fetched/deduped/tagged/stored/failedFeeds/anomalies", async () => {
    const irFeed: Feed = { kind: "ir_page", url: "https://roche.com/investors" };
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [irFeed] });
    const harness = makeHarness({ watchlist: makeWatchlist([roche]) });

    const result = await harness.run();

    expect(result.skippedKinds).toBe(1);
    expect(result.fetched).toBe(0);
    expect(result.deduped).toBe(0);
    expect(result.tagged).toBe(0);
    expect(result.stored).toBe(0);
    expect(result.failedFeeds).toEqual([]);
    expect(result.anomalies).toEqual([]);
    expect(harness.irPageCalls).toEqual([]);
    expect(harness.logs.some((line) => line.includes("skippedKinds"))).toBe(true);
    harness.store.close();
  });
});

describe("body persistence", () => {
  // The body is what a comparison question needs. It used to reach ChromaDB
  // and nowhere else, so a reindex -- which rebuilds from knowledge/ and
  // raw_documents/ only -- erased it with nothing on disk to restore it from.
  it("stores the fetched body alongside the item", async () => {
    const title = "Dell refreshes PowerStore";
    const body = "Dell said today that PowerStore Prime doubles mid-range throughput.";
    const dell = makeEntity({ id: "dell", name: "Dell", feeds: [{ kind: "rss", url: "https://dell.com/feed.xml" }] });
    const harness = makeHarness({
      watchlist: makeWatchlist([dell], []),
      async rss() {
        return [rawItem({ title, url: "https://dell.com/a", body })];
      },
    });

    await harness.run();

    expect(harness.store.findByHash(contentHash(title, body))?.body).toBe(body);
    harness.store.close();
  });
});
