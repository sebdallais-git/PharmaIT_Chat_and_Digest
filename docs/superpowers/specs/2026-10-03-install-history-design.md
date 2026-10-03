# Install-base history

**Date:** 2026-10-03
**Status:** approved design, not yet planned
**Follows:** `2026-09-21-vendor-intel-graph-design.md` (`(Account)-[:USES]->(Vendor) {segment, since, asOf}` — `since`
was specced, never built), `2026-10-02-vendor-ranking-design.md`, `2026-10-02-need-evidence-design.md` (the
proposals-and-approval machinery reused here).
**Stacked on:** PR #67 (`feature/need-evidence`).

## Why

`config/accounts.local.yaml` holds only the **current** install base, and every rebuild wipes and rewrites the
graph from it. Change Novartis storage-block from `[dell]` to `[hds]` and the graph forgets Dell ever held it, and
when. "Dell just lost block to HDS" and "HDS has been there ten years" are different sales situations.

Decided with the user:

| Question | Decision |
|---|---|
| Source | **Declared** in the accounts file (`since`/`until` per incumbent) **plus news proposals**: the 27B proposes changes from news into a proposals file the user approves |
| Effect | **Show** history; by default only **recent changes** (18 months), the **full history when the question asks for it**. Regimes and ranking unchanged |
| Shape | History in the accounts file; news proposals in their own file; the rebuild merges (accounts file = truth for now, approved news adds the past) |

Rejected: writing approved proposals into `accounts.local.yaml` (rewrites the user's hand-edited file) and
news-only history (unverified, misses what never made the news).

## Accounts file

Each segment's incumbents accept plain names and dated entries, mixed:

```yaml
incumbents:
  storage-block:
    - hds                                          # current, date unknown (today's form)
    - {vendor: hds, since: 2026-03}                 # current since March 2026
    - {vendor: dell, since: 2019, until: 2026-03}   # held it until March 2026
```

- Dates: `YYYY`, `YYYY-MM` or `YYYY-MM-DD`.
- **Current** = an entry without `until`. Only current entries feed incumbency: defend/displace/greenfield, triggers
  and ranking behave exactly as today.
- A vendor may appear more than once (held, lost, won back); several current vendors per segment stay normal.
- `[]` still means "nobody installed now"; past entries beside it record who held it before (a segment whose entries
  are all past is declared empty, with history).
- **Validation** (fails the rebuild before the wipe, naming account and segment): date format; `since` ≤ `until`;
  `until` not in the future (a future end date belongs in `triggers`); an entry needs `vendor` and no unknown keys.
  A trigger still needs at least one current incumbent.
- The example file gains a dated Dell → HDS example.

## Graph

- Every entry becomes `(Account)-[:USES {segment, since, until}]->(Vendor)`, past ones included; a missing date is
  `""` (Neo4j cannot MERGE on null).
- `EDGE_IDENTITY.USES` becomes `["segment", "since", "until"]`: with `segment` alone, two stints of the same vendor in
  one segment would merge into one.
- The snapshot reads `since`/`until`; the resolver's incumbents are the edges with `until = ""`; the rest is history.
- A graph built before this change has no dates: every edge reads as current, which is today's behaviour.

## News proposals

`npx tsx scripts/extract-install-history.ts [--dry-run] [--status]`, reusing need evidence's machinery (resumable,
saves after every item, merges with the file on disk, verbatim quote ≥ 6 words, `status` approval).

- **Inputs:** watchlist items tagged with one of the user's accounts, and archive news (`news-YYYY-MM-DD` raw
  documents) whose text names an account or alias. **Pre-filtered without the model**: the item must name an account
  (or alias) **and** a known vendor (id or watchlist alias). One 27B call per remaining item.
- **Question:** does this item report that `<account>` installed, replaced or removed a vendor in one of the closed
  segments? Answer `{account, segment, vendor, change: installed | replaced | removed, replaced_vendor?, quote}` or
  `none`.
- **Checks:** account, segment, vendor (and `replaced_vendor`) from the closed sets; quote verbatim in the item and
  ≥ 6 words; `replaced_vendor` present exactly when `change` is `replaced`. The **date is the item's own date**,
  never the model's.
- **File:** `config/install-history.local.yaml` (gitignored), entries `{id, status, account, segment, vendor,
  change, replaced_vendor?, date, quote, source}`; `source` is the item URL or `news-…`; stable ids from
  account, segment, vendor, change and quote.

### Merge at rebuild (accounts file = now, approved news = the past)

- `installed Y` on D: Y current in the file without `since` → `since: D`; Y not current → a past stint starting D
  (end unknown unless another entry says so).
- `replaced X by Y` on D: X gets a past stint `until: D`; Y as `installed` on D.
- `removed X` on D: X gets a past stint `until: D`.
- **Conflicts never override the file**: approved news saying X left while the file lists X as current becomes an
  answer note (`approved news says dell left storage-block on 2026-03-12; accounts.local.yaml still lists it as
  current`).
- Validation before the wipe: malformed file, or an approved entry with an unknown account/segment/vendor, fails
  loudly, naming the entry. A missing file is skipped and reported.

## Answer, chat, MCP

- Each account segment gains `history: Array<{vendor, since, until, source}>`, newest first; `source` is `declared`
  or `news:<source>`.
- **Recent (default):** stints that started or ended in the last **18 months** (`HISTORY_RECENT_MONTHS`); older ones
  counted in `olderChanges`. **Full:** every stint.
- `competitive_position` gains `history: "recent" | "full"` (MCP parameter and HTTP body; description: use `full`
  when the user asks about past vendors, changes over time or who had it before).
- **Chat:** history wording ("history", "over time", "previously", "before", "used to", "since when", "who had")
  selects `full`; deterministic keyword match, no model call. Under a segment's `installed:` line:
  `changed: dell → hds 2026-03 (declared) · +2 older`; in full mode the stints:
  `dell 2019–2026-03 · hds 2026-03–now`.
- **Budget:** trimmable; one step after "claim details": "history beyond the newest change per segment"; the newest
  change is left out only at the last resort.
- Regimes and ranking are unchanged: history is context for the model, not a rule.

## Testing

Fakes only (no 27B, Neo4j, ChromaDB, real config).

- **Accounts:** mixed plain/dated; three date precisions; `since` > `until`, future `until` (message points to
  triggers), unknown key, missing vendor refused; vendor twice; `[]` with past entries; trigger needs a current
  incumbent; example file parses.
- **Graph:** dated USES edges with `""`; identity keeps two stints apart; snapshot current vs history; legacy graph
  all current.
- **Extraction:** prefilter; item date used; closed sets, quote, `replaced_vendor` rule; resumable, merge with the
  file on disk; `--status`, `--dry-run`.
- **Merge:** installed (fills `since` / adds past stint), replaced, removed; conflict → note, file wins; validation
  before the wipe.
- **Answer:** 18-month window + `olderChanges`; full mode; newest first with source; trim order; ranking unchanged.
- **Chat:** `changed:` line, full stint line, keyword switch.
- **MCP:** `history` parameter; `npm --prefix mcp test`, typecheck.

Verification beyond tests:

1. Typechecks, `npm test`, MCP tests and typecheck.
2. Rebuild dry run on the real `accounts.local.yaml` (no dates today): parses unchanged.
3. **With the user's go-ahead:** extraction `--dry-run` on a few items; separately, the full run (writes only
   `config/install-history.local.yaml`).
4. The user's Novartis example: suggested dated lines (Dell → HDS, the date only the user knows) added to
   `accounts.local.yaml` only on a yes; rebuild on a yes; read-only Novartis probe showing the `changed:` line.

## Out of scope

- History moving ranks or regimes; history for vendor positions (briefs keep `asOf`); dates the news does not state.
