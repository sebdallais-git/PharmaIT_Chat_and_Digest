// Watchlist CLI tests (Task 8: `ingest` and `status`).
//
// Everything is injected: an in-memory store, fake adapters/tagger/embedder,
// a fixed clock and a captured log. No network, no ChromaDB, no local model,
// no data/watchlist.db, and `scripts/watchlist.ts ingest`/`status` are never
// invoked against the real config here -- that is the live run (Task 9).

import { describe, expect, it } from "@jest/globals";
import type { Entity, TopicQuery, Watchlist } from "../src/services/watchlist-config.js";
import type { IrPageResult } from "../src/services/watchlist-edgar.js";
import type { Tagging } from "../src/services/watchlist-tagger.js";
import { openWatchlistStore, type WatchlistStore } from "../src/services/watchlist-store.js";
import { DEFAULT_INGEST_LIMIT, type IngestAdapters } from "../src/services/watchlist-ingest.js";
import type { RebuildResult } from "../src/services/vendor-graph-rebuild.js";
import {
  DEFAULT_STATUS_WINDOW_DAYS,
  countPlannedFeeds,
  parseIngestArgs,
  parseOnlyOption,
  parseStatusArgs,
  resolveStackName,
  runIngest,
  runStatus,
  validateOnlyIds,
  WatchlistCliError,
  type RunIngestDeps,
} from "../scripts/watchlist.js";

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
    priority: entities.map((entity) => entity.id),
    notes: [],
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

const NOOP_ADAPTERS: IngestAdapters = {
  rss: async () => [],
  news: async () => [],
  edgar: async () => [],
  irPage: async (): Promise<IrPageResult> => ({ items: [], linksScanned: 0, datedLinks: 0 }),
};

// ---- parseOnlyOption / validateOnlyIds --------------------------------------

describe("parseOnlyOption", () => {
  it("returns undefined when --only was not given", () => {
    expect(parseOnlyOption(undefined)).toBeUndefined();
  });

  it("splits a comma list and trims whitespace", () => {
    expect(parseOnlyOption("roche, novartis,sandoz")).toEqual(["roche", "novartis", "sandoz"]);
  });

  it("drops empty entries from a trailing comma", () => {
    expect(parseOnlyOption("roche,")).toEqual(["roche"]);
  });
});

describe("validateOnlyIds", () => {
  const watchlist = makeWatchlist([makeEntity({ id: "roche" }), makeEntity({ id: "novartis" })]);

  it("does nothing when --only was not given", () => {
    expect(() => validateOnlyIds(undefined, watchlist)).not.toThrow();
  });

  it("accepts ids that are all known entities", () => {
    expect(() => validateOnlyIds(["roche", "novartis"], watchlist)).not.toThrow();
  });

  it("rejects an unknown entity id with a clear error rather than silently running zero feeds", () => {
    expect(() => validateOnlyIds(["roche", "not-a-real-entity"], watchlist)).toThrow(WatchlistCliError);
    expect(() => validateOnlyIds(["not-a-real-entity"], watchlist)).toThrow(/not-a-real-entity/);
  });
});

// ---- parseIngestArgs ---------------------------------------------------------

describe("parseIngestArgs", () => {
  it("defaults to no limit, no since, no only", () => {
    expect(parseIngestArgs([])).toEqual({});
  });

  it("parses --limit, --since and --only together", () => {
    expect(parseIngestArgs(["--limit", "10", "--since", "2026-09-01T00:00:00.000Z", "--only", "roche"])).toEqual({
      limit: 10,
      since: "2026-09-01T00:00:00.000Z",
      only: ["roche"],
    });
  });

  it("rejects a non-positive-integer --limit", () => {
    expect(() => parseIngestArgs(["--limit", "0"])).toThrow(WatchlistCliError);
    expect(() => parseIngestArgs(["--limit", "abc"])).toThrow(WatchlistCliError);
  });

  it("rejects an unparseable --since", () => {
    expect(() => parseIngestArgs(["--since", "not-a-date"])).toThrow(WatchlistCliError);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseIngestArgs(["--bogus"])).toThrow(WatchlistCliError);
  });
});

// ---- countPlannedFeeds --------------------------------------------------------

describe("countPlannedFeeds", () => {
  const roche = makeEntity({ id: "roche", feeds: [{ kind: "rss", url: "https://roche/a" }, { kind: "news", url: "roche news" }] });
  const novartis = makeEntity({ id: "novartis", feeds: [{ kind: "rss", url: "https://novartis/a" }] });
  const topics: TopicQuery[] = [{ query: "pharma ransomware", domains: ["cyber"] }];
  const watchlist = makeWatchlist([roche, novartis], topics);

  it("counts every entity's feeds plus topic queries when --only is not given", () => {
    expect(countPlannedFeeds(watchlist, undefined)).toBe(2 + 1 + 1);
  });

  it("counts only the named entities' feeds, excluding topics, when --only is given", () => {
    expect(countPlannedFeeds(watchlist, ["roche"])).toBe(2);
  });

  // Fix round 1, concern (2): buildTasks (watchlist-ingest.ts) never turns a
  // feed missing the field its kind fetches with into a task -- it logs
  // "skipping ... no url/cik" and moves on. countPlannedFeeds must agree,
  // or "every feed failed" could disagree with what actually ran.
  it("excludes a feed missing the field its kind needs (url for rss/news/ir_page, cik for edgar), exactly like buildTasks skips it", () => {
    const misconfigured = makeEntity({
      id: "misconfigured",
      feeds: [
        { kind: "rss", url: undefined },
        { kind: "news", url: undefined },
        { kind: "ir_page", url: undefined },
        { kind: "edgar", cik: undefined },
        { kind: "edgar", cik: "0001114448" },
      ],
    });

    expect(countPlannedFeeds(makeWatchlist([misconfigured]), undefined)).toBe(1);
  });

  // R20: a well-formed ir_page feed is still excluded, same as one missing
  // its url -- buildTasks never attempts either, so "every attempted feed
  // failed" must be computed against a total that leaves both out.
  it("excludes a well-formed ir_page feed, since R20 disables the kind at the run level", () => {
    const withIrPage = makeEntity({
      id: "roche",
      feeds: [
        { kind: "rss", url: "https://roche/a" },
        { kind: "ir_page", url: "https://roche/investors" },
      ],
    });

    expect(countPlannedFeeds(makeWatchlist([withIrPage]), undefined)).toBe(1);
  });
});

// ---- resolveStackName ---------------------------------------------------------

// Fix round 2 (Important): this is the one piece of new logic fixing a
// previously-observed production trap (the CLI silently talking to Ollama's
// port while the live stack was MLX) and it runs for real on the owner's
// machine, so it gets its own direct tests rather than only being exercised
// indirectly through runIngestCli. The file reader is always injected --
// never a real fs read -- so this never touches data/run/active-stack.
describe("resolveStackName", () => {
  it("uses LLM_PROVIDER as-is and never reads the file when it is set", async () => {
    let readCalls = 0;
    const readActiveStackFile = async () => {
      readCalls++;
      return "mlx";
    };

    const stack = await resolveStackName({ LLM_PROVIDER: "omlx" }, readActiveStackFile);

    expect(stack).toBe("omlx");
    expect(readCalls).toBe(0);
  });

  it("falls back to the trimmed file contents when LLM_PROVIDER is unset", async () => {
    // Trailing newline/whitespace is exactly what `cat data/run/active-stack`
    // or a hand-edited file would produce -- must not leak into the stack name.
    const stack = await resolveStackName({}, async () => "  mlx\n");

    expect(stack).toBe("mlx");
  });

  it('falls back to "ollama" when LLM_PROVIDER is unset and the file read rejects', async () => {
    const stack = await resolveStackName({}, async () => {
      throw new Error("ENOENT: no such file or directory");
    });

    expect(stack).toBe("ollama");
  });

  it("treats a whitespace-only LLM_PROVIDER as unset and falls back to the file", async () => {
    const stack = await resolveStackName({ LLM_PROVIDER: "   " }, async () => "mlx");

    expect(stack).toBe("mlx");
  });
});

// ---- runIngest ----------------------------------------------------------------

interface IngestHarness {
  store: WatchlistStore;
  logs: string[];
  rssCalls: number;
  run(argv: string[]): Promise<number>;
}

function makeIngestHarness(options: {
  watchlist: Watchlist;
  rss?: IngestAdapters["rss"];
  tag?: RunIngestDeps["tag"];
  rebuildGraph?: RunIngestDeps["rebuildGraph"];
}): IngestHarness {
  const store = openWatchlistStore(":memory:");
  const logs: string[] = [];
  let rssCalls = 0;

  const adapters: IngestAdapters = {
    ...NOOP_ADAPTERS,
    rss: async (feed, entity, since) => {
      rssCalls++;
      return options.rss !== undefined ? await options.rss(feed, entity, since) : [];
    },
  };

  return {
    store,
    logs,
    get rssCalls() {
      return rssCalls;
    },
    run: (argv) =>
      runIngest(argv, {
        watchlist: options.watchlist,
        store,
        adapters,
        tag: options.tag ?? (async () => defaultTagging),
        embed: async (texts) => texts.length,
        now: () => new Date("2026-09-20T02:30:00.000Z"),
        log: (line) => logs.push(line),
        stackName: "mlx",
        rebuildGraph: options.rebuildGraph,
      }),
  };
}

describe("runIngest", () => {
  it("wires the injected store/adapters/tagger/embedder, prints the stack and the result, and exits 0 on success", async () => {
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [{ kind: "rss", url: "https://roche/feed.xml" }] });
    const harness = makeIngestHarness({
      watchlist: makeWatchlist([roche]),
      rss: async () => [
        {
          title: "Roche picks a cloud",
          url: "https://roche/a",
          publishedAt: "2026-09-19T00:00:00.000Z",
          body: "body",
          sourceKind: "rss",
          sourceName: "Roche",
          titleKey: "roche picks a cloud",
        },
      ],
    });

    const exitCode = await harness.run([]);

    expect(exitCode).toBe(0);
    expect(harness.rssCalls).toBe(1);
    expect(harness.logs.some((line) => line.includes("Using stack: mlx"))).toBe(true);
    expect(harness.logs.some((line) => line.includes("stored=1"))).toBe(true);
    harness.store.close();
  });

  it("rejects an unknown --only id without invoking any adapter", async () => {
    const roche = makeEntity({ id: "roche", feeds: [{ kind: "rss", url: "https://roche/feed.xml" }] });
    const harness = makeIngestHarness({ watchlist: makeWatchlist([roche]) });

    const exitCode = await harness.run(["--only", "not-a-real-entity"]);

    expect(exitCode).not.toBe(0);
    expect(harness.rssCalls).toBe(0);
    expect(harness.logs.some((line) => line.includes("not-a-real-entity"))).toBe(true);
    harness.store.close();
  });

  it("exits non-zero when every attempted feed fails", async () => {
    const roche = makeEntity({ id: "roche", feeds: [{ kind: "rss", url: "https://roche/feed.xml" }] });
    const harness = makeIngestHarness({
      watchlist: makeWatchlist([roche]),
      rss: async () => {
        throw new Error("connection refused");
      },
    });

    const exitCode = await harness.run([]);

    expect(exitCode).not.toBe(0);
    harness.store.close();
  });

  it("exits 0 when some, but not all, feeds fail", async () => {
    const roche = makeEntity({ id: "roche", feeds: [{ kind: "rss", url: "https://roche/feed.xml" }] });
    const novartis = makeEntity({ id: "novartis", feeds: [{ kind: "rss", url: "https://novartis/feed.xml" }] });
    let call = 0;
    const harness = makeIngestHarness({
      watchlist: makeWatchlist([roche, novartis]),
      rss: async () => {
        call++;
        if (call === 1) throw new Error("connection refused");
        return [];
      },
    });

    const exitCode = await harness.run([]);

    expect(exitCode).toBe(0);
    harness.store.close();
  });

  // I4: a feed that fetches fine and yields nothing new never calls the
  // tagger, so a total tagging outage fails only the few feeds that DID have
  // items -- never all of them. Under the old "every feed failed" rule the
  // run exited 0 and the Hermes wrapper, which speaks up only on a non-zero
  // exit, stayed silent all night.
  it("exits non-zero when the tagger fails, even though most feeds succeeded", async () => {
    const roche = makeEntity({ id: "roche", name: "Roche", feeds: [{ kind: "rss", url: "https://roche/feed.xml" }] });
    const quiet = makeEntity({ id: "novartis", feeds: [{ kind: "rss", url: "https://novartis/feed.xml" }] });
    const harness = makeIngestHarness({
      watchlist: makeWatchlist([roche, quiet]),
      rss: async (_feed, entity) =>
        entity.id === "roche"
          ? [
              {
                title: "Roche picks a cloud",
                url: "https://roche/a",
                publishedAt: "2026-09-19T00:00:00.000Z",
                body: "body",
                sourceKind: "rss",
                sourceName: "Roche",
                titleKey: "roche picks a cloud",
              },
            ]
          : [],
      tag: async () => {
        throw new Error("model is not answering");
      },
    });

    const exitCode = await harness.run([]);

    expect(exitCode).toBe(1);
    expect(harness.logs.some((line) => line.includes("taggerFailures=1"))).toBe(true);
    expect(harness.logs.some((line) => line.includes("the model is not answering"))).toBe(true);
    harness.store.close();
  });

  it("passes --limit and --since through to the ingest run", async () => {
    const roche = makeEntity({ id: "roche", feeds: [{ kind: "rss", url: "https://roche/feed.xml" }] });
    const sinceSeen: Array<string | null> = [];
    const harness = makeIngestHarness({
      watchlist: makeWatchlist([roche]),
      rss: async (_feed, _entity, since) => {
        sinceSeen.push(since);
        return [];
      },
    });

    await harness.run(["--since", "2026-09-10T00:00:00.000Z", "--limit", "5"]);

    expect(sinceSeen).toEqual(["2026-09-10T00:00:00.000Z"]);
    harness.store.close();
  });

  it("defaults the ingest limit to DEFAULT_INGEST_LIMIT when --limit is not given", () => {
    // Documents the contract runIngest relies on rather than re-deriving it.
    expect(DEFAULT_INGEST_LIMIT).toBeGreaterThan(0);
  });
});

// ---- runStatus ------------------------------------------------------------

function baseItem(over: Partial<Parameters<WatchlistStore["insertItem"]>[0]> = {}) {
  return {
    urlCanonical: over.urlCanonical ?? "https://a/1",
    contentHash: over.contentHash ?? "h1",
    sourceKind: over.sourceKind ?? "rss",
    sourceName: over.sourceName ?? "fixture",
    title: over.title ?? "t",
    summary: over.summary ?? "s",
    signal: over.signal ?? "it_move",
    importance: over.importance ?? 3,
    publishedAt: over.publishedAt ?? "2026-09-18T00:00:00.000Z",
    fetchedAt: over.fetchedAt ?? "2026-09-19T00:00:00.000Z",
    entities: over.entities ?? ["roche"],
    domains: over.domains ?? ["cloud"],
  };
}

describe("runIngest — graph rebuild", () => {
  const roche = makeEntity({ id: "roche", feeds: [{ kind: "rss", url: "https://roche/feed.xml" }] });
  const rebuilt: RebuildResult = { nodes: 12, relationships: 30, lines: ["watchlist.db                 -> 4 evidence for 2 vendors/accounts, 0 future-dated skipped"] };

  function counting(result: () => Promise<RebuildResult>): { fn: () => Promise<RebuildResult>; calls: () => number } {
    let calls = 0;
    return {
      fn: () => {
        calls++;
        return result();
      },
      calls: () => calls,
    };
  }

  it("rebuilds the graph after a pass and logs the report", async () => {
    const rebuild = counting(async () => rebuilt);
    const harness = makeIngestHarness({ watchlist: makeWatchlist([roche]), rebuildGraph: rebuild.fn });
    expect(await harness.run([])).toBe(0);
    expect(rebuild.calls()).toBe(1);
    expect(harness.logs).toContain("Graph rebuilt: 12 nodes, 30 relationships");
    expect(harness.logs).toContain(rebuilt.lines[0]);
    harness.store.close();
  });

  it("exits 3 when the ingest succeeded but the rebuild failed", async () => {
    const harness = makeIngestHarness({
      watchlist: makeWatchlist([roche]),
      rebuildGraph: async () => {
        throw new Error("Neo4j unreachable");
      },
    });
    expect(await harness.run([])).toBe(3);
    expect(harness.logs[harness.logs.length - 1]).toBe("graph rebuild failed: Neo4j unreachable");
    harness.store.close();
  });

  it("keeps exit 1 for a failed ingest whatever the rebuild did", async () => {
    const harness = makeIngestHarness({
      watchlist: makeWatchlist([roche]),
      rss: async () => {
        throw new Error("connection refused");
      },
      rebuildGraph: async () => {
        throw new Error("Neo4j unreachable");
      },
    });
    expect(await harness.run([])).toBe(1);
    harness.store.close();
  });

  it("still rebuilds after a pass with failed feeds", async () => {
    const rebuild = counting(async () => rebuilt);
    const harness = makeIngestHarness({
      watchlist: makeWatchlist([roche]),
      rss: async () => {
        throw new Error("connection refused");
      },
      rebuildGraph: rebuild.fn,
    });
    await harness.run([]);
    expect(rebuild.calls()).toBe(1);
    harness.store.close();
  });

  it("does not rebuild on a usage error or a --only debugging pass", async () => {
    const rebuild = counting(async () => rebuilt);
    const harness = makeIngestHarness({ watchlist: makeWatchlist([roche]), rebuildGraph: rebuild.fn });
    expect(await harness.run(["--only", "not-a-real-entity"])).toBe(2);
    expect(await harness.run(["--only", "roche"])).toBe(0);
    expect(rebuild.calls()).toBe(0);
    harness.store.close();
  });
});

describe("parseStatusArgs", () => {
  it("defaults to DEFAULT_STATUS_WINDOW_DAYS", () => {
    expect(parseStatusArgs([])).toEqual({ days: DEFAULT_STATUS_WINDOW_DAYS });
  });

  it("parses --days", () => {
    expect(parseStatusArgs(["--days", "14"])).toEqual({ days: 14 });
  });

  it("rejects a non-positive --days", () => {
    expect(() => parseStatusArgs(["--days", "0"])).toThrow(WatchlistCliError);
    expect(() => parseStatusArgs(["--days", "nope"])).toThrow(WatchlistCliError);
  });
});

describe("runStatus", () => {
  it("prints per-entity counts for the window from the injected store", () => {
    const store = openWatchlistStore(":memory:");
    store.insertItem(baseItem({ urlCanonical: "u1", contentHash: "c1", entities: ["roche"], importance: 2 }));
    store.insertItem(baseItem({ urlCanonical: "u2", contentHash: "c2", entities: ["roche", "aws"], importance: 5 }));
    // Outside the 7-day window ending at "now" below.
    store.insertItem(
      baseItem({ urlCanonical: "u3", contentHash: "c3", entities: ["novartis"], publishedAt: "2026-01-01T00:00:00.000Z" }),
    );

    const logs: string[] = [];
    const watchlist = makeWatchlist([makeEntity({ id: "roche", name: "Roche" }), makeEntity({ id: "aws", name: "AWS" })]);

    const exitCode = runStatus([], {
      store,
      watchlist,
      now: () => new Date("2026-09-20T00:00:00.000Z"),
      log: (line) => logs.push(line),
    });

    expect(exitCode).toBe(0);
    expect(logs.some((line) => line.includes("Roche") && line.includes("items=2"))).toBe(true);
    expect(logs.some((line) => line.includes("AWS") && line.includes("items=1"))).toBe(true);
    expect(logs.some((line) => line.includes("novartis"))).toBe(false);
    store.close();
  });

  it("reports no runs recorded when the store has never finished a run", () => {
    const store = openWatchlistStore(":memory:");
    const logs: string[] = [];

    runStatus([], {
      store,
      watchlist: makeWatchlist([]),
      now: () => new Date("2026-09-20T00:00:00.000Z"),
      log: (line) => logs.push(line),
    });

    expect(logs.some((line) => line.includes("No runs recorded yet"))).toBe(true);
    store.close();
  });

  it("reports the last run's stats when one has finished", () => {
    const store = openWatchlistStore(":memory:");
    const runId = store.startRun("2026-09-19T02:30:00.000Z");
    store.finishRun(runId, "2026-09-19T02:45:00.000Z", {
      fetched: 10,
      deduped: 2,
      tagged: 8,
      failedFeeds: 0,
      skippedByCap: 0,
      skippedByBudget: 0,
      anomalies: 0,
    });
    const logs: string[] = [];

    runStatus([], {
      store,
      watchlist: makeWatchlist([]),
      now: () => new Date("2026-09-20T00:00:00.000Z"),
      log: (line) => logs.push(line),
    });

    expect(logs.some((line) => line.includes(`#${runId}`) && line.includes("fetched=10"))).toBe(true);
    store.close();
  });

  it("says so when there are no items in the window", () => {
    const store = openWatchlistStore(":memory:");
    const logs: string[] = [];

    runStatus([], {
      store,
      watchlist: makeWatchlist([]),
      now: () => new Date("2026-09-20T00:00:00.000Z"),
      log: (line) => logs.push(line),
    });

    expect(logs.some((line) => line.includes("No items in this window"))).toBe(true);
    store.close();
  });

  it("rejects a bad --days without touching the store", () => {
    const store = openWatchlistStore(":memory:");
    const logs: string[] = [];

    const exitCode = runStatus(["--days", "-1"], {
      store,
      watchlist: makeWatchlist([]),
      now: () => new Date("2026-09-20T00:00:00.000Z"),
      log: (line) => logs.push(line),
    });

    expect(exitCode).not.toBe(0);
    expect(logs.some((line) => line.includes("--days"))).toBe(true);
    store.close();
  });
});
