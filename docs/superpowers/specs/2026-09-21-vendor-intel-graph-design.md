# Vendor-intelligence knowledge layer and graph schema

**Date:** 2026-09-21
**Status:** implemented except the watchlist→`Evidence` live hook and legacy-document re-extraction
(plan: `docs/superpowers/plans/2026-10-01-competitive-position.md`; curated excerpts come from the brief
files and recent evidence from `watchlist.db` — see the plan's "Deliberate deviations")
**Target query:** *"What is Dell doing best for my accounts?"* — Dell's competitive
advantages per segment, mapped to what named big-pharma accounts need.

## Why

Three read-only audits on 2026-09-21 established that the system cannot answer that
question, and that the cause is data, not retrieval:

- **Vector DB** — `knowledge_base_mlx` holds 8,175 chunks: 7,227 (88.4%) undifferentiated
  Google-News archive, 691 (8.5%) watchlist items, 252 (3.1%) legacy cyber documents.
  The news chunks carry no entity/domain tags, so vendor queries cannot exclude them.
  `entity` and `domain` are stored comma-joined, which makes ChromaDB `$eq` filtering
  impossible.
- **Graph** — every label models pharma cybersecurity (`ThreatActor`, `Attack`,
  `AttackVector`, `Drug`, `RegulatoryBody`). No competitor, deal, account, peer-set or
  segment exists. 174 distinct relationship types live against 20 declared, because
  `src/api/knowledge.ts` validates labels but not relationships. `grep -ci graph
  src/services/watchlist-ingest.ts` returns 0: the watchlist never feeds the graph, so
  the 880 nodes are a frozen snapshot of the old knowledge base.
- **Coverage** — 67 entities have feeds, 29 produced anything. `dell` = 4 EDGAR stubs
  with no RSS configured; `hpe` = 202 items, 45% of the corpus, from a single
  engineering blog. 39 entities have zero coverage. All 188 topic queries returned
  nothing. No infrastructure knowledge file exists anywhere.

The thin Dell/HPE answer was the system behaving correctly over nine Dell term hits.

## Decisions

| Decision | Choice |
|---|---|
| Knowledge source | Curated baseline, feed events layered on top |
| Accounts | Named list with per-account context, kept local (gitignored) |
| Existing graph | Rebuilt clean; cyber history re-extracted as need-evidence |
| Division of labour | **Graph plans, vectors evidence** |
| Segments | Closed set of 10 |
| Scope line | Install base, never pipeline |
| Position values | `leader \| strong \| present \| absent`, unranked |
| Primary axis | **Incumbency**, not competitive position |
| Confidence | `high \| medium \| low` — rates the evidence, not the vendor |

## Data model

### Graph

```
Labels:   Vendor · Segment · Product · Account · Need · Evidence

(Vendor)   -[:OFFERS]->        (Product)
(Product)  -[:IN_SEGMENT]->    (Segment)
(Vendor)   -[:COMPETES_IN]->   (Segment)  {position, confidence, rationale, asOf}
(Account)  -[:HAS_NEED]->      (Need)     {priority, asOf}
(Need)     -[:ADDRESSED_BY]->  (Segment)
(Account)  -[:USES]->          (Vendor)   {segment, since, asOf}
(Evidence) -[:SUPPORTS]->      (node|edge) {url, publishedAt}
```

Seven relationship types. **Both labels and relationship types are validated at write
time**; anything outside the closed set is rejected. This is the direct fix for the
174-type sprawl.

`segments` (10, closed):

```
compute-ai         compute-standard
storage-block      storage-file       storage-object
data-protection    hci                networking
client             services
```

The splits are not cosmetic: they are the granularity at which **incumbency actually
exists**. An account can run NetApp in file, Dell in block and a third vendor in object,
with different rivals in each -- this brief argues PowerScale against VAST and WEKA in
file but PowerMax against IBM and Huawei in block. A single `storage` segment cannot
express that, and incumbency is the primary axis.

`ai-infrastructure` from the first draft is dissolved: GPU servers are `compute-ai`,
AI filesystems are `storage-file`, and the remainder was a cross-segment bundle rather
than a segment.

Vendor ids follow the vendor's current legal name, not its historical one: Pure Storage
became Everpure in SEC filings on 2026-01-09, so the id is `everpure` everywhere and
"Pure Storage" survives only as a matching alias.

`needs`: `gxp-compliance, rnd-compute, ai-factory, cyber-resilience, data-sovereignty,
manufacturing-ot, cost-optimisation, sustainability`

**Deliberately omitted:** a pairwise `BETTER_THAN` edge. Comparative strength is the
`position` property plus curated prose. A pairwise edge explodes combinatorially and
encodes a judgement that changes faster than the graph can track.

### Vector layer

One brief per `(vendor, segment)`, so every metadata value is a scalar and therefore
filterable — the constraint that today's comma-joined fields violate.

`source_tier` values:

| Tier | Content | Retrieval treatment |
|---|---|---|
| `curated` | `knowledge/vendors/*.md` vendor briefs | preferred for vendor questions |
| `reference` | legacy `knowledge/*.md` documents | background, not vendor evidence |
| `feed` | watchlist items | freshness and citation |
| `archive` | Google-News back-catalogue | excluded from vendor queries |

Feed items keep their comma-joined lists for display and gain scalar `primary_entity`
and `primary_segment` for filtering.

## Authoring and ingestion

A brief is one file carrying both structure and prose:

```markdown
---
vendor: dell
segment: storage
position: leader
confidence: high
as_of: 2026-09-21
products: [PowerStore, PowerScale, PowerMax]
competitors: [hpe, netapp, everpure, vast-data]
rationale: >
  ...
sources:
  - https://www.blocksandfiles.com/...
---

## Portfolio ...
```

Frontmatter becomes graph facts; the body becomes vector chunks. One source of truth
per fact, so the two layers cannot drift.

**Frontmatter is strict, prose is free.** A product is declared in exactly one brief --
the segment it is *sold* as -- so the graph gets one `OFFERS` edge per product. The body
may discuss anything relevant: `dell-storage.md` declares nine storage products while its
body argues cyber-resilience at length, because that is what a pharma account asks about.
The machine contract and the human document have different jobs.

Accounts are declared in `config/accounts.local.yaml` (gitignored; a committed
`config/accounts.example.yaml` documents the shape), validated the way
`watchlist-config.ts` validates domains.

**The builder is deterministic wherever it can be:**

| Source | Extraction | Produces |
|---|---|---|
| `knowledge/vendors/*.md` frontmatter | deterministic parse | Vendor, Product, Segment, COMPETES_IN |
| `config/accounts.local.yaml` | deterministic parse | Account, HAS_NEED, USES |
| `config/needs.yaml` | deterministic parse | Need, ADDRESSED_BY |
| watchlist items (live hook) | deterministic, from existing tags | Evidence, SUPPORTS |
| legacy `knowledge/*.md` | LLM, constrained to one label + one edge | Evidence → SUPPORTS → Need |

The LLM may emit only `Evidence` and `SUPPORTS`. The old builder let an LLM invent both
labels and relationships across 40 files; that is how 20 declared types became 174.

`watchlist-ingest.ts` gains a best-effort, non-fatal graph write beside its existing
`embed()` call, so a Neo4j outage cannot fail a feed run.

`reindex.ts` reads three sources — `knowledge/`, `raw_documents/` and `watchlist.db` —
making the index reproducible.

### Source policy for curated briefs

1. **Primary:** blocksandfiles.com — independent, current, covers this market.
2. **Vendor material:** authoritative only for what products exist and what they do.
   Never evidence of competitive superiority.
3. **Gartner Magic Quadrant:** paywalled content is not accessed. Vendor-published
   licensed reprints may be used, and the brief must note that such reprints are
   self-selected — vendors publish the quadrants they win.
4. Every non-obvious claim carries an inline source marker.
5. A "where this vendor is weak" section is mandatory in every brief.

Blocks & Files covers storage, data-protection and AI-infrastructure well and compute,
networking, client and services poorly. Briefs in the weaker segments must carry a lower
`confidence`, which is what the field exists for.

## Query path

`graph_search` is replaced by one composite tool:

```
competitive_position(vendor?, account?, segment?)
```

Resolution for `competitive_position(vendor: "dell")`:

1. accounts from `accounts.local.yaml`
2. `USES` → **who is incumbent per segment** -- resolved first, see below
3. `HAS_NEED` → the needs those accounts have
4. `ADDRESSED_BY` → the segments those needs imply
5. `COMPETES_IN` → the vendor's position and rationale, per segment
6. fetch curated chunks filtered `vendor`, `segment`, `source_tier: curated`
7. attach recent `Evidence`

**Incumbency is the primary axis, not competitive position.** In enterprise
infrastructure sales, who already holds the account outweighs function and price, so the
same competitive fact means opposite things depending on it -- Dell storage sitting
mid-quadrant with shrinking hybrid lines is survivable where Dell is incumbent and
disqualifying where a rival is. The tool therefore answers in one of four modes per
segment:

| Incumbency | Mode | What matters |
|---|---|---|
| The vendor | defend / expand | roadmap, lifecycle, adjacent attach; function gaps tolerable |
| A rival | displace | needs a disqualifying weakness or a triggering event |
| Nobody (declared `[]`) | greenfield | function and price actually decide |
| Not recorded (segment omitted) | unknown | find out who is installed before choosing a mode |

Vendors are **not ranked** within a segment: `position` is a four-value label whose own
evidence says the label carries little signal (six of eight vendors are Gartner Leaders).
Ranking was deliberately deferred as too complex. The tool must therefore return
`rationale` alongside `position` -- the rationale is where the honesty lives, and
"Dell leads in storage" without it is precisely the false confidence this design exists
to remove.

> **2026-10-02:** win likelihood per account segment is now ranked (`2026-10-02-vendor-ranking-design.md`).
> A market order across accounts stays unranked, for the reason above.

One tool rather than two primitives, because the local model demonstrably fails at
orchestration — on 2026-09-21 it called three tools by stale names and then batched them
illegally. The result is compact structured JSON: positions, confidence, short excerpts,
source URLs. **No embeddings and no full documents** — a prior incident put 48k tokens of
embeddings into a single tool result.

A segment with a position but no brief returns the structure and states that no curated
evidence exists, rather than letting the model improvise.

## Migration order

Ordered so nothing irreversible happens early:

1. Export the existing graph (880 nodes, provenance unknown).
2. **Backfill `source_tier` by metadata update, not re-embedding.** Cheapest win, fully
   independent, ships first.
3. Finish `reindex.ts` reading `watchlist.db`.
4. Fix `/api/graph/rebuild`, currently gated on the Ollama stack and a no-op on MLX.
5. Rebuild the graph from deterministic sources plus constrained extraction.
6. Swap the MCP tool; retire `graph_search`.

## Testing

Every unit takes injected dependencies, following the existing `ReindexDeps` and
watchlist harness patterns. **No test touches live Neo4j or ChromaDB** — a subagent has
twice wiped the live ChromaDB, so this is a hard rule, and the graph builder takes a fake
writer in tests.

Coverage: schema validation rejects unknown labels *and* unknown relationship types;
frontmatter round-trips including `confidence`; query resolution runs against a fixture
graph; `confidence` propagates into the tool result; `source_tier` backfill is idempotent
and never re-embeds.

## The CRM boundary

Modelling an account's install base takes this close to CRM territory, deliberately and
with a line drawn:

| | Holds | Owner |
|---|---|---|
| **Install base** | what is deployed, per account per segment, since when | this system |
| **Pipeline** | opportunities, stages, amounts, close dates, forecast | the real CRM |

Install base belongs here: it is slow-moving, it is what makes an answer account-specific
rather than generic, and no CRM report presents it in a form a model can reason over.
Pipeline is where this stops. Modelling deal stages would mean building a worse
Salesforce and inheriting its data-entry burden, and the question this system exists to
answer never needs it. Revisit only under real pressure, never by drift.

## Out of scope

- The iCloud weekly Q&A document pipeline. It is the natural authoring path for curated
  briefs and is designed separately.
- Fixing feed coverage (Dell has no RSS; 265 of 300 feeds return nothing). Tracked as its
  own work; this design does not depend on it.
