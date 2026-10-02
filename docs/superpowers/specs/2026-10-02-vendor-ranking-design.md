# Win-likelihood ranking per account segment

**Date:** 2026-10-02
**Status:** approved design, not yet planned
**Follows:** `2026-09-21-vendor-intel-graph-design.md` ("Vendors are not ranked within a segment … Ranking was
deliberately deferred as too complex") and `2026-10-02-watchlist-evidence-graph-design.md` (account events).
**Stacked on:** PR #65 (`feature/watchlist-evidence-graph`).

## Why, and what changes in the contract

The original design refused to rank because `position` is a four-value label with little signal (six of eight
vendors are Gartner Leaders) and "Dell leads" without its reasons is false confidence. That still holds for a
**market** order. This spec adds a different order, which the user chose: **win likelihood within one account and one
segment**, where incumbency, the axis the whole design rests on, does most of the work.

The contract changes explicitly: `competitive_position` gains a `ranking` per account segment, every entry carrying
its reasons. The existing `vendors` arrays stay unordered, and nothing ranks across accounts or from positions alone.

Decided with the user:

| Question | Decision |
|---|---|
| What a ranking answers | Win likelihood per account and segment |
| Method | Deterministic rules, no model call: same input, same order |
| What opens a segment held by a rival | **Declared triggers only**, in `accounts.local.yaml`; watchlist events never promote on their own (tagging noise, e.g. a EURETINA item tagged `it_move`) |
| Where it lives | A `ranking` field inside `competitive_position` (one tool: the local model fails at orchestration) |
| Budget (decided while planning) | Each segment shows the **top 3** (ties at 3 included) **plus the queried vendor**, with `ranked: <total>`; compact reasons; never trimmed |

Rejected: a separate `win_likelihood` tool (a second tool to choose and call), and sorting the existing `vendors`
arrays (ranking by ordering, without reasons).

## Declared triggers

### File

An optional `triggers` map per account in `config/accounts.local.yaml`, keyed by the closed segment set:

```yaml
accounts:
  roche:
    incumbents:
      storage-block: [everpure]
    triggers:
      # Install-base lifecycle facts that open a segment to a rival. Not a pipeline:
      # no stages, amounts or close dates.
      storage-block: "everpure arrays reach end of support 2027-03"
```

The accounts file is "deliberately not a CRM" and the design's scope line is "install base, never pipeline": a
trigger is a **fact about the installed base** (end of support, refresh due, a contract renewal date as a lifecycle
fact), never an opportunity, stage or amount. `config/accounts.example.yaml` gains a commented `triggers` block that
says so.

### Validation (`parseAccounts`, fails the rebuild before the wipe)

- The key must be in the closed segment set: `<account>: triggers.<key>` names the bad key.
- The value must be a non-empty string: `<account>: triggers.<segment> must be a non-empty description of the
  install-base event`.
- The segment must have declared, non-empty incumbents: `<account>: triggers.<segment> opens a segment held by a
  rival; declare its incumbents first`. A trigger on `[]` has nothing to displace; on an undeclared segment it would
  hide the "find out first" signal.
- A missing `triggers` key means no triggers.

### Graph and snapshot

- `accountToGraphFacts` writes the Account property `triggers` as a JSON string (`{"storage-block":"…"}`), since
  Neo4j properties cannot be maps; omitted when there are none.
- `ACCOUNTS_CYPHER` returns `a.triggers AS triggers`; `SnapshotAccount` gains `triggers: Record<string, string>`.
- Parsing is defensive: a missing property (graph built before this change) is `{}`; malformed JSON or a non-string
  value is `{}` plus a note `account <id>: unreadable triggers, ignored until the next rebuild`. It never throws.

## Ranking rules

Computed in the resolver (`competitive-position.ts`) from the snapshot alone: pure, no extra queries.

### Regime per account segment

| Segment state | Regime | Order |
|---|---|---|
| Not declared (absent from the account's declared segments) | `unknown` | `ranking: null` |
| Declared `[]` | `greenfield` | Everyone by position |
| Incumbents, no trigger | `defend` | Incumbents first (by position among themselves), then rivals by position |
| Incumbents and a declared trigger | `open` | Everyone by position; the incumbent wins a tie |

### Candidates and what is shown

The segment's incumbents plus every vendor with a `COMPETES_IN` position in that segment, **whatever the query**:
a Dell-only question still shows where Dell stands against its rivals there. Vendors whose position is `absent` are
excluded (unless incumbent: an installed vendor is always a candidate).

All candidates are ranked; the answer **shows** the entries with rank ≤ 3 (`RANKING_TOP`, ties at 3 included) plus the
queried vendor wherever it lands, and `ranked` gives the total number ranked. Found while planning: a full list for an
account question on a full graph (11 segments × up to 10 vendors) is ~7k of untrimmable JSON on answers already at the
24k cap.

### Position order and ties

`leader` > `strong` > `present` > unknown (no brief, `null`) > `absent` (incumbents only).

Ranks are competition ranks: equal keys share a rank and the next rank skips (1, 1, 3). In `defend`, the incumbent
group sits above the rivals whatever their positions. In `open`, the only tie-breaker is incumbency. Nothing else
breaks ties: never alphabetical order. Entries with equal rank are listed by vendor id for stable output, and the
shared rank number is what carries meaning.

### Reasons

Every entry has exactly two reasons, compact and fixed-vocabulary (the segment already carries `incumbents`, `regime`
and `trigger`, so nothing is repeated per vendor):

1. its role: `incumbent`, `rival` (defend/open) or `nobody installed` (greenfield);
2. its position: `<label>/<confidence>` (e.g. `leader/high`) or `no brief`.

### Shape

```ts
type Regime = "unknown" | "greenfield" | "defend" | "open";
interface RankedVendor { vendor: string; rank: number; reasons: string[] }
// SegmentView gains:
regime: Regime;
trigger: string | null;
ranking: RankedVendor[] | null; // null exactly when regime is "unknown"; top 3 + queried vendor
ranked: number;                 // how many candidates were ranked (0 when unknown)
```

`SegmentView.vendors` keeps its current content and order.

## Surfaces

### Answer JSON

- Per segment: `regime`, `trigger`, `ranking` (from the resolver, carried through `AnswerSegment`).
- Top level: `regimes`, one guidance line per regime present (like `modes`):
  - `open`: "a declared trigger opens the segment: position decides, incumbency only breaks ties"
  - `defend`: "the incumbent keeps the segment unless a trigger is declared: rivals rank behind it"
  - `greenfield`: "nobody is installed: position decides"
  - `unknown`: "no ranking until you record who is installed"
- Budget: `regime`, `trigger` and `ranking` are structure and are never trimmed.

### Chat block

Under a segment's `installed:` line (before its events):

```
    trigger: everpure arrays reach end of support 2027-03
    ranking (open): 1 dell (rival, leader/high) · 2 hpe (rival, strong/high) · 3 everpure (incumbent, no brief) · +1 more
```

(`+N more` when `ranked` exceeds the entries shown.)

`unknown` prints `    ranking: none, find out who is installed`. A `defend`/`greenfield` segment prints its ranking
line the same way, without a trigger line. Text trim order unchanged.

### MCP description

Replace "Positions are labels, not a ranking: never present vendors as ranked." with "Rank vendors only as `ranking`
gives them, per account and segment, with its reasons; never rank from positions alone, and never across accounts."

### Docs

CLAUDE.md (competitive_position sentence) and a one-line pointer under the 2026-09-21 spec's "Ranking was
deliberately deferred" paragraph.

## Testing

All unit tests use fakes.

- **Accounts:** valid triggers accepted and written as JSON; unknown segment, empty/non-string value, trigger without
  incumbents (undeclared and `[]`) each refused with their message; missing key = none; the example file parses.
- **Snapshot:** JSON parsed; missing = `{}`; malformed = `{}` + note, no throw.
- **Ranking:** one test per regime; `defend` keeps the incumbent above a leader rival; `open` puts a leader rival above
  the incumbent and the incumbent wins a tie; `absent` excluded unless incumbent; brief-less incumbent = position
  unknown; a vendor-only query ranks the rivals; ties share ranks (1, 1, 3) and are never broken alphabetically; every
  entry has its two reasons with confidence; top 3 with ties at 3 plus the queried vendor shown, `ranked` = total;
  `vendors` arrays unchanged.
- **Budget:** a full-graph answer fits 24k and keeps ranking/trigger at every trim step.
- **Chat:** trigger line, ranking line, `unknown` line.
- **MCP:** `npm --prefix mcp test`, `npm --prefix mcp run typecheck`.

Verification beyond tests:

1. `npm run typecheck`, `npm run typecheck:tests`, `npm test`.
2. Rebuild **dry run** on the real `accounts.local.yaml` (no triggers yet): parses unchanged.
3. Read-only Dell @ Roche probe on the live graph: `defend`, `greenfield`, `unknown` rankings.
4. `open` live only if the user adds a trigger to their `accounts.local.yaml` (their file; suggested, not edited
   without a yes) and approves a rebuild.

## Out of scope

- Ranking across accounts or segments ("where to spend effort").
- Events promoting vendors; 27B scoring.
- Any pipeline data in the accounts file.
