# Watchlist Evidence in the Vendor Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Watchlist items become `Evidence` nodes in the vendor graph, written only by the graph rebuild (which the nightly ingest now triggers), and `competitive_position` reads vendor news and new per-segment account events from them.

**Architecture:** A pure module (`graph-evidence.ts`) turns watchlist items into `Evidence` nodes and `SUPPORTS` edges with segments derived from the item's domains. The rebuild reads it as a fourth source inside its single wipe-and-write transaction. The answer layer (`competitive-graph.ts`) swaps its sqlite read for two Cypher reads and attaches `events`/`general` to account views. The chat renderer shows them. `runIngest` calls the rebuild after each pass and exits 3 when only the rebuild failed.

**Tech Stack:** TypeScript ESM (Node16 modules, strict), Jest (ESM), neo4j-driver, better-sqlite3, zod (MCP).

**Spec:** `docs/superpowers/specs/2026-10-02-watchlist-evidence-graph-design.md`

**Worktree:** `.worktrees/watchlist-evidence-graph`, branch `feature/watchlist-evidence-graph`, stacked on PR #64 (`feature/chat-competitive-graph`). Run every command from the worktree root.

## Global Constraints

- Tests must never touch live services (Neo4j, ChromaDB, model servers, launchd, Hermes, Telegram). Inject fakes; never prove RED against live data.
- No `any`: use `unknown` + type guards. Interfaces over type aliases for object shapes. Source imports siblings as `./x.js`.
- Run `npm run typecheck` after every code change; `npm run typecheck:tests` before each commit; `npm --prefix mcp run typecheck` after MCP changes. There is no lint script.
- Commit prefixes `feat:` `fix:` `refactor:` `test:` `docs:`; end every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `Evidence` id is `watchlist:<itemId>`; `SUPPORTS` properties are `{url, segments}`; Evidence properties are `{title, url, publishedAt (YYYY-MM-DD), signal (string or null), domains, source}`.
- Window: `EVIDENCE_WINDOW_DAYS = 180`. Future-dated = published more than one day after the rebuild's `now`.
- Per answer: `EVIDENCE_PER_VENDOR = 3` (existing), `EVENTS_PER_SEGMENT = 3`, `GENERAL_PER_ACCOUNT = 3`.
- Exit codes of `runIngest`: 0 ok, 1 ingest failed (wins), 2 usage error, **3 ingest ok but graph rebuild failed**.
- The real graph rebuild (`npx tsx scripts/rebuild-vendor-graph.ts --apply --rebuild`) is run **only after the user says yes** (Task 6).

## Review Focus

1. **An Evidence row with no `signal` property** (Neo4j drops null properties on write) must read back as `signal: null`, never throw "missing required field". Pinned in Task 3.
2. **A graph built before this change (no Evidence nodes yet)** must still answer: empty `events`/`general`, empty vendor evidence, no crash and no per-segment note spam. Pinned in Task 3.
3. **An item tagged with a graph vendor and an account whose domains map to no segment** gets two edges with `segments: []`. It appears in the account's `general` and never as vendor evidence. Pinned in Tasks 1 and 3.
4. **The rebuild dry run** (`scripts/rebuild-vendor-graph.ts` without `--apply`) reports the evidence line from the real `watchlist.db` without writing anything. It is the read-only count in Task 6. Pinned in Task 2 by the report-line test and in Task 6 by running it.
5. **The nightly CLI must exit after the rebuild.** An open Neo4j driver keeps Node alive and the Hermes job would hang. `runIngestCli` closes it in `finally`. Pinned in Task 5 by the wiring step; checked live in Task 6 step 4.

---

### Task 1: `graph-evidence.ts`: items to Evidence facts

**Files:**
- Create: `src/services/graph-evidence.ts`
- Modify: `src/services/competitive-graph.ts` (move `SEGMENT_DOMAINS` out, import it back)
- Test: `__tests__/graph-evidence.test.ts`

**Interfaces:**
- Consumes: `SEGMENTS`, `GraphFacts`, `GraphNode`, `GraphRelationship`, `Segment` from `graph-schema.ts`; `StoredItem`, `WatchlistStore`, `openWatchlistStore` from `watchlist-store.ts`; `Domain` from `watchlist-config.ts`.
- Produces:
  - `SEGMENT_DOMAINS: Record<Segment, Domain[]>` (moved verbatim from `competitive-graph.ts`)
  - `EVIDENCE_WINDOW_DAYS = 180`
  - `type EvidenceSourceItem = Pick<StoredItem, "id" | "urlCanonical" | "title" | "signal" | "publishedAt" | "sourceName" | "entities" | "domains">`
  - `type EvidenceSource = (entityIds: string[], sinceIso: string) => EvidenceSourceItem[] | null` (null = watchlist.db missing)
  - `segmentsForDomains(domains: readonly string[]): Segment[]` (in `SEGMENTS` order)
  - `interface EvidenceFacts { facts: GraphFacts; evidence: number; entities: number; futureSkipped: number }`
  - `evidenceToGraphFacts(items: EvidenceSourceItem[], graphIds: ReadonlySet<string>, now: Date): EvidenceFacts`
  - `evidenceSince(now: Date): string`
  - `storeEvidence(store: Pick<WatchlistStore, "itemsInPeriod">): EvidenceSource`
  - `watchlistEvidence(path: string): EvidenceSource`

- [ ] **Step 1: Write the failing tests**

Create `__tests__/graph-evidence.test.ts`:

```ts
import { describe, expect, it } from "@jest/globals";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVIDENCE_WINDOW_DAYS,
  evidenceSince,
  evidenceToGraphFacts,
  segmentsForDomains,
  storeEvidence,
  watchlistEvidence,
  type EvidenceSourceItem,
} from "../src/services/graph-evidence.js";
import type { Domain } from "../src/services/watchlist-config.js";

const NOW = new Date("2026-10-02T03:00:00.000Z");

function item(over: Partial<EvidenceSourceItem> & { id: number }): EvidenceSourceItem {
  return {
    id: over.id,
    urlCanonical: over.urlCanonical ?? `https://example.test/${over.id}`,
    title: over.title ?? `Item ${over.id}`,
    signal: over.signal === undefined ? "it_move" : over.signal,
    publishedAt: over.publishedAt ?? "2026-09-20T08:00:00.000Z",
    sourceName: over.sourceName ?? "Blocks & Files",
    entities: over.entities ?? ["dell"],
    domains: over.domains ?? ["storage"],
  };
}

describe("segmentsForDomains", () => {
  it("maps storage to the three storage segments, in segment order", () => {
    expect(segmentsForDomains(["storage"])).toEqual(["storage-block", "storage-file", "storage-object"]);
  });

  it("maps backup and cyber to data-protection once", () => {
    expect(segmentsForDomains(["backup", "cyber"])).toEqual(["data-protection"]);
  });

  it("maps infrastructure to every segment that reads it", () => {
    expect(segmentsForDomains(["infrastructure"])).toEqual(["compute-ai", "compute-standard", "hci"]);
  });

  it("returns no segment for a domain no segment reads", () => {
    expect(segmentsForDomains(["sap", "cloud"])).toEqual([]);
  });
});

describe("evidenceToGraphFacts", () => {
  const graph = new Set(["dell", "roche"]);

  it("writes one Evidence node and one SUPPORTS edge per graph entity", () => {
    const { facts, evidence, entities } = evidenceToGraphFacts(
      [item({ id: 7, entities: ["dell", "roche", "not-in-graph"], domains: ["storage"] })],
      graph,
      NOW,
    );
    expect(evidence).toBe(1);
    expect(entities).toBe(2);
    expect(facts.nodes).toEqual([
      {
        label: "Evidence",
        id: "watchlist:7",
        properties: {
          title: "Item 7",
          url: "https://example.test/7",
          publishedAt: "2026-09-20",
          signal: "it_move",
          domains: ["storage"],
          source: "Blocks & Files",
        },
      },
    ]);
    const segments = ["storage-block", "storage-file", "storage-object"];
    expect(facts.relationships).toEqual([
      { type: "SUPPORTS", from: "watchlist:7", to: "dell", properties: { url: "https://example.test/7", segments } },
      { type: "SUPPORTS", from: "watchlist:7", to: "roche", properties: { url: "https://example.test/7", segments } },
    ]);
  });

  it("gives an item whose domains map nowhere account- and vendor-wide edges (segments [])", () => {
    const { facts } = evidenceToGraphFacts([item({ id: 8, entities: ["dell", "roche"], domains: ["sap"] })], graph, NOW);
    expect(facts.relationships.map((r) => r.properties.segments)).toEqual([[], []]);
  });

  it("keeps a missing signal as null", () => {
    const { facts } = evidenceToGraphFacts([item({ id: 9, signal: null })], graph, NOW);
    expect(facts.nodes[0].properties.signal).toBeNull();
  });

  it("ignores items tagged only with entities outside the graph", () => {
    const result = evidenceToGraphFacts([item({ id: 10, entities: ["snowflake"] })], graph, NOW);
    expect(result.evidence).toBe(0);
    expect(result.facts).toEqual({ nodes: [], relationships: [] });
  });

  it("skips and counts items dated more than a day in the future", () => {
    const result = evidenceToGraphFacts(
      [
        item({ id: 11, publishedAt: "2026-11-03T23:00:00.000Z" }),
        item({ id: 12, publishedAt: "2026-10-02T23:00:00.000Z" }), // within a day: kept
      ],
      graph,
      NOW,
    );
    expect(result.futureSkipped).toBe(1);
    expect(result.facts.nodes.map((n) => n.id)).toEqual(["watchlist:12"]);
  });
});

describe("evidence sources", () => {
  it("starts the window EVIDENCE_WINDOW_DAYS before now", () => {
    expect(EVIDENCE_WINDOW_DAYS).toBe(180);
    expect(evidenceSince(NOW)).toBe("2026-04-05T03:00:00.000Z");
  });

  it("asks the store for the entities from the window start onwards", () => {
    const calls: Array<[string, string, { entities?: string[]; domains?: Domain[] } | undefined]> = [];
    const source = storeEvidence({
      itemsInPeriod: (from, to, options) => {
        calls.push([from, to, options]);
        return [];
      },
    });
    expect(source(["dell", "roche"], "2026-04-05T03:00:00.000Z")).toEqual([]);
    expect(calls).toEqual([["2026-04-05T03:00:00.000Z", "9999-12-31T23:59:59.999Z", { entities: ["dell", "roche"] }]]);
  });

  it("reports a missing watchlist.db as null without creating it", () => {
    const path = join(mkdtempSync(join(tmpdir(), "evidence-")), "watchlist.db");
    expect(watchlistEvidence(path)(["dell"], "2026-04-05T00:00:00.000Z")).toBeNull();
    expect(existsSync(path)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- __tests__/graph-evidence.test.ts`
Expected: FAIL with `Could not locate module ../src/services/graph-evidence.js`

- [ ] **Step 3: Implement `src/services/graph-evidence.ts`**

```ts
// Watchlist items as graph evidence: which segments an item speaks to, and the
// Evidence nodes and SUPPORTS edges the rebuild writes for it.
//
// Pure apart from the two small binders at the bottom, which read
// watchlist.db. The rebuild is the only writer of Evidence (spec 2026-10-02).
import { existsSync } from "node:fs";
import { SEGMENTS, type GraphFacts, type GraphNode, type GraphRelationship, type Segment } from "./graph-schema.js";
import type { Domain } from "./watchlist-config.js";
import { openWatchlistStore, type StoredItem, type WatchlistStore } from "./watchlist-store.js";

/**
 * The watchlist domains whose items count as evidence for a segment. The
 * watchlist tags items with 12 IT domains, the graph speaks in segments; this
 * is the only place the two vocabularies meet.
 */
export const SEGMENT_DOMAINS: Record<Segment, Domain[]> = {
  "compute-ai": ["ai", "infrastructure"],
  "compute-standard": ["infrastructure"],
  "storage-block": ["storage"],
  "storage-file": ["storage"],
  "storage-object": ["storage"],
  "data-platform": ["data"],
  "data-protection": ["backup", "cyber"],
  hci: ["infrastructure"],
  networking: ["networking"],
  client: ["euc"],
  services: [],
};

export const EVIDENCE_WINDOW_DAYS = 180;

const DAY_MS = 24 * 60 * 60 * 1000;
const FAR_FUTURE = "9999-12-31T23:59:59.999Z";

export type EvidenceSourceItem = Pick<
  StoredItem,
  "id" | "urlCanonical" | "title" | "signal" | "publishedAt" | "sourceName" | "entities" | "domains"
>;

/** Items tagged with any of the ids, published at or after `sinceIso`; null when watchlist.db does not exist. */
export type EvidenceSource = (entityIds: string[], sinceIso: string) => EvidenceSourceItem[] | null;

export interface EvidenceFacts {
  facts: GraphFacts;
  evidence: number;
  /** Distinct graph vendors and accounts at least one item supports. */
  entities: number;
  futureSkipped: number;
}

export function segmentsForDomains(domains: readonly string[]): Segment[] {
  return SEGMENTS.filter((segment) => SEGMENT_DOMAINS[segment].some((d) => domains.includes(d)));
}

export function evidenceSince(now: Date): string {
  return new Date(now.getTime() - EVIDENCE_WINDOW_DAYS * DAY_MS).toISOString();
}

/**
 * One Evidence node per item and one SUPPORTS edge per graph entity it is
 * tagged with. Entities outside the graph are dropped here, because the writer
 * refuses an edge to a node nobody declared.
 */
export function evidenceToGraphFacts(items: EvidenceSourceItem[], graphIds: ReadonlySet<string>, now: Date): EvidenceFacts {
  // A feed that misdates an item a month ahead (one did on 2026-10-02) would
  // otherwise sit on top of every "newest" list until that date passes.
  const latest = now.getTime() + DAY_MS;
  const nodes: GraphNode[] = [];
  const relationships: GraphRelationship[] = [];
  const supported = new Set<string>();
  let futureSkipped = 0;

  for (const item of items) {
    if (Date.parse(item.publishedAt) > latest) {
      futureSkipped++;
      continue;
    }
    const targets = item.entities.filter((e) => graphIds.has(e));
    if (targets.length === 0) continue;

    const id = `watchlist:${item.id}`;
    nodes.push({
      label: "Evidence",
      id,
      properties: {
        title: item.title,
        url: item.urlCanonical,
        publishedAt: item.publishedAt.slice(0, 10),
        signal: item.signal,
        domains: [...item.domains],
        source: item.sourceName,
      },
    });
    const segments = segmentsForDomains(item.domains);
    for (const target of targets) {
      supported.add(target);
      relationships.push({ type: "SUPPORTS", from: id, to: target, properties: { url: item.urlCanonical, segments } });
    }
  }

  return { facts: { nodes, relationships }, evidence: nodes.length, entities: supported.size, futureSkipped };
}

/** Reads through a store the caller already holds open (the nightly ingest's). */
export function storeEvidence(store: Pick<WatchlistStore, "itemsInPeriod">): EvidenceSource {
  return (entityIds, sinceIso) => store.itemsInPeriod(sinceIso, FAR_FUTURE, { entities: entityIds });
}

/** Opens watchlist.db for one read. A missing file is null: openWatchlistStore would create it. */
export function watchlistEvidence(path: string): EvidenceSource {
  return (entityIds, sinceIso) => {
    if (!existsSync(path)) return null;
    const store = openWatchlistStore(path);
    try {
      return storeEvidence(store)(entityIds, sinceIso);
    } finally {
      store.close();
    }
  };
}
```

- [ ] **Step 4: Move `SEGMENT_DOMAINS` out of `competitive-graph.ts`**

In `src/services/competitive-graph.ts`, delete the `SEGMENT_DOMAINS` doc comment and constant (the block starting `/**\n * The watchlist domains whose items count as evidence for a segment.` through the closing `};`). Add this import below the existing `import type { Segment } from "./graph-schema.js";` line:

```ts
import { SEGMENT_DOMAINS } from "./graph-evidence.js";
```

Behaviour is unchanged; Task 3 removes the remaining use.

- [ ] **Step 5: Run the tests and typecheck**

Run: `npm test -- __tests__/graph-evidence.test.ts __tests__/competitive-graph.test.ts && npm run typecheck && npm run typecheck:tests`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/services/graph-evidence.ts src/services/competitive-graph.ts __tests__/graph-evidence.test.ts
git commit -m "feat: graph-evidence turns watchlist items into Evidence facts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The rebuild reads watchlist.db as a fourth source

**Files:**
- Modify: `src/services/vendor-graph-rebuild.ts` (`RebuildSources`, `collectVendorGraphFacts`, header comment)
- Modify: `src/api/graph.ts` (`liveGraphRouterDeps().rebuild`)
- Modify: `scripts/rebuild-vendor-graph.ts` (`sources`, header comment)
- Test: `__tests__/vendor-graph-rebuild.test.ts`

**Interfaces:**
- Consumes (Task 1): `EvidenceSource`, `EvidenceSourceItem`, `evidenceToGraphFacts`, `evidenceSince`, `watchlistEvidence`.
- Produces: `RebuildSources` gains `evidence?: EvidenceSource` and `now?: () => Date`. With `evidence` undefined, the source is skipped silently (old callers). Report line format:
  `watchlist.db                 -> <n> evidence for <k> vendors/accounts, <f> future-dated skipped` (name padded to 28 like the others), or `watchlist.db                 -> skipped (no such file)`.

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/vendor-graph-rebuild.test.ts`. Add `import type { EvidenceSource, EvidenceSourceItem } from "../src/services/graph-evidence.js";` to the imports, then:

```ts
describe("collectVendorGraphFacts — watchlist evidence", () => {
  const NOW = new Date("2026-10-02T03:00:00.000Z");

  function evidenceItem(over: Partial<EvidenceSourceItem> & { id: number }): EvidenceSourceItem {
    return {
      id: over.id,
      urlCanonical: `https://example.test/${over.id}`,
      title: `Item ${over.id}`,
      signal: "it_move",
      publishedAt: over.publishedAt ?? "2026-09-20T08:00:00.000Z",
      sourceName: "Blocks & Files",
      entities: over.entities ?? ["dell"],
      domains: over.domains ?? ["storage"],
    };
  }

  function recordingSource(items: EvidenceSourceItem[]): { source: EvidenceSource; calls: Array<[string[], string]> } {
    const calls: Array<[string[], string]> = [];
    return {
      calls,
      source: (ids, since) => {
        calls.push([ids, since]);
        return items;
      },
    };
  }

  it("asks for the graph's vendors and accounts over the evidence window", () => {
    const rec = recordingSource([]);
    collectVendorGraphFacts({ ...files(ALL), evidence: rec.source, now: () => NOW });
    expect(rec.calls).toEqual([[["dell", "roche"], "2026-04-05T03:00:00.000Z"]]);
  });

  it("adds Evidence facts and a report line", () => {
    const rec = recordingSource([
      evidenceItem({ id: 1, entities: ["dell", "roche"] }),
      evidenceItem({ id: 2, publishedAt: "2026-11-03T00:00:00.000Z" }),
    ]);
    const { batch, lines } = collectVendorGraphFacts({ ...files(ALL), evidence: rec.source, now: () => NOW });
    const evidence = batch[batch.length - 1];
    expect(evidence.nodes.map((n) => n.id)).toEqual(["watchlist:1"]);
    expect(evidence.relationships.map((r) => r.to)).toEqual(["dell", "roche"]);
    expect(lines).toContain("watchlist.db                 -> 1 evidence for 2 vendors/accounts, 1 future-dated skipped");
  });

  it("skips and reports a missing watchlist.db", () => {
    const { batch, lines } = collectVendorGraphFacts({ ...files(ALL), evidence: () => null, now: () => NOW });
    expect(batch).toHaveLength(3);
    expect(lines).toContain("watchlist.db                 -> skipped (no such file)");
  });

  it("writes evidence through the rebuild, after the wipe", async () => {
    const rec = recordingTransaction();
    await rebuildVendorGraph(
      { ...files(ALL), evidence: recordingSource([evidenceItem({ id: 1 })]).source, now: () => NOW },
      rec.tx,
    );
    expect(rec.queries[0]).toBe("MATCH (n) DETACH DELETE n");
    expect(rec.queries.some((q) => q.startsWith("MERGE (n:Evidence {id: $id})"))).toBe(true);
    expect(rec.queries.some((q) => q.includes("MERGE (a)-[r:SUPPORTS {url: $id_url}]->(b)"))).toBe(true);
  });

  it("never opens a transaction when watchlist.db cannot be read", async () => {
    const rec = recordingTransaction();
    const unreadable: EvidenceSource = () => {
      throw new Error("SQLITE_CORRUPT: database disk image is malformed");
    };
    await expect(rebuildVendorGraph({ ...files(ALL), evidence: unreadable, now: () => NOW }, rec.tx)).rejects.toThrow(
      "watchlist.db: SQLITE_CORRUPT: database disk image is malformed",
    );
    expect(rec.calls).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- __tests__/vendor-graph-rebuild.test.ts`
Expected: FAIL (type error on `evidence`/`now`, or the report line missing).

- [ ] **Step 3: Implement the source in `src/services/vendor-graph-rebuild.ts`**

Replace the header comment's first two lines with:

```ts
// Rebuilds the vendor-intelligence graph from its four deterministic sources:
// knowledge/vendors/*.md, config/needs.yaml, config/accounts.local.yaml and
// the watchlist items about the graph's vendors and accounts (watchlist.db).
```

Add the import:

```ts
import { evidenceSince, evidenceToGraphFacts, type EvidenceSource, type EvidenceSourceItem } from "./graph-evidence.js";
```

Extend `RebuildSources`:

```ts
export interface RebuildSources {
  root: string;
  readDir?: (dir: string) => string[];
  readFile?: (path: string) => string;
  /** Watchlist items for the graph's vendors and accounts; omitted, evidence is not part of this rebuild. */
  evidence?: EvidenceSource;
  now?: () => Date;
}
```

At the end of `collectVendorGraphFacts`, immediately before `return { batch, lines };`, add:

```ts
  if (sources.evidence !== undefined) {
    // Evidence attaches to the vendors and accounts the other sources declared;
    // it never introduces a node of its own.
    const graphIds = new Set(
      batch.flatMap((facts) => facts.nodes.filter((n) => n.label === "Vendor" || n.label === "Account").map((n) => n.id)),
    );
    const now = (sources.now ?? (() => new Date()))();
    let items: EvidenceSourceItem[] | null;
    try {
      items = sources.evidence([...graphIds].sort(), evidenceSince(now));
    } catch (err) {
      // Same rule as a broken accounts file: fail before the wipe, never rebuild without it.
      throw new Error(`watchlist.db: ${(err as Error).message}`);
    }
    if (items === null) {
      lines.push(`${"watchlist.db".padEnd(28)} -> skipped (no such file)`);
    } else {
      const result = evidenceToGraphFacts(items, graphIds, now);
      batch.push(result.facts);
      lines.push(
        `${"watchlist.db".padEnd(28)} -> ${result.evidence} evidence for ${result.entities} vendors/accounts, ` +
          `${result.futureSkipped} future-dated skipped`,
      );
    }
  }
```

- [ ] **Step 4: Wire the live rebuilds**

In `src/api/graph.ts`, add imports:

```ts
import { join } from "node:path";
import { watchlistEvidence } from "../services/graph-evidence.js";
```

and change the `rebuild` line in `liveGraphRouterDeps()` to:

```ts
    rebuild: () =>
      rebuildVendorGraph(
        { root: process.cwd(), evidence: watchlistEvidence(join(process.cwd(), "data", "watchlist.db")) },
        neo4jWriteTransaction(getDriver()),
      ),
```

In `scripts/rebuild-vendor-graph.ts`, update the header's first two lines to `// Rebuild the vendor-intelligence graph from knowledge/vendors/*.md,\n// config/needs.yaml, config/accounts.local.yaml and data/watchlist.db (evidence).`, add imports:

```ts
import { join } from "node:path";
import { watchlistEvidence } from "../src/services/graph-evidence.js";
```

and replace `const sources = { root: process.cwd() };` with:

```ts
const sources = { root: process.cwd(), evidence: watchlistEvidence(join(process.cwd(), "data", "watchlist.db")) };
```

The dry run (no `--apply`) now prints the evidence line from the real database and writes nothing.

- [ ] **Step 5: Run the tests and typecheck**

Run: `npm test -- __tests__/vendor-graph-rebuild.test.ts __tests__/graph-routes.test.ts && npm run typecheck && npm run typecheck:tests`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/services/vendor-graph-rebuild.ts src/api/graph.ts scripts/rebuild-vendor-graph.ts __tests__/vendor-graph-rebuild.test.ts
git commit -m "feat: graph rebuild writes watchlist evidence as a fourth source

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The answer reads evidence from the graph and gains account events

**Files:**
- Modify: `src/services/competitive-graph.ts`
- Modify: `src/services/competitive-position.ts` (`MODE_GUIDANCE` only)
- Modify: `src/services/competitive-graph-live.ts` (drop `recentItems`)
- Modify: `src/services/chat-graph-context.ts` (`competitivePositionFrom` is now async)
- Test: `__tests__/competitive-graph.test.ts`, `__tests__/graph-routes.test.ts`, `__tests__/chat-graph-context.test.ts`

**Interfaces:**
- Consumes: nothing new from earlier tasks (the edge shape from Task 1: `SUPPORTS {url, segments}`, Evidence `{title, url, publishedAt, signal}`).
- Produces:
  - `EvidenceItem` gains `signal: string | null`.
  - `CompetitiveDeps` loses `recentItems` (now `{ runCypher, briefs, vendorAliases }`).
  - `ACCOUNT_EVIDENCE_CYPHER` (params `{accounts: string[]}`, rows `{account, segments, title, url, publishedAt, signal}`), `VENDOR_EVIDENCE_CYPHER` (params `{vendor: string, segments: string[]}`, rows `{title, url, publishedAt, signal}`).
  - `EVENTS_PER_SEGMENT = 3`, `GENERAL_PER_ACCOUNT = 3`.
  - `interface AnswerSegment extends SegmentView { events: EvidenceItem[] }`
  - `interface AnswerAccount extends Omit<AccountView, "segments"> { segments: AnswerSegment[]; general: EvidenceItem[] }`
  - `CompetitiveAnswer.accounts: AnswerAccount[]`
  - `competitivePositionFrom(deps: Pick<CompetitiveDeps, "runCypher" | "briefs">, snapshot: GraphSnapshot, query: CompetitiveQuery): Promise<CompetitiveResult>` (now async).

- [ ] **Step 1: Update the test fakes and write the failing tests**

In `__tests__/competitive-graph.test.ts`:

1. Add `ACCOUNT_EVIDENCE_CYPHER`, `VENDOR_EVIDENCE_CYPHER`, `EVENTS_PER_SEGMENT` to the import from `competitive-graph.js`; remove the `Domain` import if it becomes unused.
2. Extend `Rows` and `fakeCypher`:

```ts
interface Rows {
  accounts: Array<Record<string, unknown>>;
  needs: Array<Record<string, unknown>>;
  positions: Array<Record<string, unknown>>;
  vendors: Array<Record<string, unknown>>;
  /** Rows for ACCOUNT_EVIDENCE_CYPHER; absent = a graph with no Evidence yet. */
  accountEvidence?: Array<Record<string, unknown>>;
  /** Rows for VENDOR_EVIDENCE_CYPHER, by vendor id. */
  vendorEvidence?: Record<string, Array<Record<string, unknown>>>;
}

function fakeCypher(rows: Rows, calls: Array<[string, Record<string, unknown> | undefined]> = []): RunCypher {
  return async (query, params) => {
    calls.push([query, params]);
    if (query === ACCOUNTS_CYPHER) return rows.accounts;
    if (query === NEED_SEGMENTS_CYPHER) return rows.needs;
    if (query === POSITIONS_CYPHER) return rows.positions;
    if (query === VENDORS_CYPHER) return rows.vendors;
    if (query === ACCOUNT_EVIDENCE_CYPHER) return rows.accountEvidence ?? [];
    if (query === VENDOR_EVIDENCE_CYPHER) return rows.vendorEvidence?.[String(params?.vendor)] ?? [];
    throw new Error(`unexpected query: ${query}`);
  };
}
```

3. In `deps()`, delete the `recentItems:` line.
4. Delete `recordingItems()` and the three tests that use it ("fetches the vendor's recent items…", "returns no news rather than off-topic news…", "treats a vendor cited only in services…"), and replace them with:

```ts
  function evidenceRow(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
    return { title: `News ${n}`, url: `https://example.test/${n}`, publishedAt: `2026-09-${String(10 + n).padStart(2, "0")}`, signal: "it_move", ...over };
  }

  it("reads the vendor's evidence for its cited segments from the graph, newest first", async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const rows: Rows = { ...ROWS, vendorEvidence: { dell: [evidenceRow(1), evidenceRow(4), evidenceRow(2), evidenceRow(3)] } };
    const result = await competitivePosition(deps({ runCypher: fakeCypher(rows, calls) }), { vendor: "dell" });
    if (!result.ok) throw new Error(result.error);
    expect(calls.filter(([q]) => q === VENDOR_EVIDENCE_CYPHER).map(([, p]) => p)).toEqual([
      { vendor: "dell", segments: ["storage-block"] },
    ]);
    expect(result.answer.evidence.dell.map((e) => e.title)).toEqual(["News 4", "News 3", "News 2"]);
  });

  it("returns no news and a note for a vendor with no cited segment", async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const result = await competitivePosition(deps({ runCypher: fakeCypher(ROWS, calls) }), { vendor: "hpe" });
    if (!result.ok) throw new Error(result.error);
    expect(calls.some(([q]) => q === VENDOR_EVIDENCE_CYPHER)).toBe(false);
    expect(result.answer.evidence).toEqual({ hpe: [] });
    expect(result.answer.notes).toContain("no segment-specific news for hpe: it has no cited segment");
  });

  it("reads an Evidence row without a signal as signal null", async () => {
    const row = evidenceRow(1);
    delete row.signal;
    const rows: Rows = { ...ROWS, vendorEvidence: { dell: [row] } };
    const result = await competitivePosition(deps({ runCypher: fakeCypher(rows) }), { vendor: "dell" });
    if (!result.ok) throw new Error(result.error);
    expect(result.answer.evidence.dell[0].signal).toBeNull();
  });

  it("attaches the newest account events per segment and account-wide news as general", async () => {
    const rows: Rows = {
      ...ROWS,
      accountEvidence: [
        ...[1, 2, 3, 4].map((n) => ({ account: "roche", segments: ["storage-block", "storage-file"], ...evidenceRow(n) })),
        { account: "roche", segments: [], ...evidenceRow(5, { signal: "corporate" }) },
        { account: "roche", segments: ["networking"], ...evidenceRow(6) },
      ],
    };
    const result = await competitivePosition(deps({ runCypher: fakeCypher(rows) }), { account: "roche" });
    if (!result.ok) throw new Error(result.error);
    const roche = result.answer.accounts[0];
    const block = roche.segments.find((s) => s.segment === "storage-block");
    expect(block?.events.map((e) => e.title)).toEqual(["News 4", "News 3", "News 2"]);
    expect(block?.events.length).toBe(EVENTS_PER_SEGMENT);
    expect(roche.general).toEqual([
      { title: "News 5", url: "https://example.test/5", publishedAt: "2026-09-15", signal: "corporate" },
    ]);
  });

  it("answers on a graph with no Evidence yet: empty events, no notes about it", async () => {
    const result = await competitivePosition(deps(), { account: "roche" });
    if (!result.ok) throw new Error(result.error);
    for (const segment of result.answer.accounts[0].segments) expect(segment.events).toEqual([]);
    expect(result.answer.accounts[0].general).toEqual([]);
    expect(result.answer.notes.some((n) => n.includes("event"))).toBe(false);
  });

  it("points the defend and displace guidance at the segment's events", async () => {
    const result = await competitivePosition(deps(), { vendor: "dell" });
    if (!result.ok) throw new Error(result.error);
    expect(result.answer.modes.defend).toContain("the segment's events");
  });
```

5. Add a budget-order test inside `describe("competitivePosition — size budget", …)`:

```ts
  it("drops account events beyond one per segment before it drops claims", async () => {
    const rows: Rows = {
      ...ROWS,
      accountEvidence: [1, 2, 3].map((n) => ({
        account: "roche",
        segments: ["storage-block"],
        title: `${"T".repeat(300)} ${n}`,
        url: `https://example.test/${n}`,
        publishedAt: `2026-09-1${n}`,
        signal: "it_move",
      })),
    };
    const result = await competitivePosition(deps({ runCypher: fakeCypher(rows) }), { account: "roche" });
    if (!result.ok) throw new Error(result.error);
    const answer = result.answer;
    fitBudget(answer, JSON.stringify(answer).length - 10);
    const block = answer.accounts[0].segments.find((s) => s.segment === "storage-block");
    expect(block?.events).toHaveLength(1);
    expect(answer.standings["dell/storage-block"].strong.length).toBeGreaterThan(0);
    expect(answer.notes.some((n) => n.includes("account events beyond 1 per segment and account"))).toBe(true);
  });
```

In `__tests__/graph-routes.test.ts`, delete `recentItems: () => [],` and before the final `throw new Error("unexpected query");` add:

```ts
    if (query === ACCOUNT_EVIDENCE_CYPHER || query === VENDOR_EVIDENCE_CYPHER) return [];
```

adding both names to that file's import from `competitive-graph.js`.

In `__tests__/chat-graph-context.test.ts`:
- import `ACCOUNT_EVIDENCE_CYPHER` and `VENDOR_EVIDENCE_CYPHER`;
- in `fakeCypher`, before the throw, add `if (query === ACCOUNT_EVIDENCE_CYPHER || query === VENDOR_EVIDENCE_CYPHER) return [];`;
- delete `recentItems: () => [],` from `competitive()`;
- in `answer()`, add `general: [],` to the Roche account and `events: [],` to both segment objects.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- __tests__/competitive-graph.test.ts`
Expected: FAIL (`ACCOUNT_EVIDENCE_CYPHER` not exported, plus type errors on `events`/`general`).

- [ ] **Step 3: Update `MODE_GUIDANCE` in `src/services/competitive-position.ts`**

```ts
export const MODE_GUIDANCE: Record<IncumbencyMode, string> = {
  defend:
    "the vendor is installed: defend and expand through roadmap, lifecycle and adjacent attach; function gaps are tolerable; " +
    "the segment's events show lifecycle and roadmap moves",
  displace:
    "a rival is installed: displacing it needs a disqualifying weakness or a triggering event; look for one in the segment's events",
  greenfield: "declared: nobody is installed, so function and price actually decide",
  unknown: "who is installed here is not recorded: find out before choosing defend, displace or greenfield",
};
```

- [ ] **Step 4: Implement the answer changes in `src/services/competitive-graph.ts`**

4a. Update the header comment's second paragraph to: `// Everything live is injected (Cypher runner, brief files), so no test reaches\n// Neo4j; src/services/competitive-graph-live.ts binds the real ones.` Remove the `import { SEGMENT_DOMAINS } from "./graph-evidence.js";`, `import type { Segment } from "./graph-schema.js";` and `import type { Domain } from "./watchlist-config.js";` lines once unused. Add `type SegmentView` to the import from `./competitive-position.js`.

4b. Replace `EvidenceItem` and `CompetitiveDeps`:

```ts
export interface EvidenceItem {
  title: string;
  url: string;
  publishedAt: string;
  /** The watchlist signal (it_move, corporate, cyber, financial); null when the tagger gave none. */
  signal: string | null;
}

export interface CompetitiveDeps {
  runCypher: RunCypher;
  briefs(): BriefExcerpts;
  vendorAliases(): Record<string, string>;
}
```

4c. After `VENDORS_CYPHER`, add:

```ts
export const ACCOUNT_EVIDENCE_CYPHER = `
  MATCH (e:Evidence)-[s:SUPPORTS]->(a:Account)
  WHERE a.id IN $accounts
  RETURN a.id AS account, s.segments AS segments, e.title AS title, e.url AS url,
         e.publishedAt AS publishedAt, e.signal AS signal
  ORDER BY publishedAt DESC, url
`;

export const VENDOR_EVIDENCE_CYPHER = `
  MATCH (e:Evidence)-[s:SUPPORTS]->(v:Vendor {id: $vendor})
  WHERE any(segment IN s.segments WHERE segment IN $segments)
  RETURN e.title AS title, e.url AS url, e.publishedAt AS publishedAt, e.signal AS signal
  ORDER BY publishedAt DESC, url
`;
```

4d. Next to `EVIDENCE_PER_VENDOR`, add:

```ts
export const EVENTS_PER_SEGMENT = 3;
export const GENERAL_PER_ACCOUNT = 3;
```

4e. After `AnswerStanding`, add, and change `CompetitiveAnswer.accounts` to `accounts: AnswerAccount[];`:

```ts
export interface AnswerSegment extends SegmentView {
  /** Newest account news in this segment's domains: triggering events, lifecycle moves. */
  events: EvidenceItem[];
}

export interface AnswerAccount extends Omit<AccountView, "segments"> {
  segments: AnswerSegment[];
  /** Newest account news that maps to no segment (reorganisations, results, sites). */
  general: EvidenceItem[];
}
```

4f. Below `commaList`, add the row readers:

```ts
function evidenceItem(row: Record<string, unknown>): EvidenceItem {
  return {
    title: str(row.title, "title"),
    url: str(row.url, "url"),
    publishedAt: str(row.publishedAt, "publishedAt"),
    // Neo4j stores no null property, so an untagged item comes back without one.
    signal: typeof row.signal === "string" && row.signal.length > 0 ? row.signal : null,
  };
}

function newestFirst(a: EvidenceItem, b: EvidenceItem): number {
  return b.publishedAt.localeCompare(a.publishedAt) || a.url.localeCompare(b.url);
}

interface AccountEvidence {
  segments: string[];
  item: EvidenceItem;
}

async function readAccountEvidence(runCypher: RunCypher, accounts: string[]): Promise<Map<string, AccountEvidence[]>> {
  const byAccount = new Map<string, AccountEvidence[]>();
  if (accounts.length === 0) return byAccount;
  for (const row of await runCypher(ACCOUNT_EVIDENCE_CYPHER, { accounts })) {
    const account = str(row.account, "account");
    const list = byAccount.get(account) ?? [];
    list.push({ segments: Array.isArray(row.segments) ? row.segments.map(String) : [], item: evidenceItem(row) });
    byAccount.set(account, list);
  }
  for (const list of byAccount.values()) list.sort((a, b) => newestFirst(a.item, b.item));
  return byAccount;
}
```

4g. Change `TrimStep.apply` to take the whole answer and add the two event steps after "claim details":

```ts
interface TrimStep {
  /** What the step leaves out, for the note. */
  drops: string;
  apply(answer: CompetitiveAnswer): void;
}

const TRIM_STEPS: TrimStep[] = [
  {
    drops: "claim details",
    apply: (a) => {
      for (const s of Object.values(a.standings)) for (const c of [...s.strong, ...s.weak]) c.detail = "";
    },
  },
  {
    drops: "account events beyond 1 per segment and account",
    apply: (a) => {
      for (const account of a.accounts) {
        account.general = account.general.slice(0, 1);
        for (const segment of account.segments) segment.events = segment.events.slice(0, 1);
      }
    },
  },
  {
    drops: "account events",
    apply: (a) => {
      for (const account of a.accounts) {
        account.general = [];
        for (const segment of account.segments) segment.events = [];
      }
    },
  },
  {
    drops: "claims",
    apply: (a) => {
      for (const s of Object.values(a.standings)) {
        s.strong = [];
        s.weak = [];
      }
    },
  },
  {
    drops: `rationale beyond ${TRIMMED_RATIONALE_CHARS} characters`,
    apply: (a) => {
      for (const s of Object.values(a.standings)) {
        if (s.rationale !== undefined && s.rationale.length > TRIMMED_RATIONALE_CHARS) {
          s.rationale = `${s.rationale.slice(0, TRIMMED_RATIONALE_CHARS).trimEnd()}…`;
        }
      }
    },
  },
  {
    drops: `rationale, and sources beyond ${TRIMMED_SOURCES} per standing`,
    apply: (a) => {
      for (const s of Object.values(a.standings)) {
        delete s.rationale;
        s.sources = s.sources.slice(0, TRIMMED_SOURCES);
      }
    },
  },
  {
    drops: "sources",
    apply: (a) => {
      for (const s of Object.values(a.standings)) s.sources = [];
    },
  },
];
```

Keep the doc comment above `TRIM_STEPS`, changing its first sentence to `In the order applied: cheapest information first; repetitive account events go before claims.` In `fitBudget`, delete `const standings = Object.values(answer.standings);` and change `step.apply(standings);` to `step.apply(answer);`.

4h. Make `competitivePositionFrom` async and replace its evidence block. The full function becomes:

```ts
/** The same answer from a snapshot already read, so a caller that inspected it does not read the graph twice. */
export async function competitivePositionFrom(
  deps: Pick<CompetitiveDeps, "runCypher" | "briefs">,
  snapshot: GraphSnapshot,
  query: CompetitiveQuery,
): Promise<CompetitiveResult> {
  const resolved = resolveCompetitivePosition(snapshot, query);
  if (!resolved.ok) return resolved;
  const r = resolved.value;

  const { excerpts, errors } = deps.briefs();
  const notes = [...r.notes, ...errors.map((e) => `brief problem: ${e}`)];

  const standings: Record<string, AnswerStanding> = {};
  for (const [key, standing] of Object.entries(r.standings)) {
    const excerpt = excerpts.get(key);
    if (excerpt === undefined) {
      const [vendor, segment] = key.split("/");
      notes.push(`no curated evidence for ${vendor} in ${segment}: the position rests on the graph alone`);
    }
    standings[key] = {
      ...standing,
      curated: excerpt !== undefined,
      strong: excerpt?.strong.map((c) => ({ ...c })) ?? [],
      weak: excerpt?.weak.map((c) => ({ ...c })) ?? [],
      sources: excerpt?.sources ?? [],
    };
  }

  const modes: Partial<Record<IncumbencyMode, string>> = {};
  for (const account of r.accounts) {
    for (const segment of account.segments) for (const v of segment.vendors) modes[v.mode] = MODE_GUIDANCE[v.mode];
  }

  const events = await readAccountEvidence(
    deps.runCypher,
    r.accounts.map((a) => a.account),
  );
  const accounts: AnswerAccount[] = r.accounts.map((account) => {
    const rows = events.get(account.account) ?? [];
    return {
      ...account,
      segments: account.segments.map((segment) => ({
        ...segment,
        events: rows
          .filter((e) => e.segments.includes(segment.segment))
          .slice(0, EVENTS_PER_SEGMENT)
          .map((e) => ({ ...e.item })),
      })),
      general: rows
        .filter((e) => e.segments.length === 0)
        .slice(0, GENERAL_PER_ACCOUNT)
        .map((e) => ({ ...e.item })),
    };
  });

  // Evidence for the queried vendor, or for every cited vendor when none was named.
  const evidenceVendors =
    r.query.vendor !== null ? [r.query.vendor] : [...new Set(Object.keys(standings).map((k) => k.split("/")[0]))].sort();
  const evidence: Record<string, EvidenceItem[]> = {};
  for (const vendor of evidenceVendors) {
    const segments = [
      ...new Set(Object.keys(standings).filter((k) => k.split("/")[0] === vendor).map((k) => k.split("/")[1])),
    ].sort();
    if (segments.length === 0) {
      // Unfiltered, the vendor's newest items would come from any segment and
      // read as evidence for a standing it does not have.
      evidence[vendor] = [];
      notes.push(`no segment-specific news for ${vendor}: it has no cited segment`);
      continue;
    }
    const rows = await deps.runCypher(VENDOR_EVIDENCE_CYPHER, { vendor, segments });
    evidence[vendor] = rows.map(evidenceItem).sort(newestFirst).slice(0, EVIDENCE_PER_VENDOR);
  }

  const answer: CompetitiveAnswer = {
    query: r.query,
    modes,
    market: r.market,
    accounts,
    standings,
    evidence,
    notes,
  };
  fitBudget(answer);
  return { ok: true, answer };
}
```

- [ ] **Step 5: Update the live deps and the chat caller**

In `src/services/competitive-graph-live.ts`, delete the `recentItems: …` line from `liveCompetitiveDeps()`.

In `src/services/chat-graph-context.ts`, in `competitiveContext`, change
`const result = competitivePositionFrom(deps.competitive, snapshot, query);` to
`const result = await competitivePositionFrom(deps.competitive, snapshot, query);`.

- [ ] **Step 6: Run the tests and typecheck**

Run: `npm test -- __tests__/competitive-graph.test.ts __tests__/competitive-position.test.ts __tests__/graph-routes.test.ts __tests__/chat-graph-context.test.ts && npm run typecheck && npm run typecheck:tests`
Expected: PASS, no type errors. If `export-wiring.ts`'s `itemsFor` is now unused by anything but exports, leave it (exports still use it).

- [ ] **Step 7: Commit**

```bash
git add src/services/competitive-graph.ts src/services/competitive-position.ts src/services/competitive-graph-live.ts src/services/chat-graph-context.ts __tests__/competitive-graph.test.ts __tests__/graph-routes.test.ts __tests__/chat-graph-context.test.ts
git commit -m "feat: competitive_position reads evidence from the graph and shows account events

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The chat block shows account events

**Files:**
- Modify: `src/services/chat-graph-context.ts` (`renderCompetitiveContext`)
- Test: `__tests__/chat-graph-context.test.ts`

**Interfaces:**
- Consumes (Task 3): `AnswerAccount.general`, `AnswerSegment.events`, `EvidenceItem.signal`.
- Produces: event lines `↳ <publishedAt> [<signal or "untagged">] <title>` indented 4 spaces under a segment's `installed:` line; per account `  general:` followed by the same lines.

- [ ] **Step 1: Write the failing test**

Add inside `describe("renderCompetitiveContext", …)`:

```ts
  it("shows each segment's events under its installs, and account-wide news as general", () => {
    const base = answer();
    const roche = base.accounts[0];
    roche.general = [{ title: "Roche reorganises IT", url: "https://example.test/g", publishedAt: "2026-09-02", signal: null }];
    roche.segments[0].events = [
      { title: "Roche consolidates EU data centres", url: "https://example.test/e", publishedAt: "2026-09-14", signal: "it_move" },
    ];
    const text = renderCompetitiveContext(base);
    expect(text).toContain("  general:\n    ↳ 2026-09-02 [untagged] Roche reorganises IT");
    expect(text).toContain(
      "  storage-block (via cyber-resilience), installed: dell\n    ↳ 2026-09-14 [it_move] Roche consolidates EU data centres",
    );
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- __tests__/chat-graph-context.test.ts -t "events under its installs"`
Expected: FAIL (the text lacks the `general:` and `↳` lines).

- [ ] **Step 3: Implement**

In `src/services/chat-graph-context.ts`, add `type EvidenceItem` to the import from `./competitive-graph.js`, add above `renderCompetitiveContext`:

```ts
function eventLine(e: EvidenceItem): string {
  return `    ↳ ${e.publishedAt} [${e.signal ?? "untagged"}] ${e.title}`;
}
```

and replace the accounts loop in `renderCompetitiveContext` with:

```ts
  for (const account of a.accounts) {
    lines.push(`${account.name} (${account.account}), needs: ${account.needs.join(", ") || "none recorded"}`);
    if (account.general.length > 0) lines.push("  general:", ...account.general.map(eventLine));
    for (const s of account.segments) {
      const via = s.via.length > 0 ? ` (via ${s.via.join(", ")})` : "";
      lines.push(`  ${s.segment}${via}, installed: ${s.incumbents.join(", ") || "nobody"}`);
      lines.push(...s.events.map(eventLine));
      for (const v of s.vendors) lines.push(`    ${v.vendor}: ${v.mode}, position ${v.position ?? "unknown"}`);
    }
  }
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -- __tests__/chat-graph-context.test.ts && npm run typecheck && npm run typecheck:tests`
Expected: PASS (the budget and cut tests still pass), no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/services/chat-graph-context.ts __tests__/chat-graph-context.test.ts
git commit -m "feat: chat graph block shows account events per segment

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The nightly ingest rebuilds the graph, exit 3 when only that fails

**Files:**
- Modify: `scripts/watchlist.ts` (`RunIngestDeps`, `runIngest`, `runIngestCli`)
- Test: `__tests__/watchlist-cli.test.ts`

**Interfaces:**
- Consumes (Task 2): `rebuildVendorGraph(sources, inTransaction)`, `neo4jWriteTransaction`, `RebuildResult`; (Task 1): `storeEvidence`; `getDriver`, `closeNeo4j` from `src/services/graph-store.ts`.
- Produces: `RunIngestDeps.rebuildGraph?: () => Promise<RebuildResult>`; exit code 3; log lines `Graph rebuilt: <n> nodes, <m> relationships` / `graph rebuild failed: <reason>`.

- [ ] **Step 1: Write the failing tests**

In `__tests__/watchlist-cli.test.ts`, import `type RebuildResult` from `../src/services/vendor-graph-rebuild.js`. Extend `makeIngestHarness`'s options with `rebuildGraph?: RunIngestDeps["rebuildGraph"];` and pass `rebuildGraph: options.rebuildGraph,` in the `runIngest` deps object. Then add:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- __tests__/watchlist-cli.test.ts -t "graph rebuild"`
Expected: FAIL (`rebuildGraph` not in `RunIngestDeps`, no rebuild log, exit 0 instead of 3).

- [ ] **Step 3: Implement the hook in `runIngest`**

Add `import type { RebuildResult } from "../src/services/vendor-graph-rebuild.js";` to `scripts/watchlist.ts`'s imports. Add to `RunIngestDeps`:

```ts
  // Rebuilds the vendor graph from its sources, watchlist evidence included.
  // Optional so a caller that only wants the ingest can leave it out; the CLI
  // always binds it.
  rebuildGraph?: () => Promise<RebuildResult>;
```

Update the `runIngest` doc comment's exit-code sentence to: `returns a process exit code: 2 for a usage problem caught before anything ran, 1 when every attempted feed failed or the tagger failed, 3 when the ingest succeeded but the graph rebuild after it failed, 0 otherwise.`

Immediately after the `for (const anomaly of result.anomalies) { … }` loop, add:

```ts
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
```

Replace the final `return 0;` with:

```ts
  // Ingest failures above keep priority. A rebuild failure alone gets its own
  // code so the Hermes wrapper (which reports any non-zero exit) says so.
  if (rebuildFailed) return 3;

  return 0;
```

Note the "graph rebuild failed" line must stay the last log line on that path, so the wrapper's `tail -20` keeps it: the two `return 1` branches log after it only when the ingest itself failed, which is the case where the ingest summary matters more.

- [ ] **Step 4: Wire the CLI**

In `scripts/watchlist.ts`, add imports:

```ts
import { storeEvidence } from "../src/services/graph-evidence.js";
import { closeNeo4j, getDriver } from "../src/services/graph-store.js";
import { neo4jWriteTransaction, rebuildVendorGraph } from "../src/services/vendor-graph-rebuild.js";
```

(merge with the `RebuildResult` type import from Step 3 into one import line from `vendor-graph-rebuild.js`). In `runIngestCli`, add to the `runIngest` deps object:

```ts
      // Reads evidence through the store this run already holds open.
      rebuildGraph: () =>
        rebuildVendorGraph({ root: process.cwd(), evidence: storeEvidence(store) }, neo4jWriteTransaction(getDriver())),
```

and change the `finally` block to:

```ts
  } finally {
    store.close();
    // An open driver keeps Node alive: the nightly Hermes job would never exit.
    await closeNeo4j();
  }
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npm test -- __tests__/watchlist-cli.test.ts && npm run typecheck && npm run typecheck:tests`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add scripts/watchlist.ts __tests__/watchlist-cli.test.ts
git commit -m "feat: nightly ingest rebuilds the vendor graph, exit 3 when only the rebuild fails

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: MCP description, docs, and verification

**Files:**
- Modify: `mcp/src/tools/graph.ts` (`competitive_position` description)
- Modify: `CLAUDE.md` (Retrieval paragraph, Gotchas)

**Interfaces:**
- Consumes: everything above.
- Produces: no code interfaces.

- [ ] **Step 1: Update the MCP description**

In `mcp/src/tools/graph.ts`, replace the description's `"recent news. Positions are labels, not a ranking: never present vendors as ranked. " +` with:

```ts
        "recent vendor news. Each account segment also carries `events` (the account's newest news there: triggering " +
        "events, lifecycle moves) and each account `general` (account-wide news). " +
        "Positions are labels, not a ranking: never present vendors as ranked. " +
```

Run: `npm --prefix mcp test && npm --prefix mcp run typecheck`
Expected: PASS. If a test pins the old description text, update the pinned text to the new sentence.

- [ ] **Step 2: Update `CLAUDE.md`**

In the Retrieval bullet, replace `Graph rebuild (… ) is deterministic — vendor briefs,\n  \`config/needs.yaml\`, \`config/accounts.local.yaml\`, one write transaction — and works on every stack.` with:

```
Graph rebuild (`POST /api/graph/rebuild`, `scripts/rebuild-vendor-graph.ts`) is deterministic — vendor briefs,
  `config/needs.yaml`, `config/accounts.local.yaml` and 180 days of `watchlist.db` items for the graph's vendors and
  accounts (`Evidence -[:SUPPORTS {segments}]->`, `graph-evidence.ts`), one write transaction — and works on every stack.
  The nightly ingest runs it after each pass; exit 3 = ingest ok, rebuild failed (Telegram via the Hermes wrapper).
```

and after the competitive_position sentence add: `Account segments carry \`events\`, accounts \`general\` (newest Evidence).`

- [ ] **Step 3: Full verification**

Run: `npm run typecheck && npm run typecheck:tests && npm test && npm --prefix mcp test && npm --prefix mcp run typecheck`
Expected: all pass. Record the totals for the PR.

- [ ] **Step 4: Read-only count against the real data**

From the **main checkout's data**, run the dry run with this branch's code (it reads `data/watchlist.db` and the configs, writes nothing):

```bash
cd /Users/seb/claude/PharmaLLM && npx tsx .worktrees/watchlist-evidence-graph/scripts/rebuild-vendor-graph.ts
```

Expected: the usual brief/needs/account lines plus `watchlist.db -> <n> evidence for <k> vendors/accounts, <f> future-dated skipped` (spec estimate 600–900, at least 1 future-dated), and `DRY RUN — would write …`. If `<n>` is far outside the estimate, stop and report before going on.

Then check the CLI exits after a rebuild-shaped run without touching feeds: `time npx tsx -e 'import("./.worktrees/watchlist-evidence-graph/src/services/graph-store.ts").then(async (m) => { await m.getDriver().getServerInfo(); await m.closeNeo4j(); })'` must return within a few seconds (driver closed, process exits).

- [ ] **Step 5: Ask the user, then the one live write**

Ask: "Ready for the real rebuild? It wipes and rewrites the live graph in one transaction, now with ~<n> Evidence nodes." Only after a yes:

```bash
cd /Users/seb/claude/PharmaLLM && npx tsx .worktrees/watchlist-evidence-graph/scripts/rebuild-vendor-graph.ts --apply --rebuild
```

Then, read-only, with the branch code: run `competitivePosition(liveCompetitiveDeps(), { vendor: "dell", account: "roche" })` and the chat probe (`chatGraphContext("how is dell placed at genentech?", …)`) in a scratchpad `.mts` script, and confirm real `events` appear under Roche's segments. Note: the live app (main checkout, `tsx watch`) still runs main's code, whose answer has no events until this merges; the graph change itself is harmless to it (it ignores Evidence nodes).

- [ ] **Step 6: Commit, push, PR**

```bash
git add mcp/src/tools/graph.ts CLAUDE.md
git commit -m "docs: competitive_position events and the evidence-aware graph rebuild

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin feature/watchlist-evidence-graph
gh pr create --base feature/chat-competitive-graph --title "feat: watchlist evidence in the vendor graph, account events in competitive_position" --body-file "$SCRATCHPAD/pr-64b.md"
```

Write `$SCRATCHPAD/pr-64b.md` (the session scratchpad) first, with: a What section (Evidence nodes from the rebuild, account `events`/`general`, nightly rebuild with exit 3), the test totals from Step 3, the dry-run evidence count from Step 4, the live Dell@Roche result from Step 5, and the final line `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

Base the PR on `feature/chat-competitive-graph` while #64 is open; retarget to `main` after #64 merges (`gh pr edit <n> --base main`).
