// Watchlist ingest orchestrator.
//
// The nightly run: walk every watched entity's feeds in watchlist priority
// order (customers -> peers -> vendors, then the entity-less topic queries),
// fetch what is new since each feed's own watermark, collapse the same story
// seen through several sources into ONE item, tag the survivors with the
// local model, store them and embed them.
//
// Three properties drive the whole design:
//
//  1. Dedupe happens BEFORE the model (R13/R15). The same release legitimately
//     arrives via a company's IR RSS, via Google News and via EDGAR; tagging it
//     three times would triple the run's cost for nothing. Every duplicate is
//     resolved with store lookups alone and recorded with addSource().
//  2. Tagging is sequential. The local model serves one request at a time, so
//     there is no concurrency here to win anything -- only to queue behind
//     itself and blow the run's time budget.
//  3. A feed never takes the run down with it. Any adapter/tagger/store error
//     is caught per feed: the failure is recorded, the feed's watermark is NOT
//     advanced (so the next run re-fetches what this one missed) and the run
//     moves on to the next feed.
//
// Everything external is injected through IngestDeps -- adapters, the tagger,
// the ChromaDB writer, the clock. This module imports no transport and no
// chromadb-store, which is what lets the whole orchestrator be tested without
// a network, a model or a live collection.

import { watchlistDate } from "./chunk-date.js";
import type { Entity, Feed, Watchlist } from "./watchlist-config.js";
import { canonicalUrl, contentHash, type RawItem } from "./watchlist-sources.js";
import type { IrPageResult } from "./watchlist-edgar.js";
import type { Tagging } from "./watchlist-tagger.js";
import type { WatchlistStore } from "./watchlist-store.js";

// ---- tuning constants -------------------------------------------------------

// R17: the SEC allows 10 requests/second across all of EDGAR and the config
// holds ~46 CIKs. ONE gate in this module covers every EDGAR call in a run;
// no other source is subject to it.
export const EDGAR_MIN_INTERVAL_MS = 100;

// Default items tagged+stored per run. Everything past it is counted in
// skippedByCap, never silently dropped.
export const DEFAULT_INGEST_LIMIT = 250;

// C1: a wall-clock budget for the whole run, checked before each new item's
// tagging. Measured tagging cost is 15-23 s/item, so the 250-item cap alone
// is 64-104 minutes of model time -- comfortably past Hermes' no-agent
// script timeout (cron.script_timeout_seconds, 3600 s by default), which
// SIGTERMs then SIGKILLs the whole process group. A killed process never
// reaches the `finally` below, so finishRun never fires, the `runs` row
// stays unfinished and the job alerts every night. Stopping ourselves first
// turns "killed mid-run" into "a normal run that deferred the tail": the
// deferred items are counted, the watermarks stay behind them, and the next
// run picks them up. 45 minutes leaves the external timeout far above our
// own deadline plus the fetching either side of it.
export const DEFAULT_INGEST_BUDGET_MS = 45 * 60 * 1000;

// I1: the spec's first-run backfill. `options.since ?? state.lastSeenAt` is
// null for a feed that has never been seen, which asks every adapter for its
// entire history -- unbounded, and on the very first production run that is
// every feed at once. The spec fixes the window at 30 days; exported so
// Task 9 can tune it from the live run's numbers.
export const FIRST_RUN_BACKFILL_DAYS = 30;
export const FIRST_RUN_BACKFILL_MS = FIRST_RUN_BACKFILL_DAYS * 24 * 60 * 60 * 1000;

// R13/R15: the title-key dedupe only looks this far either side of an item's
// published-at. A title key is a weak key (it strips punctuation and a
// trailing dash clause), so matching it across an unbounded history would
// collapse, say, two years of identically-titled "Q3 results" filings.
export const TITLE_KEY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

// Keeps the tagging prompt short with ~71 entities in the watchlist: only a
// handful of candidates ever reach the model.
export const MAX_CANDIDATE_IDS = 8;

// R20: the live backfill showed ir_page scanning hundreds of links per
// entity and recognising zero dates on 14 of 29 pages (astrazeneca 569/0,
// samsung-bioepis 344/0, gsk 289/0, hikma 266/0, sun-pharma 181/0, ...),
// plus 8 more failing outright (403s, timeouts) -- for 4 of the run's 203
// stored items total. Recurring noise at that scale from a broken
// date-extraction heuristic masks genuinely new failures elsewhere, so the
// kind is disabled at the RUN level, not removed from the config: every
// ir_page feed and the research behind its URL stays in
// config/watchlist.yaml for Phase 2, which fixes the date extraction and
// re-enables the kind by deleting it from this one set.
export const DISABLED_FEED_KINDS: ReadonlySet<Feed["kind"]> = new Set(["ir_page"]);

// R-candidates: an alias shorter than this is ignored when scanning an item's
// text ("GNE", "AG", "SA" match far too much). An entity's canonical NAME is
// always matched, however short -- "SAP", "AWS" and "IBM" are real names we
// must not lose.
export const MIN_ALIAS_LENGTH = 4;

// ---- public types -----------------------------------------------------------

export interface IngestAdapters {
  rss(feed: Feed, entity: Entity, since: string | null): Promise<RawItem[]>;
  news(query: string, since: string | null): Promise<RawItem[]>;
  edgar(cik: string, entity: Entity, since: string | null): Promise<RawItem[]>;
  // Returns the adapter's full IrPageResult, not a bare RawItem[] (R16): the
  // orchestrator needs linksScanned/datedLinks to tell a broken extraction
  // heuristic apart from a genuinely quiet page.
  irPage(url: string, entity: Entity, since: string | null): Promise<IrPageResult>;
}

export interface IngestDeps {
  watchlist: Watchlist;
  store: WatchlistStore;
  adapters: IngestAdapters;
  tag(item: RawItem, candidateIds: string[]): Promise<Tagging>;
  // The ChromaDB writer (src/services/chromadb-store.ts's addToChromaDB),
  // injected so no test can ever reach a live collection from here.
  embed(texts: string[], metadatas: Record<string, unknown>[]): Promise<number>;
  now(): Date;
  limit: number;
  log(line: string): void;
  // R17's gate interval, overridable only so tests can pace three calls in
  // milliseconds instead of hundreds. Defaults to EDGAR_MIN_INTERVAL_MS.
  edgarMinIntervalMs?: number;
  // C1's wall-clock budget for the whole run. Defaults to
  // DEFAULT_INGEST_BUDGET_MS; a non-positive value means "unset", like
  // `limit`. Measured with deps.now() rather than Date.now() -- unlike the
  // EDGAR gate (which paces real outbound requests against the SEC's real
  // rate limit and must stay on a real clock), this deadline only decides
  // how much of OUR work to do, so an injected clock is exactly right and
  // lets a test spend an hour of budget in a millisecond.
  budgetMs?: number;
  // R20: feed kinds excluded from this run's task list entirely -- never
  // fetched, never counted as failed or anomalous. Defaults to
  // DISABLED_FEED_KINDS; overridable only so tests can exercise a disabled
  // kind's own logic (e.g. the ir_page R16 anomaly check) without flipping
  // the production default.
  disabledKinds?: ReadonlySet<Feed["kind"]>;
  // Pause before retrying a refused feed (see fetchWithRetry). Defaults to
  // REFUSED_FEED_RETRY_DELAY_MS; tests set 0.
  retryDelayMs?: number;
}

export interface IngestResult {
  fetched: number;
  deduped: number;
  tagged: number;
  stored: number;
  skippedByCap: number;
  // C1: items fetched but left untagged because the run's wall-clock budget
  // ran out. Deferred exactly like a capped item -- counted, never silently
  // dropped, and the feed's watermark stays strictly behind them.
  skippedByBudget: number;
  // I4: tagger calls that threw. A feed whose fetch works but whose tagging
  // fails is NOT the same as a quiet feed, and "every feed failed" cannot
  // see the difference: a feed that fetched fine and had nothing new never
  // calls the tagger at all, so a dead model can otherwise look exactly like
  // a quiet night and exit 0.
  taggerFailures: number;
  failedFeeds: string[];
  // R20: feed instances excluded by disabledKinds before they were ever
  // fetched -- not a failure, not an anomaly, not a success. Kept separate
  // so the run's numbers still add up honestly (fetched+skippedKinds+... is
  // the true count of every feed the config lists for this run).
  skippedKinds: number;
  // R16: things that are not failures but are not normal either -- an IR page
  // whose links yielded no recognizable date, an embedding write that did not
  // land. Kept separate from failedFeeds because they do not stop a feed from
  // advancing its watermark.
  anomalies: string[];
  runId: number;
}

export interface IngestOptions {
  since?: string;
  only?: string[];
}

// ---- feed identity ----------------------------------------------------------

// A feed's stable id in feed_state. Includes the entity so two entities
// sharing a URL (a joint newsroom) keep separate watermarks, and the kind so
// an entity's EDGAR and IR-page feeds never collide.
export function feedIdFor(entity: Entity, feed: Feed): string {
  return `${entity.id}:${feed.kind}:${feed.url ?? feed.cik ?? ""}`;
}

// Topic queries have no entity of their own; their watermark is keyed by the
// query text.
export function topicFeedId(query: string): string {
  return `topic:${query}`;
}

// A feed only ever becomes a task in buildTasks below when it carries the
// field its kind actually fetches with: url for rss/ir_page/news, cik for
// edgar. Exported so scripts/watchlist.ts's countPlannedFeeds (used to tell
// "every feed failed" apart from "nothing was ever attempted") uses this
// exact same predicate rather than its own copy -- two copies of "which
// feeds count" is exactly the drift that produced a counting bug once
// already (fix round 1).
//
// The type predicate narrows both `url` and `cik` to `string` at once: a
// convenience for buildTasks's per-kind branches below, each of which only
// ever reads the one field its own kind actually has.
export function isRunnableFeed(feed: Feed): feed is Feed & { url: string; cik: string } {
  return feed.kind === "edgar" ? feed.cik !== undefined : feed.url !== undefined;
}

// ---- EDGAR rate limiter (R17) -----------------------------------------------

// A minimum-interval gate: every call returns no sooner than minIntervalMs
// after the previous one was admitted. The reservation (`next`) is taken
// synchronously, so the gate still paces correctly if a future version fetches
// feeds concurrently.
//
// It reads Date.now() rather than deps.now() on purpose: this paces real
// outbound requests against the SEC's real rate limit, and a test's frozen
// clock must not be able to turn the gate off.
export interface GateClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const realClock: GateClock = {
  now: () => Date.now(),
  // Deliberately NOT unref'd: the run is awaiting this timer. If it were
  // the only ref'd handle left, the event loop would drain, the process
  // would exit mid-run before finishRun, and cron would see exit 0.
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

// `clock` exists for tests of the gate itself; the ingest always uses the real one.
export function createMinIntervalGate(minIntervalMs: number, clock: GateClock = realClock): () => Promise<void> {
  let next = 0;
  return async () => {
    const admitAt = Math.max(clock.now(), next);
    next = admitAt + minIntervalMs;
    // Node starts timers from libuv's cached loop time, which lags Date.now()
    // after synchronous work, so one sleep can wake early. Check the clock and
    // sleep off the remainder until the admission time has really passed.
    for (let waitMs = admitAt - clock.now(); waitMs > 0; waitMs = admitAt - clock.now()) {
      await clock.sleep(waitMs);
    }
  };
}

// ---- candidate entities -----------------------------------------------------

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Word-boundary match that also works either side of a non-ASCII letter (\b is
// defined on \w, which is ASCII-only): "SAP" must not match inside "Asaptic",
// and "Bayer" must not match inside "Bayerische".
function mentions(haystack: string, term: string): boolean {
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, "iu");
  return pattern.test(haystack);
}

// The candidate list Task 6's tagger prompts with: the feed's own entity (an
// item pulled from Roche's newsroom is about Roche by construction), plus
// every entity whose name or a long-enough alias literally appears in the
// item's title or body. Deliberately small -- it exists to keep the prompt
// short, not to pre-tag the item.
export function computeCandidateIds(item: RawItem, watchlist: Watchlist, feedEntityId: string | null): string[] {
  const ids: string[] = [];
  if (feedEntityId !== null && watchlist.entities.has(feedEntityId)) {
    ids.push(feedEntityId);
  }

  const haystack = `${item.title}\n${item.body}`;
  for (const entity of watchlist.entities.values()) {
    if (ids.includes(entity.id)) continue;
    if (ids.length >= MAX_CANDIDATE_IDS) break;

    const terms = [entity.name, ...entity.aliases.filter((alias) => alias.length >= MIN_ALIAS_LENGTH)];
    if (terms.some((term) => term.length > 0 && mentions(haystack, term))) {
      ids.push(entity.id);
    }
  }

  return ids;
}

// ---- internal task shape ----------------------------------------------------

interface FetchOutcome {
  items: RawItem[];
  anomaly?: string;
}

interface FeedTask {
  feedId: string;
  entity: Entity | null;
  // Human-readable label for logs (never a raw URL with a tracking query).
  label: string;
  fetch(since: string | null): Promise<FetchOutcome>;
}

// ---- the run ----------------------------------------------------------------

// Q4-hosted IR feeds (ir.veeva.com, ir.schrodinger.com) refuse about every
// other request with a 403, whatever the pause: measured 2026-09-30, one retry
// rescued 5 of 6 attempts and a second covers the rest. Before this the ingest
// never retried and failed both feeds every night from 2026-09-20, while
// verify-feeds (which retried once) kept reporting them ok. Only "refused"
// statuses are retried: a 404, a 5xx or a timeout fails the same way again.
const REFUSED_FEED_RETRY_DELAY_MS = 2000;
const REFUSED_FEED_RETRIES = 2;
const REFUSED_STATUS = /HTTP (403|429)$/;

async function fetchWithRetry<T>(
  fetchOnce: () => Promise<T>,
  label: string,
  deps: Pick<IngestDeps, "log" | "retryDelayMs">,
): Promise<T> {
  const delayMs = deps.retryDelayMs ?? REFUSED_FEED_RETRY_DELAY_MS;
  for (let retry = 0; ; retry += 1) {
    try {
      return await fetchOnce();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.match(REFUSED_STATUS)?.[0];
      if (status === undefined || retry >= REFUSED_FEED_RETRIES) throw err;
      deps.log(`${label}: retrying after ${status} (${retry + 1}/${REFUSED_FEED_RETRIES})`);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export function createIngestRun(deps: IngestDeps): (options?: IngestOptions) => Promise<IngestResult> {
  const limit = deps.limit > 0 ? deps.limit : DEFAULT_INGEST_LIMIT;
  // `?? EDGAR_MIN_INTERVAL_MS` alone would let 0 through (0 is not nullish)
  // and silently switch the SEC's rate limit off. Non-positive means
  // "unset", exactly like `limit` above.
  const edgarInterval = deps.edgarMinIntervalMs;
  const edgarGate = createMinIntervalGate(
    edgarInterval !== undefined && edgarInterval > 0 ? edgarInterval : EDGAR_MIN_INTERVAL_MS,
  );
  // Same "non-positive means unset" rule as `limit` and the EDGAR interval.
  const budgetMs = deps.budgetMs !== undefined && deps.budgetMs > 0 ? deps.budgetMs : DEFAULT_INGEST_BUDGET_MS;
  const disabledKinds = deps.disabledKinds ?? DISABLED_FEED_KINDS;

  // R20: buildTasks also reports how many feed instances it left out because
  // their kind is disabled, broken down by kind so the run's log line and
  // IngestResult can say honestly what was skipped and why.
  interface BuiltTasks {
    tasks: FeedTask[];
    skippedKinds: number;
    skippedKindCounts: Partial<Record<Feed["kind"], number>>;
  }

  function buildTasks(only: string[] | undefined): BuiltTasks {
    const wanted = only === undefined ? null : new Set(only);
    const tasks: FeedTask[] = [];
    const skippedKindCounts: Partial<Record<Feed["kind"], number>> = {};

    // watchlist.priority is already customers -> peers -> vendors, which is
    // exactly the order the cap must consume (a customer's news outranks a
    // vendor's press release).
    for (const entityId of deps.watchlist.priority) {
      const entity = deps.watchlist.entities.get(entityId);
      if (entity === undefined) continue;
      if (wanted !== null && !wanted.has(entityId)) continue;

      for (const feed of entity.feeds) {
        const feedId = feedIdFor(entity, feed);
        const label = `${entity.name} (${feed.kind})`;

        // R20: a disabled kind is skipped before the config-completeness
        // check below -- it is never attempted regardless of whether it is
        // otherwise well-formed, and it must never be counted as a failure,
        // an anomaly or a success.
        if (disabledKinds.has(feed.kind)) {
          skippedKindCounts[feed.kind] = (skippedKindCounts[feed.kind] ?? 0) + 1;
          continue;
        }

        if (!isRunnableFeed(feed)) {
          const missingField = feed.kind === "edgar" ? "cik" : feed.kind === "news" ? "query" : "url";
          deps.log(`skipping ${label}: no ${missingField}`);
          continue;
        }

        if (feed.kind === "rss") {
          tasks.push({
            feedId,
            entity,
            label,
            fetch: async (since) => ({ items: await deps.adapters.rss(feed, entity, since) }),
          });
        } else if (feed.kind === "ir_page") {
          const url = feed.url;
          tasks.push({
            feedId,
            entity,
            label,
            fetch: async (since) => {
              const result = await deps.adapters.irPage(url, entity, since);
              // R16: links were found but not one carried a date this
              // heuristic recognizes -- that is a broken extraction, not a
              // quiet page, and it must be visible in the run's stats rather
              // than read as silence. 0 links scanned is ordinary silence.
              const anomaly =
                result.linksScanned > 0 && result.datedLinks === 0
                  ? `ir_page ${entity.id}: ${result.linksScanned} links scanned, 0 dated -- extraction may be broken`
                  : undefined;
              return { items: result.items, anomaly };
            },
          });
        } else if (feed.kind === "edgar") {
          const cik = feed.cik;
          tasks.push({
            feedId,
            entity,
            label,
            fetch: async (since) => {
              // R17: the one shared gate, taken immediately before the call.
              await edgarGate();
              return { items: await deps.adapters.edgar(cik, entity, since) };
            },
          });
        } else {
          // A "news" feed attached to an entity is a stored Google News query.
          const query = feed.url;
          tasks.push({
            feedId,
            entity,
            label,
            fetch: async (since) => ({ items: await deps.adapters.news(query, since) }),
          });
        }
      }
    }

    // Topics have no entity, so `only` (a list of entity ids) excludes them:
    // "only roche" means this run is about Roche, not about Roche plus every
    // generic cyber query.
    if (wanted === null) {
      for (const topic of deps.watchlist.topics) {
        tasks.push({
          feedId: topicFeedId(topic.query),
          entity: null,
          label: `topic "${topic.query}"`,
          fetch: async (since) => ({ items: await deps.adapters.news(topic.query, since) }),
        });
      }
    }

    const skippedKinds = Object.values(skippedKindCounts).reduce<number>((total, count) => total + (count ?? 0), 0);
    return { tasks, skippedKinds, skippedKindCounts };
  }

  return async function run(options: IngestOptions = {}): Promise<IngestResult> {
    // One reading of the clock: startedAt stamps the run row and every item's
    // fetchedAt, startedAtMs is the origin of C1's budget and of I1's
    // first-run backfill window.
    const startedAtDate = deps.now();
    const startedAt = startedAtDate.toISOString();
    const startedAtMs = startedAtDate.getTime();

    let fetched = 0;
    let deduped = 0;
    let tagged = 0;
    let stored = 0;
    let skippedByCap = 0;
    let skippedByBudget = 0;
    let taggerFailures = 0;
    let skippedKinds = 0;
    const failedFeeds: string[] = [];
    const anomalies: string[] = [];

    // C1: true once the run has spent its wall-clock budget. Latched (and
    // logged exactly once) so the remaining items are deferred without
    // re-reading the clock or repeating the message per item.
    let budgetSpent = false;
    const budgetIsSpent = (): boolean => {
      if (budgetSpent) return true;
      if (deps.now().getTime() - startedAtMs < budgetMs) return false;
      budgetSpent = true;
      deps.log(
        `budget spent after ${budgetMs} ms and ${tagged} tagged items: tagging stops here, ` +
          `the rest of this run's items are deferred to the next run`,
      );
      return true;
    };

    // Task 8 fix (c): startRun/buildTasks/the initial log call used to sit
    // outside this try/finally, so a throw from any of them (a locked store,
    // a broken watchlist, a logger that throws) left an unfinished `runs`
    // row -- indistinguishable from a run still in flight. -1 is a sentinel
    // meaning "no run row exists yet"; the finally below only finishes a run
    // it actually started.
    let runId = -1;

    try {
      runId = deps.store.startRun(startedAt);
      const built = buildTasks(options.only);
      const { tasks, skippedKindCounts } = built;
      skippedKinds = built.skippedKinds;
      // R20: named explicitly in the run's own first log line -- the whole
      // point of counting these separately is that they must never be read
      // as silence, a failure or an anomaly.
      const skippedKindsNote =
        skippedKinds > 0
          ? ` (skippedKinds: ${Object.entries(skippedKindCounts)
              .map(([kind, count]) => `${kind}=${count}`)
              .join(", ")})`
          : "";
      deps.log(`run ${runId}: ${tasks.length} feeds${skippedKindsNote}`);

      for (const task of tasks) {
        try {
          // Inside the try on purpose: a store read that throws (a locked
          // database, a corrupted row) is a per-feed failure like any other.
          // Outside it, one bad read would take the whole run down -- the
          // exact thing "a feed never aborts the run" exists to prevent.
          const state = deps.store.getFeedState(task.feedId);
          // I1: an explicit --since always wins; then the feed's own
          // watermark; then, for a feed this store has never seen, the
          // spec's 30-day backfill rather than `null`, which asks the
          // adapter for the feed's entire history.
          const since =
            options.since ??
            state.lastSeenAt ??
            new Date(startedAtMs - FIRST_RUN_BACKFILL_MS).toISOString();

          const outcome = await fetchWithRetry(() => task.fetch(since), task.label, deps);
          if (outcome.anomaly !== undefined) {
            anomalies.push(outcome.anomaly);
            deps.log(`anomaly: ${outcome.anomaly}`);
          }

          fetched += outcome.items.length;
          // The watermark only ever moves over items this run actually
          // RESOLVED -- stored, or recognised as a duplicate. Items the cap
          // or the budget dropped are deferred, not lost, and `since` is a
          // single timestamp, not a set: the watermark must therefore stay
          // BELOW the oldest deferred item, whatever order the feed listed
          // them in (strictly below, which is safe under C2's inclusive
          // cutoff too). Feeds are conventionally newest-first, so the cap
          // usually bites part-way down the list and nothing may move at all.
          const resolved: Array<{ publishedAt: string; hash: string }> = [];
          // Items this run fetched but deliberately did not process: dropped
          // by the cap, or left untagged when the wall-clock budget ran out
          // (C1). Both are deferred to the next run, so both hold the
          // watermark back in exactly the same way.
          const deferredAt: string[] = [];
          const markResolved = (publishedAt: string, hash: string): void => {
            resolved.push({ publishedAt, hash });
          };
          const markDeferred = (publishedAt: string): void => {
            deferredAt.push(publishedAt);
          };

          for (const item of outcome.items) {
            const urlCanonical = canonicalUrl(item.url);
            const hash = contentHash(item.title, item.body);

            const existingId = findDuplicate(deps.store, item, urlCanonical, hash);
            if (existingId !== null) {
              // A later sighting of a story we already have: record the new
              // url as another source and never call the model (R13/R15).
              deps.store.addSource(existingId, item.sourceKind, urlCanonical);
              deduped += 1;
              markResolved(item.publishedAt, hash);
              continue;
            }

            if (tagged >= limit) {
              // The cap bites in priority order, because tasks are already in
              // priority order. Counted, not silently lost.
              skippedByCap += 1;
              markDeferred(item.publishedAt);
              continue; // deliberately NOT resolved: the watermark stays behind it
            }

            // C1: checked here, immediately before the one expensive step --
            // an item we have no time to tag is deferred exactly like a
            // capped one, so the same "never advance past a dropped item"
            // clamp below covers it unchanged.
            if (budgetIsSpent()) {
              skippedByBudget += 1;
              markDeferred(item.publishedAt);
              continue; // deliberately NOT resolved: the watermark stays behind it
            }

            // A tagger or store failure here propagates to the per-feed catch
            // below: the feed is marked failed and its watermark stays put, so
            // the next run re-fetches these items rather than losing them.
            const candidateIds = computeCandidateIds(item, deps.watchlist, task.entity?.id ?? null);
            let tagging: Tagging;
            try {
              tagging = await deps.tag(item, candidateIds);
            } catch (err) {
              // I4: counted separately, then rethrown so the feed fails
              // exactly as before. A dead model fails every feed it reaches,
              // but feeds with nothing new never reach it at all -- without
              // this counter that outage is indistinguishable from silence.
              taggerFailures += 1;
              throw err;
            }
            tagged += 1;

            // The feed's own entity is always attached: an item pulled from
            // Roche's newsroom is about Roche whatever the model returned, and
            // countsByEntity/the digest depend on that link. A topic feed has no
            // entity of its own, so there the model's answer stands alone (R1:
            // zero entities is a legitimate result).
            const entities = [...new Set([...(task.entity !== null ? [task.entity.id] : []), ...tagging.entities])];
            const itemId = deps.store.insertItem({
              urlCanonical,
              contentHash: hash,
              titleKey: item.titleKey,
              sourceKind: item.sourceKind,
              sourceName: item.sourceName,
              title: item.title,
              summary: tagging.summary,
              signal: tagging.signal,
              importance: tagging.importance,
              facts: tagging.facts,
              publishedAt: item.publishedAt,
              fetchedAt: startedAt,
              // Persisted so the index can be rebuilt without re-fetching the
              // feed -- most of which no longer return anything.
              body: item.body,
              entities,
              domains: tagging.domains,
              flagged: tagging.flagged,
            });
            stored += 1;
            markResolved(item.publishedAt, hash);

            // The embedding is best-effort: the row is already durable in
            // SQLite, so a ChromaDB outage must not fail the feed and force a
            // re-tag of items we would then dedupe away anyway.
            try {
              await deps.embed(
                [[item.title, tagging.summary, item.body].filter((part) => part.length > 0).join("\n\n")],
                [
                  {
                    source: urlCanonical,
                    title: item.title,
                    entity: entities.join(","),
                    domain: tagging.domains.join(","),
                    signal: tagging.signal ?? "",
                    published_at: item.publishedAt,
                    ...watchlistDate(item.publishedAt),
                    source_kind: item.sourceKind,
                    importance: tagging.importance ?? 0,
                    watchlist_item_id: itemId,
                  },
                ],
              );
            } catch (err) {
              const message = `embed failed for item ${itemId}: ${err instanceof Error ? err.message : String(err)}`;
              anomalies.push(message);
              deps.log(message);
            }
          }

          // The newest resolved item that is still strictly older than
          // everything the cap dropped. With nothing eligible -- an empty feed,
          // or a first batch the cap ate whole -- the previous watermark is
          // rewritten unchanged, which is null for a feed never seen before.
          // Never a stand-in like the run's start: that would push a feed's
          // entire unseen backlog behind `since` permanently, and the FIRST
          // production run is exactly the one that blows the cap, since every
          // feed backfills over I1's 30-day window at once. Recording the
          // success (even a null one) still clears the failure streak.
          const deferredFloor =
            deferredAt.length === 0 ? null : deferredAt.reduce((oldest, at) => (at < oldest ? at : oldest));
          const eligible =
            deferredFloor === null ? resolved : resolved.filter((entry) => entry.publishedAt < deferredFloor);
          const newest = eligible.reduce<{ publishedAt: string; hash: string } | null>(
            (best, entry) => (best === null || entry.publishedAt > best.publishedAt ? entry : best),
            null,
          );
          deps.store.recordFeedSuccess(
            task.feedId,
            newest?.publishedAt ?? state.lastSeenAt,
            newest?.hash ?? state.lastItemHash,
          );
        } catch (err) {
          failedFeeds.push(task.feedId);
          let failures = "?";
          try {
            failures = String(deps.store.recordFeedFailure(task.feedId));
          } catch (recordErr) {
            // Recording the failure is itself a store write; if THAT throws the
            // run still has to reach finishRun.
            const message = `could not record the failure of ${task.label}: ${
              recordErr instanceof Error ? recordErr.message : String(recordErr)
            }`;
            anomalies.push(message);
            deps.log(message);
          }
          deps.log(
            `feed failed (${failures} in a row): ${task.label}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } finally {
      // Always closed out, even if the loop itself dies (or buildTasks/the
      // initial log call did, before the loop ever started): an unfinished
      // `runs` row is indistinguishable from a run still in flight, and cron
      // would have no way to tell a crash from a quiet night. Skipped only
      // when startRun itself never returned a row to finish.
      if (runId !== -1) {
        deps.store.finishRun(runId, deps.now().toISOString(), {
          fetched,
          deduped,
          tagged,
          failedFeeds: failedFeeds.length,
          skippedByCap,
          skippedByBudget,
          anomalies: anomalies.length,
        });
        deps.log(
          `run ${runId} done: fetched=${fetched} deduped=${deduped} tagged=${tagged} stored=${stored} ` +
            `skippedByCap=${skippedByCap} skippedByBudget=${skippedByBudget} skippedKinds=${skippedKinds} ` +
            `taggerFailures=${taggerFailures} failedFeeds=${failedFeeds.length} anomalies=${anomalies.length}`,
        );
      }
    }

    return {
      fetched,
      deduped,
      tagged,
      stored,
      skippedByCap,
      skippedByBudget,
      taggerFailures,
      failedFeeds,
      anomalies,
      skippedKinds,
      runId,
    };
  };
}

// R13/R15's dedupe ladder, in order, all of it before any model call:
//   1. canonical url  -- the same page reached twice
//   2. content hash   -- the same title+body under two urls
//   3. title key      -- the same story re-typeset and re-linked by an
//                        aggregator, matched ONLY against a different source
//                        kind and only within +/-3 days
// Returns the existing item's id, or null when this really is a new story.
function findDuplicate(
  store: WatchlistStore,
  item: RawItem,
  urlCanonical: string,
  hash: string,
): number | null {
  const byUrl = store.findByUrl(urlCanonical);
  if (byUrl !== null) return byUrl.id;

  const byHash = store.findByHash(hash);
  if (byHash !== null) return byHash.id;

  if (item.titleKey.length === 0) return null;
  const publishedMs = Date.parse(item.publishedAt);
  if (Number.isNaN(publishedMs)) return null;

  const from = new Date(publishedMs - TITLE_KEY_WINDOW_MS).toISOString();
  const to = new Date(publishedMs + TITLE_KEY_WINDOW_MS).toISOString();
  const byTitleKey = store.findByTitleKey(item.titleKey, from, to, item.sourceKind);
  return byTitleKey === null ? null : byTitleKey.id;
}
