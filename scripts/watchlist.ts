// Watchlist CLI.
// Usage:
//   npx tsx scripts/watchlist.ts verify-feeds
//   npx tsx scripts/watchlist.ts ingest [--limit N] [--since ISO] [--only id,id]
//   npx tsx scripts/watchlist.ts status [--days N]

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Entity, Feed, Watchlist } from "../src/services/watchlist-config.js";
import { loadWatchlist, THEATERS } from "../src/services/watchlist-config.js";
import {
  createFetch,
  DEFAULT_FEED_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  newsAdapter,
  rssAdapter,
  verifyFeed,
} from "../src/services/watchlist-sources.js";
import { edgarAdapter, irPageAdapter } from "../src/services/watchlist-edgar.js";
import { openWatchlistStore, type WatchlistStore } from "../src/services/watchlist-store.js";
import { createTagger } from "../src/services/watchlist-tagger.js";
import {
  createIngestRun,
  DEFAULT_INGEST_LIMIT,
  DISABLED_FEED_KINDS,
  isRunnableFeed,
  type IngestAdapters,
  type IngestDeps,
} from "../src/services/watchlist-ingest.js";
import { storeEvidence } from "../src/services/graph-evidence.js";
import { closeNeo4j, getDriver } from "../src/services/graph-store.js";
import { neo4jWriteTransaction, rebuildVendorGraph, type RebuildResult } from "../src/services/vendor-graph-rebuild.js";
import { getLlmClient } from "../src/services/llm-client.js";
import { addToChromaDB } from "../src/services/chromadb-store.js";

// R9: DEFAULT_USER_AGENT is honest about who we are, in the form sites'
// bot rules accept -- EDGAR's stricter declared-UA requirement is Task 5's
// concern, not this CLI's.
const USER_AGENT = DEFAULT_USER_AGENT;
// Shared with verifyFeed's own default (fix round 1) so the CLI and the
// library default don't drift apart as two separate "10 seconds" literals.
const FEED_TIMEOUT_MS = DEFAULT_FEED_TIMEOUT_MS;
const MAX_CONCURRENT_REQUESTS = 2;

// Raised for any CLI usage problem (a bad flag value, an --only naming an
// entity the watchlist doesn't know) -- always caught and printed as a
// one-line error rather than an uncaught-exception stack trace.
export class WatchlistCliError extends Error {}

// Runs fn over items with at most `limit` in flight at once, preserving no
// particular completion order (each call's own console.log is what matters,
// not the return value here).
async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const current = items[nextIndex];
      nextIndex += 1;
      await fn(current);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

interface FeedTask {
  entity: Entity;
  feed: Feed;
}

// Loads config/watchlist.yaml, verifies every listed feed (10s timeout each,
// at most 2 concurrent requests), and prints one result line per feed, then
// the config's notes (e.g. auto-created peers) so gaps stay visible.
async function verifyFeeds(): Promise<void> {
  const watchlist = loadWatchlist();
  const fetchImpl = createFetch({ userAgent: USER_AGENT, timeoutMs: FEED_TIMEOUT_MS });

  const tasks: FeedTask[] = [];
  for (const entity of watchlist.entities.values()) {
    for (const feed of entity.feeds) {
      tasks.push({ entity, feed });
    }
  }

  let failures = 0;

  await mapWithConcurrency(tasks, MAX_CONCURRENT_REQUESTS, async ({ entity, feed }) => {
    // verifyFeed only knows how to judge an RSS/Atom body. "edgar" (a CIK,
    // not a URL) and "ir_page" (an HTML landing page, not a feed) were
    // verified by other means during feed research (an EDGAR company_tickers
    // cross-check, a plain HTTP 200 check) -- running them through the RSS
    // parser would always report a spurious FAIL, not a real problem with the
    // recorded feed. EDGAR's own strict-UA verification is a later task's
    // concern (R9 discussion), not this command's.
    if (feed.kind !== "rss" && feed.kind !== "news") {
      console.log(`skip ${entity.id} ${feed.kind} verified separately during feed research, not RSS/Atom`);
      return;
    }
    let result = await verifyFeed(feed, fetchImpl);
    if (!result.ok && result.error === "HTTP 403") {
      // A couple of Q4-hosted IR platforms (ir.veeva.com, ir.schrodinger.com) have
      // been observed to 403 under this run's concurrent request pattern but pass
      // reliably in isolation or on an immediate retry -- a rate-limiting artifact,
      // not a dead feed. One retry after a short pause absorbs that without masking
      // a genuinely dead/blocked feed (which fails the same way again).
      await new Promise((resolve) => setTimeout(resolve, 2000));
      result = await verifyFeed(feed, fetchImpl);
    }
    if (result.ok) {
      console.log(`ok ${entity.id} ${feed.kind} ${result.items} newest=${result.newest}`);
    } else {
      failures += 1;
      console.log(`FAIL ${entity.id} ${feed.kind} ${result.error}`);
    }
  });

  if (watchlist.notes.length > 0) {
    console.log("");
    console.log("Notes:");
    for (const note of watchlist.notes) {
      console.log(`- ${note}`);
    }
  }

  if (tasks.length === 0) {
    console.log("No feeds configured yet.");
  }

  if (failures > 0) {
    process.exitCode = 1;
  }
}

// ---- `ingest` -----------------------------------------------------------

// Splits a comma-separated --only value into trimmed, non-empty entity ids.
// undefined (the flag was never given) is distinct from an empty list --
// callers use it to mean "every entity", never "none".
export function parseOnlyOption(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

// --only must reject an unknown entity id with a clear error rather than
// running zero feeds and reporting success -- a typo'd id would otherwise
// look, from the run's own output, exactly like "this entity had no news".
export function validateOnlyIds(only: string[] | undefined, watchlist: Watchlist): void {
  if (only === undefined) return;
  const unknown = only.filter((id) => !watchlist.entities.has(id));
  if (unknown.length > 0) {
    throw new WatchlistCliError(
      `--only names unknown entity id(s): ${unknown.join(", ")} (check config/watchlist.yaml)`,
    );
  }
}

export interface IngestArgs {
  limit?: number;
  since?: string;
  only?: string[];
}

export function parseIngestArgs(argv: string[]): IngestArgs {
  const args: IngestArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--limit") {
      const raw = argv[++i];
      const value = raw === undefined ? NaN : Number(raw);
      if (!Number.isInteger(value) || value <= 0) {
        throw new WatchlistCliError(`--limit must be a positive integer, got "${raw ?? ""}"`);
      }
      args.limit = value;
    } else if (flag === "--since") {
      const raw = argv[++i];
      if (raw === undefined || Number.isNaN(Date.parse(raw))) {
        throw new WatchlistCliError(`--since must be an ISO timestamp, got "${raw ?? ""}"`);
      }
      args.since = raw;
    } else if (flag === "--only") {
      args.only = parseOnlyOption(argv[++i]);
    } else {
      throw new WatchlistCliError(`unknown ingest option "${flag}"`);
    }
  }
  return args;
}

// The number of feeds this run will actually attempt, mirroring
// createIngestRun's own buildTasks (customers/peers/vendors filtered by
// --only, plus every topic query when --only is not given) exactly enough
// to tell "every feed failed" apart from "nothing was ever attempted".
// isRunnableFeed is imported from watchlist-ingest.ts rather than
// re-implemented here (fix round 1 duplicated this predicate and drifted
// from buildTasks' own copy) -- one predicate, used by both. R20: a
// DISABLED_FEED_KINDS feed is excluded here too, for the same reason --
// buildTasks never attempts it, so counting it here would make "every
// attempted feed failed" compare against a total that includes feeds that
// were never attempted.
export function countPlannedFeeds(watchlist: Watchlist, only: string[] | undefined): number {
  const wanted = only === undefined ? null : new Set(only);
  let total = 0;
  for (const id of watchlist.priority) {
    if (wanted !== null && !wanted.has(id)) continue;
    const entity = watchlist.entities.get(id);
    if (entity === undefined) continue;
    total += entity.feeds.filter((feed) => isRunnableFeed(feed) && !DISABLED_FEED_KINDS.has(feed.kind)).length;
  }
  if (wanted === null) total += watchlist.topics.length;
  return total;
}

export interface RunIngestDeps {
  watchlist: Watchlist;
  store: WatchlistStore;
  adapters: IngestAdapters;
  tag: IngestDeps["tag"];
  embed: IngestDeps["embed"];
  now(): Date;
  log(line: string): void;
  // Printed so it's always visible which stack tagged/embedded this run's
  // items -- see resolveStackName's comment on why this matters.
  stackName: string;
  edgarMinIntervalMs?: number;
  // Rebuilds the vendor graph from its sources, watchlist evidence included.
  // Optional so a caller that only wants the ingest can leave it out; the CLI
  // always binds it.
  rebuildGraph?: () => Promise<RebuildResult>;
}

// Runs one ingest pass with fully injected dependencies (real ones are
// wired by runIngestCli below) and returns a process exit code: 2 for a
// usage problem caught before anything ran, 1 when every attempted feed
// failed or the tagger failed, 3 when the ingest succeeded but the graph
// rebuild after it failed, 0 otherwise. Never throws for an ingest-side
// failure -- a failed feed is reported in the printed result, exactly like
// createIngestRun itself treats it as data, not an exception.
export async function runIngest(argv: string[], deps: RunIngestDeps): Promise<number> {
  let args: IngestArgs;
  try {
    args = parseIngestArgs(argv);
    validateOnlyIds(args.only, deps.watchlist);
  } catch (err) {
    deps.log(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  deps.log(`Using stack: ${deps.stackName}`);

  const totalFeeds = countPlannedFeeds(deps.watchlist, args.only);

  const run = createIngestRun({
    watchlist: deps.watchlist,
    store: deps.store,
    adapters: deps.adapters,
    tag: deps.tag,
    embed: deps.embed,
    now: deps.now,
    limit: args.limit ?? DEFAULT_INGEST_LIMIT,
    log: deps.log,
    edgarMinIntervalMs: deps.edgarMinIntervalMs,
  });

  const result = await run({ since: args.since, only: args.only });

  deps.log(
    `Ingest run #${result.runId}: fetched=${result.fetched} deduped=${result.deduped} tagged=${result.tagged} ` +
      `stored=${result.stored} skippedByCap=${result.skippedByCap} skippedByBudget=${result.skippedByBudget} ` +
      `taggerFailures=${result.taggerFailures} failedFeeds=${result.failedFeeds.length} ` +
      `anomalies=${result.anomalies.length}`,
  );
  if (result.failedFeeds.length > 0) {
    deps.log(`Failed feeds: ${result.failedFeeds.join(", ")}`);
  }
  for (const anomaly of result.anomalies) {
    deps.log(`Anomaly: ${anomaly}`);
  }

  // The graph's evidence mirrors watchlist.db, so it is rebuilt after every
  // pass that ran -- failed feeds included. A --only pass is a debugging run
  // over a few feeds and leaves the graph alone.
  let rebuildFailed = false;
  if (deps.rebuildGraph !== undefined && args.only === undefined) {
    try {
      const rebuilt = await deps.rebuildGraph();
      for (const line of rebuilt.lines) deps.log(line);
      deps.log(`Graph rebuilt: ${rebuilt.nodes} nodes, ${rebuilt.relationships} relationships`);
    } catch (err) {
      rebuildFailed = true;
      deps.log(`graph rebuild failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (totalFeeds > 0 && result.failedFeeds.length === totalFeeds) {
    deps.log(`Every feed failed (${totalFeeds}/${totalFeeds}) -- treating this run as a failure.`);
    return 1;
  }

  // I4: a dead model must not look like a quiet night. Only feeds that
  // actually had new items ever call the tagger, so a total tagging outage
  // typically fails a handful of feeds out of ~150 and would otherwise exit
  // 0 -- and the Hermes wrapper only speaks up on a non-zero exit. Any
  // tagger error at all is worth waking the owner for: the local model is
  // either down, out of memory or answering unparseable JSON, and every one
  // of those costs the whole night's tagging.
  if (result.taggerFailures > 0) {
    deps.log(
      `Tagging failed ${result.taggerFailures} time(s) -- the model is not answering, treating this run as a failure.`,
    );
    return 1;
  }

  // Ingest failures above keep priority. A rebuild failure alone gets its own
  // code so the Hermes wrapper (which reports any non-zero exit) says so.
  if (rebuildFailed) return 3;

  return 0;
}

// Resolves which LLM stack the CLI should tag/embed with. getLlmClient()
// (src/services/llm-client.ts) memoizes its client on first call and reads
// LLM_PROVIDER at that point, defaulting to Ollama's port when it is unset
// -- a shell that never exported it would silently talk to Ollama even
// while the live stack is MLX. data/run/active-stack (written by
// scripts/switch-stack.sh) is what actually records the running stack, so
// it is consulted whenever LLM_PROVIDER is not already set.
export async function resolveStackName(env: NodeJS.ProcessEnv, readActiveStackFile: () => Promise<string>): Promise<string> {
  const fromEnv = env.LLM_PROVIDER?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  try {
    const trimmed = (await readActiveStackFile()).trim();
    if (trimmed.length > 0) return trimmed;
  } catch {
    // No active-stack file yet (e.g. the stack was never switched): fall
    // back to the client's own default rather than failing the CLI over it.
  }
  return "ollama";
}

async function runIngestCli(argv: string[]): Promise<void> {
  const stackName = await resolveStackName(process.env, () =>
    readFile(join(process.cwd(), "data", "run", "active-stack"), "utf8"),
  );
  // Set before the first getLlmClient() call below, per resolveStackName's
  // comment: this is what makes the memoized client actually pick up the
  // resolved stack instead of getActiveStack()'s bare "ollama" default.
  process.env.LLM_PROVIDER = stackName;

  const watchlist = loadWatchlist();
  const store = openWatchlistStore();

  try {
    const llm = getLlmClient();
    const tag = createTagger({ chat: llm.chat.bind(llm), watchlist });

    const fetchImpl = createFetch({ userAgent: USER_AGENT, timeoutMs: FEED_TIMEOUT_MS });
    const adapterDeps = { fetchImpl, now: () => new Date(), userAgent: USER_AGENT };
    const adapters: IngestAdapters = {
      rss: rssAdapter(adapterDeps),
      news: newsAdapter(adapterDeps),
      edgar: edgarAdapter(adapterDeps),
      irPage: irPageAdapter(adapterDeps),
    };

    process.exitCode = await runIngest(argv, {
      watchlist,
      store,
      adapters,
      tag,
      embed: addToChromaDB,
      now: () => new Date(),
      log: (line) => console.log(line),
      stackName,
      // Reads evidence through the store this run already holds open.
      rebuildGraph: () =>
        rebuildVendorGraph({ root: process.cwd(), evidence: storeEvidence(store) }, neo4jWriteTransaction(getDriver())),
    });
  } finally {
    // An open driver keeps Node alive: the nightly Hermes job would never exit,
    // so Neo4j is closed even when closing the store throws.
    await closeAll([() => store.close(), () => closeNeo4j()]);
  }
}

/** Runs every closer, even past a failing one, then rethrows the first failure. */
export async function closeAll(closers: Array<() => unknown>): Promise<void> {
  let first: unknown = null;
  for (const close of closers) {
    try {
      await close();
    } catch (err) {
      first ??= err;
    }
  }
  if (first !== null) throw first;
}

// ---- `status` -------------------------------------------------------------

export const DEFAULT_STATUS_WINDOW_DAYS = 7;

export interface StatusArgs {
  days: number;
}

export function parseStatusArgs(argv: string[]): StatusArgs {
  let days = DEFAULT_STATUS_WINDOW_DAYS;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--days") {
      const raw = argv[++i];
      const value = raw === undefined ? NaN : Number(raw);
      if (!Number.isFinite(value) || value <= 0) {
        throw new WatchlistCliError(`--days must be a positive number, got "${raw ?? ""}"`);
      }
      days = value;
    } else {
      throw new WatchlistCliError(`unknown status option "${flag}"`);
    }
  }
  return { days };
}

export interface RunStatusDeps {
  store: WatchlistStore;
  watchlist: Watchlist;
  now(): Date;
  log(line: string): void;
}

// Prints the last recorded run's stats and per-entity item counts for a
// trailing window, entirely from the injected store -- no live DB, no
// network. Returns a process exit code (2 for a bad --days, 0 otherwise).
export function runStatus(argv: string[], deps: RunStatusDeps): number {
  let args: StatusArgs;
  try {
    args = parseStatusArgs(argv);
  } catch (err) {
    deps.log(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const to = deps.now();
  const from = new Date(to.getTime() - args.days * 24 * 60 * 60 * 1000);

  deps.log(`Watchlist status: last ${args.days}d (${from.toISOString()} to ${to.toISOString()})`);

  const lastRun = deps.store.lastRun();
  if (lastRun === null) {
    deps.log("No runs recorded yet.");
  } else {
    deps.log(
      `Last run #${lastRun.id}: started ${lastRun.startedAt}, finished ${lastRun.finishedAt ?? "in progress"} -- ` +
        `fetched=${lastRun.fetched} deduped=${lastRun.deduped} tagged=${lastRun.tagged} ` +
        `failedFeeds=${lastRun.failedFeeds} skippedByCap=${lastRun.skippedByCap} ` +
        `skippedByBudget=${lastRun.skippedByBudget} anomalies=${lastRun.anomalies}`,
    );
  }

  // Customers by headquarters theater, largest first (size ranks change yearly:
  // the year printed is the one stored in config/watchlist.yaml).
  const customers = [...deps.watchlist.entities.values()].filter((e) => e.kind === "customer" && e.theater !== undefined);
  if (customers.length > 0) {
    const year = customers.find((c) => c.size !== undefined)?.size?.year;
    deps.log(`Customers by theater (size rank${year !== undefined ? `, ${year}` : ""}):`);
    for (const theater of THEATERS) {
      const inTheater = customers
        .filter((c) => c.theater === theater)
        .sort((a, b) => (a.size?.rank ?? Infinity) - (b.size?.rank ?? Infinity));
      if (inTheater.length === 0) continue;
      const names = inTheater.map((c) => (c.size !== undefined ? `#${c.size.rank} ${c.name}` : c.name)).join(" · ");
      deps.log(`  ${theater} (${inTheater.length}): ${names}`);
    }
  }

  const counts = deps.store.countsByEntity(from.toISOString(), to.toISOString());
  if (counts.length === 0) {
    deps.log("No items in this window.");
    return 0;
  }

  const sorted = [...counts].sort(
    (a, b) => b.items - a.items || b.maxImportance - a.maxImportance || a.entityId.localeCompare(b.entityId),
  );
  for (const count of sorted) {
    const entity = deps.watchlist.entities.get(count.entityId);
    const name = entity?.name ?? count.entityId;
    deps.log(`${name} (${count.entityId}): items=${count.items} maxImportance=${count.maxImportance}`);
  }

  return 0;
}

function runStatusCli(argv: string[]): void {
  const watchlist = loadWatchlist();
  const store = openWatchlistStore();
  try {
    process.exitCode = runStatus(argv, {
      store,
      watchlist,
      now: () => new Date(),
      log: (line) => console.log(line),
    });
  } finally {
    store.close();
  }
}

// ---- entry point ------------------------------------------------------------

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "verify-feeds") {
    await verifyFeeds();
    return;
  }
  if (command === "ingest") {
    await runIngestCli(rest);
    return;
  }
  if (command === "status") {
    runStatusCli(rest);
    return;
  }

  console.error("Usage: watchlist.ts <verify-feeds | ingest [--limit N] [--since ISO] [--only id,id] | status [--days N]>");
  process.exit(1);
}

// Only run when this file is the process's actual entry point -- not when
// ts-jest imports it for its exported helpers (parseIngestArgs, runIngest,
// runStatus, ...), which must never trigger a real CLI invocation.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
