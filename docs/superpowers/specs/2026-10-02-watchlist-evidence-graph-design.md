# Watchlist evidence in the vendor graph

**Date:** 2026-10-02
**Status:** approved design, not yet planned
**Follows:** `2026-09-21-vendor-intel-graph-design.md` (the unbuilt "watchlist items (live hook) → Evidence, SUPPORTS" row) and
deviation 2 of `plans/2026-10-01-competitive-position.md` (recent vendor news read straight from `watchlist.db`).
**Stacked on:** PR #64 (chat graph context), which this changes in `competitive-graph.ts`, `competitive-graph-live.ts`
and `chat-graph-context.ts`.

## Why

`competitive_position` already shows recent **vendor** news, read from `watchlist.db`. What it never shows is
**account** news, although the watchlist holds it (91 Roche items, 32 Novartis items on 2026-10-02, each with a
signal and IT domains) and the answer's own guidance depends on it: *displace* "needs a disqualifying weakness or a
triggering event", and *defend* turns on "roadmap, lifecycle". A Roche `it_move` in storage is that triggering event.

Decided with the user:

| Question | Decision |
|---|---|
| Purpose | **Both**: Evidence nodes in Neo4j (the graph browsable and queryable with its evidence), and the answer gains account events read from them |
| Which signals | **All** (`it_move`, `corporate`, `cyber`, `financial`, untagged); the signal travels with the item so the model can weigh it |
| Write path | **A, rebuild after ingest**: the rebuild is the only writer of Evidence; the nightly ingest triggers it best-effort |

Rejected: a live MERGE hook in ingest beside the rebuild (two writers of one shape that can drift, for freshness a
nightly ingest cannot use), and a hook with a one-off backfill (the next rebuild wipes it).

## Data model

```
(Evidence {id: "watchlist:<itemId>", title, url, publishedAt, signal, domains, source})
  -[:SUPPORTS {url, segments: [...]}]->  (Vendor | Account)
```

- **One SUPPORTS edge per item and target**, segments as a list property. `SUPPORTS` already has `url` as its
  identity property (`graph-schema.ts`), and Neo4j has no edges to edges, so the original spec's
  `SUPPORTS → (node|edge)` becomes a node edge carrying the segments.
- An item tagged with both a vendor and an account ("Roche picks Dell for file storage") gets **two** edges.
- **Segments** are derived once, at rebuild, from the item's domains through the inverse of `SEGMENT_DOMAINS`
  (`storage` → `storage-block`, `storage-file`, `storage-object`; `backup`/`cyber` → `data-protection`; …). An item
  with no mapped domain gets `segments: []`: account- or vendor-wide.
- `Evidence` and `SUPPORTS` are already in the closed label and relationship sets; `writeGraphFacts` validates them
  unchanged.
- `signal` is the stored signal or `null`; `domains` is the item's domain list; `source` is the item's `source_name`;
  `publishedAt` is the date (`YYYY-MM-DD`).

## Rebuild: a fourth source

`collectVendorGraphFacts` reads `watchlist.db` through an injected
`itemsFor(entityIds: string[], since: string): EvidenceSourceItem[]` (live: `watchlist-store`; tests: a fake).

- **Which items:** tagged with an entity id that is a `Vendor` or `Account` **in this rebuild's facts**, published in
  the **last 180 days** (`EVIDENCE_WINDOW_DAYS`), any signal.
- **Future-dated items** (published more than one day after the rebuild) are **skipped and counted** in the report.
  `watchlist.db` held one dated 2026-11-03 on 2026-10-02; fixing its adapter is out of scope.
- **Missing `watchlist.db`:** skipped and reported, like a missing accounts file.
- **Present but unreadable `watchlist.db`:** the rebuild fails **before** the wipe, the rule that already protects
  accounts.
- Report line: `watchlist.db  -> <n> evidence for <k> vendors/accounts, <f> future-dated skipped`.
- Expected size 600–900 Evidence nodes; one MERGE each inside the existing transaction, seconds.

## Answer

### Vendor evidence (replaces the sqlite read)

`CompetitiveDeps.recentItems` is removed. A vendor's evidence is a Cypher read: Evidence that `SUPPORTS` the vendor
with `segments` overlapping the cited segments, newest `EVIDENCE_PER_VENDOR` (3). `competitive-graph.ts` no longer
needs `SEGMENT_DOMAINS` for the answer (it moves to where the rebuild uses it) nor `watchlist.db`.

- Kept: a vendor whose cited segments overlap no evidence gets `[]` and a note, never unfiltered news.
- Changed: news appears after a rebuild. With the nightly hook, that is after every ingest.

### Account events (new)

- `SegmentView.events`: up to 3 newest Evidence `SUPPORTS` the account with that segment in `segments`,
  as `{title, url, publishedAt, signal}`.
- `AccountView.general`: up to 3 newest account-wide items (`segments: []`).
- One Cypher read for all the answer's accounts, one per evidence vendor.
- `MODE_GUIDANCE` for *displace* and *defend* gains a clause pointing at the segment's `events` as where triggering
  events and lifecycle signals come from.

### Budget

Two trim steps in `fitBudget`, after "claim details" and before "claims":

1. account events beyond 1 per segment, and `general` beyond 1;
2. all account events.

Each adds its usual "left out" note.

### Chat (`chat-graph-context.ts`)

Under each segment's `installed:` line: `↳ 2026-09-14 [it_move] Roche consolidates EU data centres`; per account a
`general:` line. The 6 000-character cap and line cut still apply.

### MCP

The tool passes JSON through. `mcp/src/tools/graph.ts` gains one sentence on `events`/`general` in the
`competitive_position` description. Name and parameters are unchanged: no orphaned agent sessions.

## Nightly hook

`runIngest()` (`scripts/watchlist.ts`) gains an injected `rebuildGraph(): Promise<RebuildResult>`; the CLI binds
`rebuildVendorGraph({ root }, neo4jWriteTransaction(getDriver()))`.

- Runs after **every ingest pass that ran**, failed feeds included (it only mirrors `watchlist.db`).
- Does not run on a usage error (exit 2) or with `--only` (a debugging pass).
- The rebuild report goes to the run log (`data/logs/watchlist-ingest-<date>.log`).

| Ingest | Rebuild | Exit | Telegram (via the unchanged Hermes wrapper) |
|---|---|---|---|
| ok | ok | 0 | nothing |
| ok | failed | **3** | `graph rebuild failed: <reason>` |
| failed | any | 1 | the existing summary; rebuild line in the log |

The wrapper already reports any non-zero exit with the last 20 lines: no wrapper or cron change.

**Safety:** one transaction; a failed rebuild leaves the previous graph and its evidence, and concurrent readers see
the old graph until commit. No model, so any stack.

**Accepted edge case:** a manual `POST /api/graph/rebuild` during the nightly run is not locked out across
processes (the route's `rebuilding` flag is in-process). Neo4j serialises the two write transactions; at worst one
fails and reports. No cross-process lock.

## Testing

All unit tests use fakes: no live Neo4j, sqlite, launchd or Hermes.

- **Rebuild source:** domain → segment mapping (storage, cyber, unmapped → `[]`); vendor+account item → two edges;
  entities outside the graph ignored; 180-day window; future-dated skipped and counted; missing db skipped;
  unreadable db throws before `clear()`.
- **Answer:** vendor evidence only from overlapping segments, `[]` + note otherwise; newest-3 `events` per segment
  and `general` per account; the two trim steps in order with notes; guidance names `events`.
- **Chat renderer:** event and `general:` lines; cap holds.
- **Ingest hook:** rebuild after a pass, not after exit 2 or with `--only`; exit 3 with reason on rebuild failure;
  exit 1 wins over a rebuild result.
- **MCP:** `npm --prefix mcp test`, `npm --prefix mcp run typecheck`.

Verification beyond tests:

1. `npm run typecheck`, `npm run typecheck:tests`, `npm test`.
2. Read-only count against the real `watchlist.db` of the items that would become Evidence (checks the estimate).
3. **With the user's go-ahead**, one real rebuild (`npx tsx scripts/rebuild-vendor-graph.ts`), then a read-only
   `competitive_position` for Dell at Roche and the chat probe.

## Out of scope

- The future-dated item in the watchlist adapters (reported, not fixed).
- Vendor ranking (follow-up 3) and constrained re-extraction of legacy documents (follow-up 4).
- Changing `USES` from evidence: the install base stays user-declared in `accounts.local.yaml`.
