# Competitive Position Query Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer *"What is Dell doing best for my accounts?"* with one composite tool, `competitive_position(vendor?, account?, segment?)`, that resolves incumbency per segment before anything else; replace the old-schema `graph_search` MCP tool with it; and make `/api/graph/rebuild` a deterministic rebuild that works on every stack.

**Architecture:** A pure resolver (`competitive-position.ts`) turns a graph snapshot plus a query into per-account, per-segment incumbency modes (defend / displace / greenfield). A reader (`competitive-graph.ts`) fetches that snapshot from Neo4j with four read-only Cypher queries, attaches short excerpts parsed straight from the curated brief files (`vendor-brief-excerpts.ts`) and recent watchlist items, and trims the answer to a fixed character budget. The rebuild logic moves out of `scripts/rebuild-vendor-graph.ts` into `vendor-graph-rebuild.ts`, runs in one write transaction, and replaces the Ollama-only Python builder behind `POST /api/graph/rebuild`.

**Tech Stack:** TypeScript ESM (`module: Node16`, strict), Express, `neo4j-driver`, `yaml`, Jest (ESM), MCP SDK + zod in `mcp/`.

**Spec:** `docs/superpowers/specs/2026-09-21-vendor-intel-graph-design.md` — sections "Query path" and "Migration order" steps 4 and 6. Steps 1–3 and the graph writer already shipped (`graph-schema.ts`, `graph-accounts.ts`, `graph-writer.ts`, `scripts/rebuild-vendor-graph.ts`, `source-tier.ts`).

## Global Constraints

- Segments are the closed set in `src/services/graph-schema.ts` `SEGMENTS` (11 values today, including `data-platform`); never hardcode a copy.
- Position values `leader | strong | present | absent`, **unranked**: "Vendors are **not ranked** within a segment". Every vendor list is alphabetical.
- Confidence `high | medium | low` — "rates the evidence, not the vendor".
- "The tool must therefore return `rationale` alongside `position`".
- "The result is compact structured JSON: positions, confidence, short excerpts, source URLs. **No embeddings and no full documents**".
- "A segment with a position but no brief returns the structure and states that no curated evidence exists, rather than letting the model improvise."
- Scope line: install base, never pipeline — no opportunity, stage, amount or forecast fields anywhere.
- Every model call is local; this feature makes **no** model call at all.
- Tests never touch live services (Neo4j, ChromaDB, model servers, launchd, Telegram). Inject fakes. Never prove RED against live data.
- ES modules only, siblings imported as `./x.js`; no `any` (use `unknown` + guards); comments in English; kebab-case files.
- Run `npm run typecheck` after every code change; `npm --prefix mcp run typecheck` after MCP changes.
- Commit prefixes `feat:` `fix:` `refactor:` `test:` `docs:`; end every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

### Deliberate deviations from the spec (decided while planning, 2026-10-01)

1. **Curated excerpts come from the brief files, not ChromaDB.** Spec step 6 says "fetch curated chunks filtered `vendor`, `segment`, `source_tier: curated`". The chunks are cut from `knowledge/vendors/*.md`, and the chunks carry no scalar `vendor`/`segment` metadata today. Reading the brief file gives the same curated content with no embedding call, no stack dependency and no index-guard refusal, and lets us return the brief's headline claims rather than arbitrary chunk boundaries.
2. **Recent evidence comes from `watchlist.db`, not `Evidence` nodes.** The live graph holds no `Evidence` nodes (the watchlist→graph hook is unbuilt). Watchlist entity ids equal the graph's vendor ids (`dell`, `hpe`, `everpure`, `netapp`), so recent items are read directly, filtered by the IT domains that correspond to the cited segments (`SEGMENT_DOMAINS`).
3. **Out of scope, left for a later plan:** the watchlist→`Evidence` live hook, constrained LLM re-extraction of legacy documents as need-evidence, and the web chat's `queryGraphForChat` keyword lookup (`src/api/chat.ts:292`), which keeps working against the new nodes' `name` property.

## Review Focus

1. **A rebuild with a broken `accounts.local.yaml` must not wipe the accounts.** The old script skipped any accounts error; with a wipe-and-write rebuild that silently deletes every Account. Only a *missing* file is skipped; a present-but-invalid file fails the rebuild before anything is written (Task 6, "invalid accounts file throws before the transaction").
2. **Human names, not ids.** Users type "Pure Storage", "Dell Technologies", "Genentech", "Storage Block". Vendor aliases come from `config/watchlist.yaml`; account aliases from the graph; segments are normalised (Task 1 and Task 3 alias tests).
3. **The answer stays small on a full graph.** Eight vendors × eleven segments × three accounts must not produce a 100 KB tool result; the budget trims details, then claims, then rationale length, and says so in a note (Task 3, budget tests).
4. **No ranking leaks in through ordering.** A `leader` must not be listed before a `present` vendor that sorts earlier alphabetically (Task 1, "never ranks").
5. **A vendor with no brief reads as unknown, not absent.** An incumbent with no `COMPETES_IN` edge must show `position: null` and a note, never `absent` (Task 1, "unknown, not absent").

---

## File Structure

| File | Responsibility |
|---|---|
| `src/services/competitive-position.ts` (new) | Pure resolver: name resolution, segment selection, incumbency modes, notes. No I/O. |
| `src/services/vendor-brief-excerpts.ts` (new) | Parse `knowledge/vendors/*.md` into headline claims (strong / weak) and sources. |
| `src/services/competitive-graph.ts` (new) | Read the snapshot from Neo4j (injected `runCypher`), attach excerpts and evidence, enforce the size budget. |
| `src/services/vendor-graph-rebuild.ts` (new) | Collect graph facts from briefs/needs/accounts; write them in one transaction. |
| `src/services/export-wiring.ts` (modify) | `itemsFor` gains an optional `domains` filter. |
| `src/api/graph.ts` (modify) | Becomes `createGraphRouter(deps)`; adds `POST /competitive-position`; drops `POST /search`; rebuild uses the TS rebuild. |
| `src/services/graph-store.ts` (modify) | Drop `searchGraph` and `GraphSearchResult` (only `/search` used them). |
| `scripts/rebuild-vendor-graph.ts` (modify) | Thin CLI over `vendor-graph-rebuild.ts`. |
| `mcp/src/tools/graph.ts` (modify) | `competitive_position` replaces `graph_search`. |
| `python/graph_builder.py`, `__tests__/graph-stack-gate.test.ts` (delete) | Old-schema LLM builder and the test pinning its Ollama gate. |
| `README.md`, `mcp/README.md`, `CLAUDE.md`, spec (modify) | Docs. |

---

### Task 1: Pure competitive-position resolver

**Files:**
- Create: `src/services/competitive-position.ts`
- Test: `__tests__/competitive-position.test.ts`

**Interfaces:**
- Consumes: `SEGMENTS` from `src/services/graph-schema.ts`.
- Produces (exact):
  - `type IncumbencyMode = "defend" | "displace" | "greenfield"`
  - `const MODE_GUIDANCE: Record<IncumbencyMode, string>`
  - `interface CompetitiveQuery { vendor?: string; account?: string; segment?: string }`
  - `interface SnapshotAccount { id: string; name: string; aliases: string[]; needs: string[]; uses: Array<{ segment: string; vendor: string }> }`
  - `interface SnapshotPosition { vendor: string; segment: string; position: string; confidence: string; rationale: string; asOf: string }`
  - `interface GraphSnapshot { accounts: SnapshotAccount[]; needSegments: Record<string, string[]>; positions: SnapshotPosition[]; vendors: string[]; vendorAliases: Record<string, string> }`
  - `interface Standing { position: string; confidence: string; rationale: string; asOf: string }`
  - `interface VendorInSegment { vendor: string; mode: IncumbencyMode; position: string | null }`
  - `interface SegmentView { segment: string; via: string[]; incumbents: string[]; vendors: VendorInSegment[] }`
  - `interface AccountView { account: string; name: string; needs: string[]; segments: SegmentView[] }`
  - `interface CompetitiveResolution { query: { vendor: string | null; account: string | null; segment: string | null }; market: Array<{ vendor: string; segment: string; position: string }>; accounts: AccountView[]; standings: Record<string, Standing>; notes: string[] }`
  - `type ResolveResult = { ok: true; value: CompetitiveResolution } | { ok: false; error: string }`
  - `function normaliseName(raw: string): string`
  - `function standingKey(vendor: string, segment: string): string` → `"vendor/segment"`
  - `function resolveCompetitivePosition(snap: GraphSnapshot, query: CompetitiveQuery): ResolveResult`

- [ ] **Step 1: Write the failing tests**

Create `__tests__/competitive-position.test.ts`:

```ts
import { describe, expect, it } from "@jest/globals";
import {
  resolveCompetitivePosition,
  type CompetitiveResolution,
  type GraphSnapshot,
} from "../src/services/competitive-position.js";

function snapshot(overrides: Partial<GraphSnapshot> = {}): GraphSnapshot {
  return {
    accounts: [
      {
        id: "roche",
        name: "Roche",
        aliases: ["Genentech"],
        needs: ["rnd-compute", "cyber-resilience"],
        uses: [
          { segment: "storage-block", vendor: "dell" },
          { segment: "storage-file", vendor: "netapp" },
          { segment: "compute-ai", vendor: "hpe" },
        ],
      },
      { id: "novartis", name: "Novartis", aliases: [], needs: ["ai-factory"], uses: [] },
    ],
    needSegments: {
      "rnd-compute": ["compute-ai", "compute-standard", "storage-file"],
      "ai-factory": ["compute-ai", "storage-file", "networking"],
      "cyber-resilience": ["data-protection", "storage-block"],
    },
    positions: [
      { vendor: "dell", segment: "storage-block", position: "leader", confidence: "high", rationale: "PowerMax and PowerStore.", asOf: "2026-09-21" },
      { vendor: "dell", segment: "storage-file", position: "strong", confidence: "high", rationale: "PowerScale.", asOf: "2026-09-21" },
      { vendor: "hpe", segment: "storage-block", position: "strong", confidence: "medium", rationale: "Alletra.", asOf: "2026-09-21" },
      { vendor: "hpe", segment: "storage-file", position: "strong", confidence: "medium", rationale: "Alletra MP file.", asOf: "2026-09-21" },
    ],
    vendors: ["dell", "hpe", "netapp"],
    vendorAliases: { "dell-technologies": "dell" },
    ...overrides,
  };
}

function ok(result: ReturnType<typeof resolveCompetitivePosition>): CompetitiveResolution {
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.value;
}

describe("resolveCompetitivePosition — input", () => {
  it("needs at least one of vendor, account or segment", () => {
    expect(resolveCompetitivePosition(snapshot(), {})).toEqual({
      ok: false,
      error: "give at least one of vendor, account or segment",
    });
  });

  it("names the known vendors when the vendor is unknown", () => {
    const result = resolveCompetitivePosition(snapshot(), { vendor: "Lenovo" });
    expect(result).toEqual({ ok: false, error: 'unknown vendor "Lenovo" (known: dell, hpe, netapp)' });
  });

  it("resolves a vendor by case, spacing and alias", () => {
    expect(ok(resolveCompetitivePosition(snapshot(), { vendor: "  DELL " })).query.vendor).toBe("dell");
    expect(ok(resolveCompetitivePosition(snapshot(), { vendor: "Dell Technologies" })).query.vendor).toBe("dell");
  });

  it("ignores an alias that points at a vendor the graph does not hold", () => {
    const result = resolveCompetitivePosition(snapshot({ vendorAliases: { "pure-storage": "everpure" } }), {
      vendor: "Pure Storage",
    });
    expect(result.ok).toBe(false);
  });

  it("resolves an account by id, name or alias, and names the known ones otherwise", () => {
    expect(ok(resolveCompetitivePosition(snapshot(), { account: "Genentech" })).query.account).toBe("roche");
    expect(resolveCompetitivePosition(snapshot(), { account: "Pfizer" })).toEqual({
      ok: false,
      error: 'unknown account "Pfizer" (known: novartis, roche)',
    });
  });

  it("normalises a segment and rejects one outside the closed set", () => {
    expect(ok(resolveCompetitivePosition(snapshot(), { segment: "Storage Block" })).query.segment).toBe("storage-block");
    const result = resolveCompetitivePosition(snapshot(), { segment: "storage" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^unknown segment "storage" \(known: compute-ai, /);
  });
});

describe("resolveCompetitivePosition — the Dell question", () => {
  const answer = ok(resolveCompetitivePosition(snapshot(), { vendor: "dell" }));

  it("walks each account's need-implied segments in the closed-set order", () => {
    const roche = answer.accounts.find((a) => a.account === "roche");
    expect(roche?.segments.map((s) => s.segment)).toEqual([
      "compute-ai",
      "compute-standard",
      "storage-block",
      "storage-file",
      "data-protection",
    ]);
  });

  it("resolves incumbency per segment into defend, displace or greenfield", () => {
    const roche = answer.accounts.find((a) => a.account === "roche");
    const modes = Object.fromEntries((roche?.segments ?? []).map((s) => [s.segment, s.vendors[0]]));
    expect(modes["storage-block"]).toEqual({ vendor: "dell", mode: "defend", position: "leader" });
    expect(modes["storage-file"]).toEqual({ vendor: "dell", mode: "displace", position: "strong" });
    expect(modes["compute-ai"]).toEqual({ vendor: "dell", mode: "displace", position: null });
    expect(modes["compute-standard"]).toEqual({ vendor: "dell", mode: "greenfield", position: null });
  });

  it("records which needs put a segment in play, and who is installed there", () => {
    const roche = answer.accounts.find((a) => a.account === "roche");
    const file = roche?.segments.find((s) => s.segment === "storage-file");
    expect(file?.via).toEqual(["rnd-compute"]);
    expect(file?.incumbents).toEqual(["netapp"]);
  });

  it("treats an account with no incumbents as greenfield everywhere", () => {
    const novartis = answer.accounts.find((a) => a.account === "novartis");
    expect(novartis?.segments.map((s) => s.vendors[0].mode)).toEqual(["greenfield", "greenfield", "greenfield"]);
  });

  it("returns the vendor's market positions and the full standing for every cited pair", () => {
    expect(answer.market).toEqual([
      { vendor: "dell", segment: "storage-block", position: "leader" },
      { vendor: "dell", segment: "storage-file", position: "strong" },
    ]);
    expect(Object.keys(answer.standings).sort()).toEqual(["dell/storage-block", "dell/storage-file"]);
    expect(answer.standings["dell/storage-block"]).toEqual({
      position: "leader",
      confidence: "high",
      rationale: "PowerMax and PowerStore.",
      asOf: "2026-09-21",
    });
  });

  it("says a missing brief means unknown, not absent", () => {
    expect(answer.notes).toContain("no curated brief for dell in compute-ai: its position there is unknown, not absent");
  });
});

describe("resolveCompetitivePosition — other shapes", () => {
  it("never ranks: vendors in a segment are alphabetical whatever their position", () => {
    const snap = snapshot({
      positions: [
        { vendor: "hpe", segment: "storage-block", position: "leader", confidence: "high", rationale: "r", asOf: "" },
        { vendor: "dell", segment: "storage-block", position: "present", confidence: "low", rationale: "r", asOf: "" },
      ],
    });
    const answer = ok(resolveCompetitivePosition(snap, { account: "roche", segment: "storage-block" }));
    expect(answer.accounts[0].segments[0].vendors.map((v) => v.vendor)).toEqual(["dell", "hpe"]);
    expect(answer.market.map((m) => m.vendor)).toEqual(["dell", "hpe"]);
  });

  it("lists every briefed vendor and every incumbent when no vendor is given", () => {
    const answer = ok(resolveCompetitivePosition(snapshot(), { account: "roche", segment: "storage-file" }));
    expect(answer.accounts[0].segments[0].vendors).toEqual([
      { vendor: "dell", mode: "displace", position: "strong" },
      { vendor: "hpe", mode: "displace", position: "strong" },
      { vendor: "netapp", mode: "defend", position: null },
    ]);
    expect(answer.notes).toContain("no curated brief for netapp in storage-file: its position there is unknown, not absent");
  });

  it("keeps a segment the vendor holds even when no need implies it", () => {
    const snap = snapshot({
      accounts: [{ id: "sandoz", name: "Sandoz", aliases: [], needs: [], uses: [{ segment: "storage-block", vendor: "dell" }] }],
    });
    const answer = ok(resolveCompetitivePosition(snap, { vendor: "dell" }));
    expect(answer.accounts[0].segments).toEqual([
      { segment: "storage-block", via: [], incumbents: ["dell"], vendors: [{ vendor: "dell", mode: "defend", position: "leader" }] },
    ]);
  });

  it("says so when an account declares no needs and no vendor pins a segment", () => {
    const snap = snapshot({ accounts: [{ id: "sandoz", name: "Sandoz", aliases: [], needs: [], uses: [] }] });
    const answer = ok(resolveCompetitivePosition(snap, { account: "sandoz" }));
    expect(answer.accounts[0].segments).toEqual([]);
    expect(answer.notes).toContain("sandoz declares no needs, so no segment is in play there");
  });

  it("explains how to declare accounts when there are none", () => {
    const answer = ok(resolveCompetitivePosition(snapshot({ accounts: [] }), { vendor: "dell" }));
    expect(answer.accounts).toEqual([]);
    expect(answer.notes).toContain(
      "no accounts are declared: copy config/accounts.example.yaml to config/accounts.local.yaml and rebuild the graph",
    );
  });

  it("says when no brief places the vendor anywhere", () => {
    const answer = ok(resolveCompetitivePosition(snapshot(), { vendor: "netapp" }));
    expect(answer.market).toEqual([]);
    expect(answer.notes).toContain("no curated brief places netapp in any segment: its position is unknown, not absent");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- __tests__/competitive-position.test.ts`
Expected: FAIL — `Cannot find module '../src/services/competitive-position.js'`.

- [ ] **Step 3: Implement `src/services/competitive-position.ts`**

```ts
// Answers "what is <vendor> doing best for my accounts?" from a snapshot of the
// vendor-intelligence graph. Pure: no Neo4j, no files -- competitive-graph.ts
// reads the snapshot, this decides what it means.
//
// Incumbency is resolved first, per segment, because the same competitive fact
// means opposite things depending on who already holds the account
// (docs/superpowers/specs/2026-09-21-vendor-intel-graph-design.md, "Query path").
// Vendors are never ranked: every list is alphabetical, whatever its position
// label says -- six of eight vendors are Gartner Leaders, so the label alone
// carries little signal and ordering by it would invent one.
import { SEGMENTS } from "./graph-schema.js";

export type IncumbencyMode = "defend" | "displace" | "greenfield";

export const MODE_GUIDANCE: Record<IncumbencyMode, string> = {
  defend:
    "the vendor is installed: defend and expand through roadmap, lifecycle and adjacent attach; function gaps are tolerable",
  displace: "a rival is installed: displacing it needs a disqualifying weakness or a triggering event",
  greenfield: "nobody is installed: function and price actually decide",
};

export interface CompetitiveQuery {
  vendor?: string;
  account?: string;
  segment?: string;
}

export interface SnapshotAccount {
  id: string;
  name: string;
  aliases: string[];
  needs: string[];
  uses: Array<{ segment: string; vendor: string }>;
}

export interface SnapshotPosition {
  vendor: string;
  segment: string;
  position: string;
  confidence: string;
  rationale: string;
  asOf: string;
}

export interface GraphSnapshot {
  accounts: SnapshotAccount[];
  needSegments: Record<string, string[]>;
  positions: SnapshotPosition[];
  vendors: string[];
  /** Normalised alias -> vendor id, e.g. "pure-storage" -> "everpure". */
  vendorAliases: Record<string, string>;
}

export interface Standing {
  position: string;
  confidence: string;
  rationale: string;
  asOf: string;
}

export interface VendorInSegment {
  vendor: string;
  mode: IncumbencyMode;
  /** null when no brief places the vendor in this segment: unknown, not absent. */
  position: string | null;
}

export interface SegmentView {
  segment: string;
  /** The account's needs that put this segment in play; empty when only the vendor's own install does. */
  via: string[];
  incumbents: string[];
  vendors: VendorInSegment[];
}

export interface AccountView {
  account: string;
  name: string;
  needs: string[];
  segments: SegmentView[];
}

export interface CompetitiveResolution {
  query: { vendor: string | null; account: string | null; segment: string | null };
  /** Positions independent of any account, for the queried vendor and/or segment. */
  market: Array<{ vendor: string; segment: string; position: string }>;
  accounts: AccountView[];
  /**
   * Rationale and confidence once per cited vendor/segment pair, keyed by
   * standingKey. Kept out of the account views so a pair cited by three
   * accounts is not repeated three times.
   */
  standings: Record<string, Standing>;
  notes: string[];
}

export type ResolveResult = { ok: true; value: CompetitiveResolution } | { ok: false; error: string };

export function normaliseName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "-");
}

export function standingKey(vendor: string, segment: string): string {
  return `${vendor}/${segment}`;
}

const SEGMENT_ORDER = new Map<string, number>(SEGMENTS.map((segment, i) => [segment, i]));

function bySegment(a: string, b: string): number {
  return (SEGMENT_ORDER.get(a) ?? SEGMENTS.length) - (SEGMENT_ORDER.get(b) ?? SEGMENTS.length);
}

function resolveVendor(raw: string, snap: GraphSnapshot): string | null {
  const key = normaliseName(raw);
  if (snap.vendors.includes(key)) return key;
  const aliased = snap.vendorAliases[key];
  return aliased !== undefined && snap.vendors.includes(aliased) ? aliased : null;
}

function resolveAccount(raw: string, snap: GraphSnapshot): SnapshotAccount | null {
  const key = normaliseName(raw);
  return snap.accounts.find((a) => [a.id, a.name, ...a.aliases].some((name) => normaliseName(name) === key)) ?? null;
}

export function resolveCompetitivePosition(snap: GraphSnapshot, query: CompetitiveQuery): ResolveResult {
  if (!query.vendor && !query.account && !query.segment) {
    return { ok: false, error: "give at least one of vendor, account or segment" };
  }

  let vendor: string | null = null;
  if (query.vendor) {
    vendor = resolveVendor(query.vendor, snap);
    if (vendor === null) {
      return { ok: false, error: `unknown vendor "${query.vendor}" (known: ${[...snap.vendors].sort().join(", ")})` };
    }
  }

  let segment: string | null = null;
  if (query.segment) {
    const key = normaliseName(query.segment);
    if (!SEGMENT_ORDER.has(key)) {
      return { ok: false, error: `unknown segment "${query.segment}" (known: ${SEGMENTS.join(", ")})` };
    }
    segment = key;
  }

  let scope = snap.accounts;
  if (query.account) {
    const account = resolveAccount(query.account, snap);
    if (account === null) {
      const known = snap.accounts.map((a) => a.id).sort().join(", ") || "none declared";
      return { ok: false, error: `unknown account "${query.account}" (known: ${known})` };
    }
    scope = [account];
  }

  const positionOf = new Map(snap.positions.map((p) => [standingKey(p.vendor, p.segment), p]));
  const standings: Record<string, Standing> = {};
  const notes = new Set<string>();

  // Records the full standing once and returns the bare label for the views.
  const cite = (v: string, seg: string): string | null => {
    const p = positionOf.get(standingKey(v, seg));
    if (p === undefined) return null;
    standings[standingKey(v, seg)] = { position: p.position, confidence: p.confidence, rationale: p.rationale, asOf: p.asOf };
    return p.position;
  };

  const market =
    vendor !== null || segment !== null
      ? snap.positions
          .filter((p) => (vendor === null || p.vendor === vendor) && (segment === null || p.segment === segment))
          .sort((a, b) => bySegment(a.segment, b.segment) || a.vendor.localeCompare(b.vendor))
          .map((p) => ({ vendor: p.vendor, segment: p.segment, position: cite(p.vendor, p.segment) ?? p.position }))
      : [];
  if (vendor !== null && market.length === 0) {
    notes.add(
      `no curated brief places ${vendor} ${segment !== null ? `in ${segment}` : "in any segment"}: its position is unknown, not absent`,
    );
  }

  if (snap.accounts.length === 0) {
    notes.add("no accounts are declared: copy config/accounts.example.yaml to config/accounts.local.yaml and rebuild the graph");
  }

  const accounts = scope.map((account): AccountView => {
    const inPlay = new Set<string>();
    if (segment !== null) {
      inPlay.add(segment);
    } else {
      for (const need of account.needs) for (const s of snap.needSegments[need] ?? []) inPlay.add(s);
      // Where the vendor is installed is always worth discussing (defend), need or not.
      if (vendor !== null) for (const use of account.uses) if (use.vendor === vendor) inPlay.add(use.segment);
    }
    if (inPlay.size === 0) notes.add(`${account.id} declares no needs, so no segment is in play there`);

    const segments = [...inPlay].sort(bySegment).map((seg): SegmentView => {
      const incumbents = [...new Set(account.uses.filter((u) => u.segment === seg).map((u) => u.vendor))].sort();
      const names =
        vendor !== null
          ? [vendor]
          : [...new Set([...snap.positions.filter((p) => p.segment === seg).map((p) => p.vendor), ...incumbents])].sort();

      const vendors = names.map((v): VendorInSegment => {
        const position = cite(v, seg);
        if (position === null) notes.add(`no curated brief for ${v} in ${seg}: its position there is unknown, not absent`);
        const mode: IncumbencyMode = incumbents.includes(v) ? "defend" : incumbents.length > 0 ? "displace" : "greenfield";
        return { vendor: v, mode, position };
      });

      const via = account.needs.filter((need) => (snap.needSegments[need] ?? []).includes(seg));
      return { segment: seg, via, incumbents, vendors };
    });

    return { account: account.id, name: account.name, needs: account.needs, segments };
  });

  return {
    ok: true,
    value: {
      query: { vendor, account: query.account ? scope[0].id : null, segment },
      market,
      accounts,
      standings,
      notes: [...notes],
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- __tests__/competitive-position.test.ts && npm run typecheck`
Expected: all tests PASS; `tsc --noEmit` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/services/competitive-position.ts __tests__/competitive-position.test.ts
git commit -m "feat: resolve a vendor's standing per account segment, incumbency first

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Curated brief excerpts

**Files:**
- Create: `src/services/vendor-brief-excerpts.ts`
- Test: `__tests__/vendor-brief-excerpts.test.ts`

**Interfaces:**
- Consumes: `parseVendorBrief` from `src/services/graph-schema.ts` (throws on invalid frontmatter); `standingKey` from `src/services/competitive-position.ts`.
- Produces (exact):
  - `interface Claim { claim: string; detail: string }`
  - `interface BriefExcerpt { vendor: string; segment: string; file: string; strong: Claim[]; weak: Claim[]; sources: string[] }`
  - `interface BriefExcerpts { excerpts: Map<string, BriefExcerpt>; errors: string[] }` — map keyed by `standingKey(vendor, segment)`
  - `const MAX_CLAIMS = 4`, `const MAX_DETAIL_CHARS = 240`, `const MAX_SOURCES = 5`
  - `function excerptBrief(file: string, markdown: string): { excerpt: BriefExcerpt; problems: string[] }`
  - `function loadBriefExcerpts(dir: string, fs?: { readDir(dir: string): string[]; readFile(path: string): string }): BriefExcerpts`

- [ ] **Step 1: Write the failing tests**

Create `__tests__/vendor-brief-excerpts.test.ts`:

```ts
import { describe, expect, it } from "@jest/globals";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_CLAIMS,
  MAX_DETAIL_CHARS,
  excerptBrief,
  loadBriefExcerpts,
} from "../src/services/vendor-brief-excerpts.js";

const FRONTMATTER = [
  "---",
  "vendor: dell",
  "segment: storage-block",
  "position: leader",
  "confidence: high",
  "as_of: 2026-09-21",
  "products: [PowerMax]",
  "rationale: >",
  "  Strong block portfolio.",
  "sources:",
  "  - https://example.test/a",
  "  - https://example.test/b",
  "---",
].join("\n");

function brief(body: string): string {
  return `${FRONTMATTER}\n\n${body}`;
}

const BODY = [
  "## Portfolio — what Dell sells",
  "",
  "PowerMax for mission-critical block.",
  "",
  "## Where Dell is strong — with evidence",
  "",
  "**Largest installed base.** Dell ships more external block arrays than anyone ([Blocks & Files](https://example.test/x)).",
  "",
  "**Cyber vault.** PowerProtect Cyber Recovery is bundled.",
  "",
  "## Where Dell is weak — mandatory",
  "",
  "- **Storage lags.** Storage shrank 1% while AI servers grew.",
  "- Follows Everpure on commercial terms.",
  "",
  "## Pharma relevance",
  "",
  "GxP validation packs.",
].join("\n");

describe("excerptBrief", () => {
  it("takes the bold lead of each paragraph as the claim and the rest as detail", () => {
    const { excerpt, problems } = excerptBrief("dell-storage-block.md", brief(BODY));
    expect(problems).toEqual([]);
    expect(excerpt.vendor).toBe("dell");
    expect(excerpt.segment).toBe("storage-block");
    expect(excerpt.strong).toEqual([
      { claim: "Largest installed base.", detail: "Dell ships more external block arrays than anyone (Blocks & Files)." },
      { claim: "Cyber vault.", detail: "PowerProtect Cyber Recovery is bundled." },
    ]);
  });

  it("reads list items as separate claims, with or without a bold lead", () => {
    const { excerpt } = excerptBrief("dell-storage-block.md", brief(BODY));
    expect(excerpt.weak).toEqual([
      { claim: "Storage lags.", detail: "Storage shrank 1% while AI servers grew." },
      { claim: "Follows Everpure on commercial terms.", detail: "" },
    ]);
  });

  it("keeps the brief's sources", () => {
    expect(excerptBrief("f.md", brief(BODY)).excerpt.sources).toEqual(["https://example.test/a", "https://example.test/b"]);
  });

  it("caps the number of claims and clips long details at a word boundary", () => {
    const paragraphs = Array.from({ length: 6 }, (_, i) => `**Claim ${i}.** ${"word ".repeat(100)}`).join("\n\n");
    const { excerpt } = excerptBrief("f.md", brief(`## Where Dell is strong\n\n${paragraphs}\n\n## Where Dell is weak\n\n**W.** w`));
    expect(excerpt.strong).toHaveLength(MAX_CLAIMS);
    for (const claim of excerpt.strong) {
      expect(claim.detail.length).toBeLessThanOrEqual(MAX_DETAIL_CHARS + 1);
      expect(claim.detail.endsWith("word…")).toBe(true);
    }
  });

  it("reports a brief with no weak section instead of hiding it", () => {
    const { excerpt, problems } = excerptBrief("f.md", brief("## Where Dell is strong\n\n**S.** s"));
    expect(excerpt.weak).toEqual([]);
    expect(problems).toEqual(['f.md: no "Where … is weak" section (the spec makes it mandatory)']);
  });
});

describe("loadBriefExcerpts", () => {
  it("keys excerpts by vendor/segment and reports, not throws, on a bad brief", () => {
    const files: Record<string, string> = {
      "dell-storage-block.md": brief(BODY),
      "broken.md": "no frontmatter here",
      "notes.txt": "ignored",
    };
    const result = loadBriefExcerpts("/briefs", {
      readDir: () => Object.keys(files),
      readFile: (path) => files[path.replace("/briefs/", "")],
    });
    expect([...result.excerpts.keys()]).toEqual(["dell/storage-block"]);
    expect(result.errors).toEqual(["broken.md: vendor brief has no frontmatter block"]);
  });

  it("reports an unreadable directory", () => {
    const result = loadBriefExcerpts("/missing", {
      readDir: () => {
        throw new Error("ENOENT");
      },
      readFile: () => "",
    });
    expect(result.excerpts.size).toBe(0);
    expect(result.errors).toEqual(["cannot read /missing: ENOENT"]);
  });

  // Read-only check against the committed briefs (files in the repo, not a live service):
  // every brief must yield at least one strong and one weak claim, or the tool would
  // silently answer with empty excerpts.
  it("finds strong and weak claims in every committed brief", () => {
    const dir = join(process.cwd(), "knowledge", "vendors");
    const result = loadBriefExcerpts(dir, { readDir: (d) => readdirSync(d), readFile: (p) => readFileSync(p, "utf8") });
    expect(result.errors).toEqual([]);
    expect(result.excerpts.size).toBeGreaterThan(0);
    for (const excerpt of result.excerpts.values()) {
      expect(excerpt.strong.length).toBeGreaterThan(0);
      expect(excerpt.weak.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- __tests__/vendor-brief-excerpts.test.ts`
Expected: FAIL — `Cannot find module '../src/services/vendor-brief-excerpts.js'`.

- [ ] **Step 3: Implement `src/services/vendor-brief-excerpts.ts`**

```ts
// Short, quotable excerpts from the curated vendor briefs (knowledge/vendors).
//
// The curated vector chunks are cut from these same files, so reading them
// directly gives the curated tier without an embedding call, a stack dependency
// or the index guard, and keeps the answer deterministic. Only headline claims
// are returned: a tool result that carried whole documents once put 48k tokens
// into a single call.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { standingKey } from "./competitive-position.js";
import { parseVendorBrief } from "./graph-schema.js";

export interface Claim {
  claim: string;
  detail: string;
}

export interface BriefExcerpt {
  vendor: string;
  segment: string;
  file: string;
  strong: Claim[];
  weak: Claim[];
  sources: string[];
}

export interface BriefExcerpts {
  /** Keyed by standingKey(vendor, segment). */
  excerpts: Map<string, BriefExcerpt>;
  errors: string[];
}

export const MAX_CLAIMS = 4;
export const MAX_DETAIL_CHARS = 240;
export const MAX_SOURCES = 5;

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// Links become their text: the URL is noise in an excerpt and the brief's
// sources list already carries the citations.
function plain(text: string): string {
  return text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim();
}

/** The text under the first `## ` heading matching `pattern`, or null when there is none. */
function section(body: string, pattern: RegExp): string | null {
  for (const part of body.split(/^## /m).slice(1)) {
    const newline = part.indexOf("\n");
    const heading = newline === -1 ? part : part.slice(0, newline);
    if (pattern.test(heading)) return newline === -1 ? "" : part.slice(newline + 1);
  }
  return null;
}

function claims(text: string): Claim[] {
  const blocks = text.split(/\n\s*\n/).flatMap((block) =>
    /^\s*[-*] /.test(block) ? block.split(/\n(?=\s*[-*] )/).map((item) => item.replace(/^\s*[-*] /, "")) : [block],
  );
  return blocks
    .map((block) => block.trim())
    .filter((block) => block.length > 0 && !block.startsWith("#"))
    .slice(0, MAX_CLAIMS)
    .map((block): Claim => {
      const lead = /^\*\*([\s\S]+?)\*\*\s*([\s\S]*)$/.exec(block);
      return lead
        ? { claim: plain(lead[1]), detail: clip(plain(lead[2]), MAX_DETAIL_CHARS) }
        : { claim: clip(plain(block), MAX_DETAIL_CHARS), detail: "" };
    });
}

/** Excerpt one brief. Throws only when the frontmatter is invalid (parseVendorBrief). */
export function excerptBrief(file: string, markdown: string): { excerpt: BriefExcerpt; problems: string[] } {
  const brief = parseVendorBrief(markdown);
  const strong = section(brief.body, /^Where .+ is strong/i);
  const weak = section(brief.body, /^Where .+ is weak/i);

  const problems: string[] = [];
  if (strong === null) problems.push(`${file}: no "Where … is strong" section`);
  if (weak === null) problems.push(`${file}: no "Where … is weak" section (the spec makes it mandatory)`);

  return {
    excerpt: {
      vendor: brief.vendor,
      segment: brief.segment,
      file,
      strong: claims(strong ?? ""),
      weak: claims(weak ?? ""),
      sources: brief.sources.slice(0, MAX_SOURCES),
    },
    problems,
  };
}

const realFs = {
  readDir: (dir: string): string[] => readdirSync(dir),
  readFile: (path: string): string => readFileSync(path, "utf8"),
};

/**
 * Excerpt every brief in `dir`. One bad brief is reported, not thrown: the
 * query tool should still answer for the vendors whose briefs are fine.
 * (The graph rebuild is the opposite -- it refuses a bad brief outright.)
 */
export function loadBriefExcerpts(dir: string, fs = realFs): BriefExcerpts {
  const excerpts = new Map<string, BriefExcerpt>();
  const errors: string[] = [];

  let files: string[];
  try {
    files = fs.readDir(dir).filter((f) => f.endsWith(".md")).sort();
  } catch (err) {
    return { excerpts, errors: [`cannot read ${dir}: ${(err as Error).message}`] };
  }

  for (const file of files) {
    try {
      const { excerpt, problems } = excerptBrief(file, fs.readFile(join(dir, file)));
      const key = standingKey(excerpt.vendor, excerpt.segment);
      const existing = excerpts.get(key);
      if (existing !== undefined) {
        errors.push(`${file}: duplicates ${existing.file} for ${key}; kept ${existing.file}`);
        continue;
      }
      excerpts.set(key, excerpt);
      errors.push(...problems);
    } catch (err) {
      errors.push(`${file}: ${(err as Error).message}`);
    }
  }

  return { excerpts, errors };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- __tests__/vendor-brief-excerpts.test.ts && npm run typecheck`
Expected: PASS. If "finds strong and weak claims in every committed brief" fails, read its `errors` output: a committed brief's headings differ from `Where <Vendor> is strong|weak`. Fix the regex only if the brief's heading is a legitimate variant; do not edit briefs to fit.

- [ ] **Step 5: Commit**

```bash
git add src/services/vendor-brief-excerpts.ts __tests__/vendor-brief-excerpts.test.ts
git commit -m "feat: headline claims and sources from the curated vendor briefs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Graph reader, evidence and the size budget

**Files:**
- Create: `src/services/competitive-graph.ts`
- Modify: `src/services/export-wiring.ts` (`GraphReader.itemsFor` and `buildLiveReader().itemsFor` gain optional `domains`)
- Test: `__tests__/competitive-graph.test.ts`

**Interfaces:**
- Consumes: everything Task 1 produces; `BriefExcerpts`, `Claim`, `standingKey` from Task 2 / Task 1; `Domain` from `src/services/watchlist-config.ts`; `Segment` from `src/services/graph-schema.ts`.
- Produces (exact):
  - `type RunCypher = (query: string, params?: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>`
  - `interface EvidenceItem { title: string; url: string; publishedAt: string }`
  - `interface CompetitiveDeps { runCypher: RunCypher; recentItems(entity: string, domains: Domain[] | undefined, limit: number): EvidenceItem[]; briefs(): BriefExcerpts; vendorAliases(): Record<string, string> }`
  - `const ACCOUNTS_CYPHER, NEED_SEGMENTS_CYPHER, POSITIONS_CYPHER, VENDORS_CYPHER: string`
  - `const SEGMENT_DOMAINS: Record<Segment, Domain[]>`
  - `const EVIDENCE_PER_VENDOR = 3`, `const MAX_ANSWER_CHARS = 24_000`, `const TRIMMED_RATIONALE_CHARS = 200`
  - `interface AnswerStanding extends Standing { curated: boolean; strong: Claim[]; weak: Claim[]; sources: string[] }`
  - `interface CompetitiveAnswer { query: CompetitiveResolution["query"]; modes: Partial<Record<IncumbencyMode, string>>; market: CompetitiveResolution["market"]; accounts: AccountView[]; standings: Record<string, AnswerStanding>; evidence: Record<string, EvidenceItem[]>; notes: string[] }`
  - `type CompetitiveResult = { ok: true; answer: CompetitiveAnswer } | { ok: false; error: string }`
  - `function readGraphSnapshot(runCypher: RunCypher, vendorAliases: Record<string, string>): Promise<GraphSnapshot>`
  - `function competitivePosition(deps: CompetitiveDeps, query: CompetitiveQuery): Promise<CompetitiveResult>`
  - `GraphReader.itemsFor(entity: string, limit: number, domains?: Domain[])` in `export-wiring.ts`

- [ ] **Step 1: Write the failing tests**

Create `__tests__/competitive-graph.test.ts`:

```ts
import { describe, expect, it } from "@jest/globals";
import {
  ACCOUNTS_CYPHER,
  MAX_ANSWER_CHARS,
  NEED_SEGMENTS_CYPHER,
  POSITIONS_CYPHER,
  VENDORS_CYPHER,
  competitivePosition,
  readGraphSnapshot,
  type CompetitiveDeps,
  type EvidenceItem,
  type RunCypher,
} from "../src/services/competitive-graph.js";
import { SEGMENTS } from "../src/services/graph-schema.js";
import type { BriefExcerpt } from "../src/services/vendor-brief-excerpts.js";
import type { Domain } from "../src/services/watchlist-config.js";

interface Rows {
  accounts: Array<Record<string, unknown>>;
  needs: Array<Record<string, unknown>>;
  positions: Array<Record<string, unknown>>;
  vendors: Array<Record<string, unknown>>;
}

function fakeCypher(rows: Rows): RunCypher {
  return async (query) => {
    if (query === ACCOUNTS_CYPHER) return rows.accounts;
    if (query === NEED_SEGMENTS_CYPHER) return rows.needs;
    if (query === POSITIONS_CYPHER) return rows.positions;
    if (query === VENDORS_CYPHER) return rows.vendors;
    throw new Error(`unexpected query: ${query}`);
  };
}

const ROWS: Rows = {
  accounts: [
    {
      id: "roche",
      name: "Roche",
      aliases: "Genentech,Chugai",
      needs: ["cyber-resilience"],
      uses: [{ segment: "storage-block", vendor: "dell" }],
    },
  ],
  needs: [{ need: "cyber-resilience", segments: ["data-protection", "storage-block"] }],
  positions: [
    { vendor: "dell", segment: "storage-block", position: "leader", confidence: "high", rationale: "PowerMax.", asOf: "2026-09-21" },
  ],
  vendors: [{ id: "dell" }, { id: "hpe" }],
};

function excerpt(vendor: string, segment: string, claimCount = 1, detail = "detail"): BriefExcerpt {
  const claims = Array.from({ length: claimCount }, (_, i) => ({ claim: `Claim ${i}.`, detail }));
  return { vendor, segment, file: `${vendor}-${segment}.md`, strong: claims, weak: claims, sources: ["https://example.test/s"] };
}

function deps(overrides: Partial<CompetitiveDeps> = {}): CompetitiveDeps {
  return {
    runCypher: fakeCypher(ROWS),
    recentItems: () => [{ title: "Dell ships PowerMax 9", url: "https://example.test/n", publishedAt: "2026-09-28" }],
    briefs: () => ({ excerpts: new Map([["dell/storage-block", excerpt("dell", "storage-block")]]), errors: [] }),
    vendorAliases: () => ({ "dell-technologies": "dell" }),
    ...overrides,
  };
}

describe("readGraphSnapshot", () => {
  it("turns rows into a snapshot, splitting the comma-joined aliases", async () => {
    const snap = await readGraphSnapshot(fakeCypher(ROWS), { x: "dell" });
    expect(snap).toEqual({
      accounts: [
        {
          id: "roche",
          name: "Roche",
          aliases: ["Genentech", "Chugai"],
          needs: ["cyber-resilience"],
          uses: [{ segment: "storage-block", vendor: "dell" }],
        },
      ],
      needSegments: { "cyber-resilience": ["data-protection", "storage-block"] },
      positions: [
        { vendor: "dell", segment: "storage-block", position: "leader", confidence: "high", rationale: "PowerMax.", asOf: "2026-09-21" },
      ],
      vendors: ["dell", "hpe"],
      vendorAliases: { x: "dell" },
    });
  });

  it("refuses a malformed row rather than printing 'undefined' into an answer", async () => {
    const rows = { ...ROWS, positions: [{ vendor: "dell", segment: "storage-block", confidence: "high", rationale: "r" }] };
    await expect(readGraphSnapshot(fakeCypher(rows), {})).rejects.toThrow(
      'competitive-graph: row is missing required field "position"',
    );
  });
});

describe("competitivePosition", () => {
  it("attaches the excerpt to each cited standing and explains the modes it used", async () => {
    const result = await competitivePosition(deps(), { vendor: "Dell Technologies" });
    if (!result.ok) throw new Error(result.error);
    expect(result.answer.standings["dell/storage-block"]).toEqual({
      position: "leader",
      confidence: "high",
      rationale: "PowerMax.",
      asOf: "2026-09-21",
      curated: true,
      strong: [{ claim: "Claim 0.", detail: "detail" }],
      weak: [{ claim: "Claim 0.", detail: "detail" }],
      sources: ["https://example.test/s"],
    });
    expect(Object.keys(result.answer.modes).sort()).toEqual(["defend", "greenfield"]);
  });

  it("says when a position has no curated brief behind it", async () => {
    const result = await competitivePosition(deps({ briefs: () => ({ excerpts: new Map(), errors: [] }) }), { vendor: "dell" });
    if (!result.ok) throw new Error(result.error);
    expect(result.answer.standings["dell/storage-block"].curated).toBe(false);
    expect(result.answer.notes).toContain(
      "no curated evidence for dell in storage-block: the position rests on the graph alone",
    );
  });

  it("surfaces brief problems as notes", async () => {
    const result = await competitivePosition(
      deps({ briefs: () => ({ excerpts: new Map(), errors: ["x.md: bad"] }) }),
      { vendor: "dell" },
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.answer.notes).toContain("brief problem: x.md: bad");
  });

  function recordingItems(): { calls: Array<[string, Domain[] | undefined, number]>; fn: CompetitiveDeps["recentItems"] } {
    const calls: Array<[string, Domain[] | undefined, number]> = [];
    return {
      calls,
      fn: (entity, domains, limit): EvidenceItem[] => {
        calls.push([entity, domains, limit]);
        return [];
      },
    };
  }

  it("fetches the vendor's recent items in the domains of its cited segments", async () => {
    const items = recordingItems();
    await competitivePosition(deps({ recentItems: items.fn }), { vendor: "dell" });
    expect(items.calls).toEqual([["dell", ["storage"], 3]]);
  });

  it("does not filter by domain when no cited segment maps to one", async () => {
    const items = recordingItems();
    await competitivePosition(deps({ recentItems: items.fn }), { vendor: "hpe" });
    expect(items.calls).toEqual([["hpe", undefined, 3]]);
  });

  it("passes the resolver's error through", async () => {
    expect(await competitivePosition(deps(), {})).toEqual({
      ok: false,
      error: "give at least one of vendor, account or segment",
    });
  });
});

describe("competitivePosition — size budget", () => {
  // Eight vendors briefed in every segment, three accounts with every need: far
  // bigger than today's graph, the shape it grows into.
  const vendors = ["dell", "hpe", "everpure", "netapp", "ibm", "huawei", "vast-data", "nutanix"];
  const bigRows: Rows = {
    accounts: ["roche", "novartis", "sandoz"].map((id) => ({
      id,
      name: id,
      aliases: "",
      needs: ["n"],
      uses: [{ segment: "storage-block", vendor: "hpe" }],
    })),
    needs: [{ need: "n", segments: [...SEGMENTS] }],
    positions: vendors.flatMap((vendor) =>
      SEGMENTS.map((segment) => ({
        vendor,
        segment,
        position: "strong",
        confidence: "medium",
        rationale: "r".repeat(545),
        asOf: "2026-09-21",
      })),
    ),
    vendors: vendors.map((id) => ({ id })),
  };
  const bigBriefs = new Map(
    vendors.flatMap((v) => SEGMENTS.map((s) => [`${v}/${s}`, excerpt(v, s, 4, "d".repeat(240))] as const)),
  );
  const bigDeps = deps({
    runCypher: fakeCypher(bigRows),
    briefs: () => ({ excerpts: bigBriefs, errors: [] }),
  });

  it("keeps a full-graph vendor answer under the budget, and says it trimmed", async () => {
    const result = await competitivePosition(bigDeps, { vendor: "dell" });
    if (!result.ok) throw new Error(result.error);
    expect(JSON.stringify(result.answer).length).toBeLessThanOrEqual(MAX_ANSWER_CHARS);
    expect(result.answer.notes.some((n) => n.startsWith("excerpts trimmed to fit"))).toBe(true);
  });

  it("drops claim details before it drops claims", async () => {
    const result = await competitivePosition(bigDeps, { vendor: "dell" });
    if (!result.ok) throw new Error(result.error);
    const standing = result.answer.standings["dell/storage-block"];
    expect(standing.strong.length).toBeGreaterThan(0);
    expect(standing.strong.every((c) => c.detail === "")).toBe(true);
  });

  it("leaves a small answer untouched", async () => {
    const result = await competitivePosition(deps(), { vendor: "dell" });
    if (!result.ok) throw new Error(result.error);
    expect(result.answer.standings["dell/storage-block"].strong[0].detail).toBe("detail");
    expect(result.answer.notes.some((n) => n.startsWith("excerpts trimmed"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- __tests__/competitive-graph.test.ts`
Expected: FAIL — `Cannot find module '../src/services/competitive-graph.js'`.

- [ ] **Step 3: Implement `src/services/competitive-graph.ts`**

```ts
// Reads the vendor-intelligence graph for competitive_position, and turns the
// resolver's answer into the compact JSON the tool returns.
//
// Everything live is injected (Cypher runner, watchlist items, brief files), so
// no test reaches Neo4j or sqlite; src/api/graph.ts binds the real ones.
import {
  MODE_GUIDANCE,
  resolveCompetitivePosition,
  type AccountView,
  type CompetitiveQuery,
  type CompetitiveResolution,
  type GraphSnapshot,
  type IncumbencyMode,
  type SnapshotAccount,
  type Standing,
} from "./competitive-position.js";
import type { Segment } from "./graph-schema.js";
import type { BriefExcerpts, Claim } from "./vendor-brief-excerpts.js";
import type { Domain } from "./watchlist-config.js";

export type RunCypher = (query: string, params?: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;

export interface EvidenceItem {
  title: string;
  url: string;
  publishedAt: string;
}

export interface CompetitiveDeps {
  runCypher: RunCypher;
  /** `domains` undefined means no domain filter; an empty list would match nothing. */
  recentItems(entity: string, domains: Domain[] | undefined, limit: number): EvidenceItem[];
  briefs(): BriefExcerpts;
  vendorAliases(): Record<string, string>;
}

export const ACCOUNTS_CYPHER = `
  MATCH (a:Account)
  OPTIONAL MATCH (a)-[:HAS_NEED]->(n:Need)
  WITH a, collect(DISTINCT n.id) AS needs
  OPTIONAL MATCH (a)-[u:USES]->(v:Vendor)
  RETURN a.id AS id, a.name AS name, a.aliases AS aliases, needs,
         collect(CASE WHEN v IS NULL THEN null ELSE {segment: u.segment, vendor: v.id} END) AS uses
  ORDER BY id
`;

export const NEED_SEGMENTS_CYPHER = `
  MATCH (n:Need)-[:ADDRESSED_BY]->(s:Segment)
  RETURN n.id AS need, collect(s.id) AS segments
  ORDER BY need
`;

export const POSITIONS_CYPHER = `
  MATCH (v:Vendor)-[c:COMPETES_IN]->(s:Segment)
  RETURN v.id AS vendor, s.id AS segment, c.position AS position, c.confidence AS confidence,
         c.rationale AS rationale, c.asOf AS asOf
  ORDER BY vendor, segment
`;

export const VENDORS_CYPHER = `MATCH (v:Vendor) RETURN v.id AS id ORDER BY id`;

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

export const EVIDENCE_PER_VENDOR = 3;
/** ~6k tokens: room in a 64K context for the question, the answer and the model's own reasoning. */
export const MAX_ANSWER_CHARS = 24_000;
export const TRIMMED_RATIONALE_CHARS = 200;

export interface AnswerStanding extends Standing {
  /** false when no brief file backs the graph's position. */
  curated: boolean;
  strong: Claim[];
  weak: Claim[];
  sources: string[];
}

export interface CompetitiveAnswer {
  query: CompetitiveResolution["query"];
  /** What each incumbency mode in this answer means; only the modes that occur. */
  modes: Partial<Record<IncumbencyMode, string>>;
  market: CompetitiveResolution["market"];
  accounts: AccountView[];
  standings: Record<string, AnswerStanding>;
  evidence: Record<string, EvidenceItem[]>;
  notes: string[];
}

export type CompetitiveResult = { ok: true; answer: CompetitiveAnswer } | { ok: false; error: string };

// A Neo4j row is Record<string, unknown>: a missing property must fail loudly
// rather than reach the model as the word "undefined" (same rule as
// export-wiring.ts).
function str(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`competitive-graph: row is missing required field "${field}"`);
  }
  return value;
}

function strList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`competitive-graph: row is missing required field "${field}"`);
  return value.map((entry, i) => str(entry, `${field}[${i}]`));
}

function uses(value: unknown): SnapshotAccount["uses"] {
  if (!Array.isArray(value)) throw new Error('competitive-graph: row is missing required field "uses"');
  return value.map((entry, i) => {
    const row = (entry ?? {}) as Record<string, unknown>;
    return { segment: str(row.segment, `uses[${i}].segment`), vendor: str(row.vendor, `uses[${i}].vendor`) };
  });
}

export async function readGraphSnapshot(runCypher: RunCypher, vendorAliases: Record<string, string>): Promise<GraphSnapshot> {
  const [accountRows, needRows, positionRows, vendorRows] = await Promise.all([
    runCypher(ACCOUNTS_CYPHER),
    runCypher(NEED_SEGMENTS_CYPHER),
    runCypher(POSITIONS_CYPHER),
    runCypher(VENDORS_CYPHER),
  ]);

  return {
    accounts: accountRows.map((r) => ({
      id: str(r.id, "id"),
      name: typeof r.name === "string" && r.name.length > 0 ? r.name : str(r.id, "id"),
      // graph-accounts.ts stores aliases comma-joined (Neo4j properties are scalars or lists of scalars).
      aliases: (typeof r.aliases === "string" ? r.aliases : "")
        .split(",")
        .map((a) => a.trim())
        .filter((a) => a.length > 0),
      needs: strList(r.needs, "needs"),
      uses: uses(r.uses),
    })),
    needSegments: Object.fromEntries(needRows.map((r) => [str(r.need, "need"), strList(r.segments, "segments")])),
    positions: positionRows.map((r) => ({
      vendor: str(r.vendor, "vendor"),
      segment: str(r.segment, "segment"),
      position: str(r.position, "position"),
      confidence: str(r.confidence, "confidence"),
      rationale: str(r.rationale, "rationale"),
      asOf: typeof r.asOf === "string" ? r.asOf : "",
    })),
    vendors: vendorRows.map((r) => str(r.id, "id")),
    vendorAliases,
  };
}

function size(answer: CompetitiveAnswer): number {
  return JSON.stringify(answer).length;
}

/**
 * Shrink an over-budget answer in a fixed order, cheapest information first:
 * claim details, then claims, then rationale length. Structure (accounts,
 * modes, positions, sources) is never dropped -- it is what the question is about.
 */
function fitBudget(answer: CompetitiveAnswer): void {
  if (size(answer) <= MAX_ANSWER_CHARS) return;
  const standings = Object.values(answer.standings);
  const steps: Array<() => void> = [
    () => {
      for (const s of standings) for (const c of [...s.strong, ...s.weak]) c.detail = "";
    },
    () => {
      for (const s of standings) {
        s.strong = [];
        s.weak = [];
      }
    },
    () => {
      for (const s of standings) {
        if (s.rationale.length > TRIMMED_RATIONALE_CHARS) s.rationale = `${s.rationale.slice(0, TRIMMED_RATIONALE_CHARS).trimEnd()}…`;
      }
    },
  ];
  answer.notes.push("excerpts trimmed to fit the answer budget; ask about one account or segment for the full claims");
  for (const step of steps) {
    step();
    if (size(answer) <= MAX_ANSWER_CHARS) return;
  }
  answer.notes.push("the answer is still over budget: narrow the question by account or segment");
}

export async function competitivePosition(deps: CompetitiveDeps, query: CompetitiveQuery): Promise<CompetitiveResult> {
  const snapshot = await readGraphSnapshot(deps.runCypher, deps.vendorAliases());
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

  // Evidence for the queried vendor, or for every cited vendor when none was named.
  const evidenceVendors =
    r.query.vendor !== null ? [r.query.vendor] : [...new Set(Object.keys(standings).map((k) => k.split("/")[0]))].sort();
  const evidence: Record<string, EvidenceItem[]> = {};
  for (const vendor of evidenceVendors) {
    const domains = new Set<Domain>();
    for (const key of Object.keys(standings)) {
      const [v, segment] = key.split("/");
      if (v === vendor) for (const d of SEGMENT_DOMAINS[segment as Segment] ?? []) domains.add(d);
    }
    evidence[vendor] = deps.recentItems(vendor, domains.size > 0 ? [...domains].sort() : undefined, EVIDENCE_PER_VENDOR);
  }

  const answer: CompetitiveAnswer = {
    query: r.query,
    modes,
    market: r.market,
    accounts: r.accounts,
    standings,
    evidence,
    notes,
  };
  fitBudget(answer);
  return { ok: true, answer };
}
```

- [ ] **Step 4: Give `itemsFor` an optional domain filter in `src/services/export-wiring.ts`**

In the `GraphReader` interface, replace the `itemsFor` line with:

```ts
  itemsFor(entity: string, limit: number, domains?: Domain[]): Array<{ title: string; url: string; publishedAt: string }>;
```

Add `import type { Domain } from "./watchlist-config.js";` beside the other type imports, and in `buildLiveReader` replace the `itemsFor(entity, limit) {` method's first statement so it passes the filter through:

```ts
    itemsFor(entity, limit, domains) {
      return store
        .itemsInPeriod("0000-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z", { entities: [entity], domains })
```

(the `.sort(...).slice(...).map(...)` chain after it is unchanged). `itemsInPeriod` treats `domains: undefined` as "no filter" (`watchlist-store.ts:532`), so existing callers are unaffected.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- __tests__/competitive-graph.test.ts __tests__/export-wiring.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/services/competitive-graph.ts src/services/export-wiring.ts __tests__/competitive-graph.test.ts
git commit -m "feat: read competitive standings from the graph within a fixed answer budget

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `POST /api/graph/competitive-position`, and the router becomes injectable

**Files:**
- Modify: `src/api/graph.ts` (whole file restructured below)
- Verify only: `src/server.ts:22,61` (the default export stays a router, so the import and mount are unchanged)
- Modify: `src/services/graph-store.ts` (delete `GraphSearchResult` and `searchGraph`, lines 130–195)
- Test: `__tests__/graph-routes.test.ts`

**Interfaces:**
- Consumes: `competitivePosition`, `CompetitiveDeps` (Task 3); `loadBriefExcerpts` (Task 2); `normaliseName` (Task 1); `liveReader` from `export-wiring.ts`; `loadWatchlist` from `watchlist-config.ts`; `isNeo4jAvailable`, `getNeo4jStats`, `clearGraph` from `graph-store.ts`.
- Produces:
  - `interface GraphRouterDeps { isAvailable(): Promise<boolean>; stats(): Promise<Awaited<ReturnType<typeof getNeo4jStats>>>; competitive(): CompetitiveDeps }` (Task 6 adds `rebuild`)
  - `function createGraphRouter(deps: GraphRouterDeps): Router`
  - `function liveGraphRouterDeps(): GraphRouterDeps`
  - Route contract: `POST /api/graph/competitive-position` body `{ vendor?: string; account?: string; segment?: string }` → `200 CompetitiveAnswer` | `400 { error }` | `503 { error: "Neo4j is not reachable" }` | `500 { error }`.

- [ ] **Step 1: Write the failing route tests**

Create `__tests__/graph-routes.test.ts`:

```ts
import { afterEach, describe, expect, it } from "@jest/globals";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createGraphRouter, type GraphRouterDeps } from "../src/api/graph.js";
import {
  ACCOUNTS_CYPHER,
  NEED_SEGMENTS_CYPHER,
  POSITIONS_CYPHER,
  VENDORS_CYPHER,
  type CompetitiveDeps,
} from "../src/services/competitive-graph.js";

let server: Server | null = null;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
});

const competitive: CompetitiveDeps = {
  async runCypher(query) {
    if (query === ACCOUNTS_CYPHER) return [];
    if (query === NEED_SEGMENTS_CYPHER) return [];
    if (query === POSITIONS_CYPHER) {
      return [{ vendor: "dell", segment: "storage-block", position: "leader", confidence: "high", rationale: "r", asOf: "" }];
    }
    if (query === VENDORS_CYPHER) return [{ id: "dell" }];
    throw new Error("unexpected query");
  },
  recentItems: () => [],
  briefs: () => ({ excerpts: new Map(), errors: [] }),
  vendorAliases: () => ({}),
};

function fakeDeps(overrides: Partial<GraphRouterDeps> = {}): GraphRouterDeps {
  return {
    isAvailable: async () => true,
    stats: async () => ({ nodeCount: 0, relationshipCount: 0, nodesByLabel: {}, relationshipsByType: {} }),
    competitive: () => competitive,
    rebuild: async () => ({ nodes: 0, relationships: 0, lines: [] }),
    ...overrides,
  } as GraphRouterDeps;
}

async function start(deps: GraphRouterDeps): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use("/api/graph", createGraphRouter(deps));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server?.once("listening", () => resolve()));
  return `http://127.0.0.1:${(server?.address() as AddressInfo).port}/api/graph`;
}

async function post(url: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: resp.status, body: (await resp.json()) as Record<string, unknown> };
}

describe("POST /api/graph/competitive-position", () => {
  it("answers a vendor question", async () => {
    const base = await start(fakeDeps());
    const { status, body } = await post(`${base}/competitive-position`, { vendor: "dell" });
    expect(status).toBe(200);
    expect(body.market).toEqual([{ vendor: "dell", segment: "storage-block", position: "leader" }]);
  });

  it("returns 400 with the resolver's message for an unknown vendor", async () => {
    const base = await start(fakeDeps());
    const { status, body } = await post(`${base}/competitive-position`, { vendor: "lenovo" });
    expect(status).toBe(400);
    expect(body.error).toBe('unknown vendor "lenovo" (known: dell)');
  });

  it("returns 400 when a field is not a string", async () => {
    const base = await start(fakeDeps());
    const { status, body } = await post(`${base}/competitive-position`, { vendor: 42 });
    expect(status).toBe(400);
    expect(body.error).toBe("vendor, account and segment must be strings when given");
  });

  it("returns 503 when Neo4j is down", async () => {
    const base = await start(fakeDeps({ isAvailable: async () => false }));
    const { status } = await post(`${base}/competitive-position`, { vendor: "dell" });
    expect(status).toBe(503);
  });

  it("no longer serves the old-schema entity search", async () => {
    const base = await start(fakeDeps());
    const resp = await fetch(`${base}/search`, { method: "POST" });
    expect(resp.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- __tests__/graph-routes.test.ts`
Expected: FAIL — `createGraphRouter` is not exported.

- [ ] **Step 3: Restructure `src/api/graph.ts`**

Replace the whole file with the following. The rebuild handler body is the existing one, moved inside the factory unchanged (Task 6 replaces it):

```ts
// API routes for the vendor-intelligence graph.
//
// createGraphRouter takes its services as arguments so route tests never reach
// Neo4j, the watchlist database or the brief files; the default export binds
// the live ones lazily (nothing connects at import time).
import { Router } from "express";
import type { Request, Response } from "express";
import { join } from "node:path";
import { getActiveStack } from "../config/llm-stacks.js";
import { serviceUrl } from "../platform/host-config.js";
import { competitivePosition, type CompetitiveDeps } from "../services/competitive-graph.js";
import { normaliseName } from "../services/competitive-position.js";
import { liveReader } from "../services/export-wiring.js";
import { clearGraph, getNeo4jStats, isNeo4jAvailable } from "../services/graph-store.js";
import { loadBriefExcerpts } from "../services/vendor-brief-excerpts.js";
import { loadWatchlist } from "../services/watchlist-config.js";

export interface GraphRouterDeps {
  isAvailable(): Promise<boolean>;
  stats(): Promise<Awaited<ReturnType<typeof getNeo4jStats>>>;
  competitive(): CompetitiveDeps;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

export function createGraphRouter(deps: GraphRouterDeps): Router {
  const router = Router();

  // GET /api/graph/health
  router.get("/health", async (_req: Request, res: Response): Promise<void> => {
    const start = Date.now();
    const available = await deps.isAvailable();
    res.json({ neo4j: available, latency_ms: Date.now() - start });
  });

  // GET /api/graph/stats
  router.get("/stats", async (_req: Request, res: Response): Promise<void> => {
    try {
      if (!(await deps.isAvailable())) {
        res.status(503).json({ error: "Neo4j is not reachable" });
        return;
      }
      res.json(await deps.stats());
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // POST /api/graph/competitive-position - a vendor's standing per account segment, incumbency first
  router.post("/competitive-position", async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!optionalString(body.vendor) || !optionalString(body.account) || !optionalString(body.segment)) {
      res.status(400).json({ error: "vendor, account and segment must be strings when given" });
      return;
    }
    try {
      if (!(await deps.isAvailable())) {
        res.status(503).json({ error: "Neo4j is not reachable" });
        return;
      }
      const result = await competitivePosition(deps.competitive(), {
        vendor: body.vendor,
        account: body.account,
        segment: body.segment,
      });
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json(result.answer);
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // POST /api/graph/rebuild - Trigger full graph rebuild (calls Python script)
  router.post("/rebuild", async (_req: Request, res: Response): Promise<void> => {
    // Checked before clearing anything: the builder would otherwise wipe the graph and then fail
    if (getActiveStack().name !== "ollama") {
      res.status(409).json({
        error: "Graph rebuild uses python/graph_builder.py, which calls Ollama directly; switch to the Ollama stack first",
      });
      return;
    }

    const { execFile } = await import("node:child_process");

    try {
      const available = await isNeo4jAvailable();
      if (!available) {
        res.status(503).json({ error: "Neo4j is not reachable" });
        return;
      }

      await clearGraph();

      execFile(
        "python3",
        ["python/graph_builder.py"],
        {
          cwd: process.cwd(),
          timeout: 600000,
          // The builder has no defaults of its own: endpoints come from config/host.yaml
          env: { ...process.env, NEO4J_URI: serviceUrl("neo4j"), OLLAMA_URL: serviceUrl("ollama") },
        },
        (err, stdout, stderr) => {
          if (err) {
            console.error("[Graph Rebuild] Error:", stderr);
            if (!res.writableEnded) {
              res.status(500).json({ error: stderr || err.message });
            }
            return;
          }
          console.log("[Graph Rebuild]", stdout);
          if (!res.writableEnded) {
            res.json({ message: "Graph rebuild complete", output: stdout });
          }
        }
      );
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  return router;
}

/** Normalised alias and name -> entity id, from config/watchlist.yaml (e.g. "pure-storage" -> "everpure"). */
function watchlistAliases(): Record<string, string> {
  try {
    const aliases: Record<string, string> = {};
    for (const entity of loadWatchlist().entities.values()) {
      for (const name of [entity.name, ...entity.aliases]) aliases[normaliseName(name)] = entity.id;
    }
    return aliases;
  } catch (err) {
    // An invalid watchlist must not take the query down: ids still resolve without aliases.
    console.error("[Graph] watchlist aliases unavailable:", errorMessage(err));
    return {};
  }
}

export function liveGraphRouterDeps(): GraphRouterDeps {
  return {
    isAvailable: isNeo4jAvailable,
    stats: getNeo4jStats,
    competitive: () => {
      const reader = liveReader();
      return {
        runCypher: (query, params) => reader.runCypher(query, params),
        recentItems: (entity, domains, limit) => reader.itemsFor(entity, limit, domains),
        briefs: () => loadBriefExcerpts(join(process.cwd(), "knowledge", "vendors")),
        vendorAliases: watchlistAliases,
      };
    },
  };
}

export default createGraphRouter(liveGraphRouterDeps());
```

`src/server.ts` keeps `import graphRouter from "./api/graph.js";` and `app.use("/api/graph", graphRouter);` — the default export is still a router, so no change is needed there. Confirm with `grep -n graphRouter src/server.ts`.

- [ ] **Step 4: Remove `searchGraph` from `src/services/graph-store.ts`**

Delete the `GraphSearchResult` interface and the `searchGraph` function (the block from `export interface GraphSearchResult {` through the closing brace of `searchGraph`). Then confirm nothing else uses them:

Run: `grep -rn "searchGraph\|GraphSearchResult" src scripts __tests__`
Expected: no output.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- __tests__/graph-routes.test.ts && npm run typecheck`
Expected: PASS, typecheck clean. (The `rebuild` key in `fakeDeps` is an excess property until Task 6; the `as GraphRouterDeps` cast keeps that compiling.)

- [ ] **Step 6: Commit**

```bash
git add src/api/graph.ts src/services/graph-store.ts __tests__/graph-routes.test.ts
git commit -m "feat: POST /api/graph/competitive-position replaces the old-schema entity search

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: MCP `competitive_position` replaces `graph_search`

**Files:**
- Modify: `mcp/src/tools/graph.ts`
- Modify: `mcp/__tests__/other-tools.test.ts` (tool list and the `graph_search` test)
- Modify: `mcp/README.md:30`

**Interfaces:**
- Consumes: route contract from Task 4; `runTool` from `mcp/src/tools/result.ts`; `client.post(path, body)` (rejects with the server's `error` string on a non-2xx).
- Produces: MCP tool `competitive_position` with optional string inputs `vendor`, `account`, `segment`. Tool count stays 20.

- [ ] **Step 1: Update the tests first**

In `mcp/__tests__/other-tools.test.ts`, in the "exposes exactly the 20 PharmaITChat tools" list, replace `"graph_search",` with `"competitive_position",` and move it to keep the list sorted (it goes after `"ask_pharmaitchat",`):

```ts
      "add_knowledge",
      "artifact_status",
      "ask_pharmaitchat",
      "competitive_position",
      "create_artifact",
      "dashboard_metrics",
      "feedback_report",
      "graph_stats",
```

Replace the `it("searches an entity by name", ...)` test in `describe("graph tools", ...)` with:

```ts
  it("asks for a vendor's competitive position, sending only the given fields", async () => {
    harness.pharma.on("POST", "/api/graph/competitive-position", (_req, res) =>
      sendJson(res, 200, { query: { vendor: "dell" }, accounts: [] }),
    );

    const result = await call("competitive_position", { vendor: "Dell" });

    expect(JSON.parse(toolText(result))).toEqual({ query: { vendor: "dell" }, accounts: [] });
    expect(harness.pharma.requests[0].body).toEqual({ vendor: "Dell" });
  });

  it("reports the server's message when the vendor is unknown", async () => {
    harness.pharma.on("POST", "/api/graph/competitive-position", (_req, res) =>
      sendJson(res, 400, { error: 'unknown vendor "lenovo" (known: dell, hpe)' }),
    );

    const result = await call("competitive_position", { vendor: "lenovo" });

    expect(isToolError(result)).toBe(true);
    expect(toolText(result)).toContain('unknown vendor "lenovo" (known: dell, hpe)');
  });
```

- [ ] **Step 2: Run the MCP tests to verify they fail**

Run: `npm --prefix mcp test -- __tests__/other-tools.test.ts`
Expected: FAIL — the tool list still contains `graph_search`; `competitive_position` is unknown.

- [ ] **Step 3: Replace the tool in `mcp/src/tools/graph.ts`**

```ts
// Knowledge graph tools (the vendor-intelligence graph in Neo4j, via PharmaITChat)

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PharmaITChatClient } from "../pharmaitchat-client.js";
import { runTool } from "./result.js";
import type { ToolLogger } from "./result.js";

export function registerGraphTools(server: McpServer, client: PharmaITChatClient, log: ToolLogger): void {
  // One composite tool rather than graph primitives: the local model fails at
  // orchestrating several calls (spec 2026-09-21, "Query path").
  server.registerTool(
    "competitive_position",
    {
      description:
        "How a vendor stands at the user's accounts, segment by segment, e.g. 'What is Dell doing best for my accounts?'. " +
        "For each account it resolves who is already installed in each segment first, then labels the vendor's mode there: " +
        "defend (the vendor is installed), displace (a rival is) or greenfield (nobody is). Also returns the vendor's " +
        "position per segment with its rationale, confidence, short strong/weak claims from curated briefs, sources and " +
        "recent news. Positions are labels, not a ranking: never present vendors as ranked. " +
        "Give at least one of vendor, account or segment.",
      inputSchema: {
        vendor: z.string().min(1).optional().describe("Vendor, e.g. 'dell', 'HPE' or 'Pure Storage'"),
        account: z.string().min(1).optional().describe("Account, e.g. 'Roche' or 'Genentech'; omit for all accounts"),
        segment: z
          .string()
          .min(1)
          .optional()
          .describe("One segment, e.g. 'storage-block', 'storage-file', 'compute-ai', 'data-protection'"),
      },
    },
    async ({ vendor, account, segment }) =>
      runTool("competitive_position", log, () =>
        client.post("/api/graph/competitive-position", { vendor, account, segment }),
      ),
  );

  server.registerTool(
    "graph_stats",
    { description: "Knowledge graph size: node counts by label and relationship counts by type." },
    async () => runTool("graph_stats", log, () => client.get("/api/graph/stats"))
  );
}
```

`JSON.stringify` drops `undefined` fields, so `{ vendor: "Dell" }` is what reaches the server — the first test pins that.

- [ ] **Step 4: Update `mcp/README.md:30`**

Replace the row

```
| `graph_search`, `graph_stats` | Knowledge graph lookup and size |
```

with

```
| `competitive_position`, `graph_stats` | A vendor's standing per account segment (incumbency first: defend / displace / greenfield), and graph size |
```

- [ ] **Step 5: Run the MCP tests and typecheck**

Run: `npm --prefix mcp test && npm --prefix mcp run typecheck`
Expected: all MCP suites PASS (76+ tests), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add mcp/src/tools/graph.ts mcp/__tests__/other-tools.test.ts mcp/README.md
git commit -m "feat: competitive_position MCP tool replaces graph_search

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Deterministic graph rebuild on every stack

**Files:**
- Create: `src/services/vendor-graph-rebuild.ts`
- Modify: `scripts/rebuild-vendor-graph.ts` (becomes a thin CLI)
- Modify: `src/api/graph.ts` (`GraphRouterDeps.rebuild`; the rebuild route)
- Delete: `python/graph_builder.py`, `__tests__/graph-stack-gate.test.ts`
- Test: `__tests__/vendor-graph-rebuild.test.ts`, `__tests__/graph-routes.test.ts` (add rebuild cases)

**Interfaces:**
- Consumes: `parseVendorBrief`, `briefToGraphFacts`, `GraphFacts` (`graph-schema.ts`); `parseAccounts`, `accountToGraphFacts`, `parseNeedsMap`, `needsMapToGraphFacts` (`graph-accounts.ts`); `writeGraphFacts`, `GraphWriter` (`graph-writer.ts`); `getDriver` (`graph-store.ts`).
- Produces (exact):
  - `interface RebuildSources { root: string; readDir?: (dir: string) => string[]; readFile?: (path: string) => string }`
  - `interface CollectedFacts { batch: GraphFacts[]; lines: string[] }`
  - `function collectVendorGraphFacts(sources: RebuildSources): CollectedFacts`
  - `interface CypherRunner { run(query: string, params?: Record<string, unknown>): PromiseLike<unknown> }`
  - `function cypherGraphWriter(runner: CypherRunner): GraphWriter`
  - `type WriteTransaction = <T>(work: (runner: CypherRunner) => Promise<T>) => Promise<T>`
  - `function neo4jWriteTransaction(driver: Driver): WriteTransaction`
  - `interface RebuildResult { nodes: number; relationships: number; lines: string[] }`
  - `function rebuildVendorGraph(sources: RebuildSources, inTransaction: WriteTransaction, options?: { rebuild?: boolean }): Promise<RebuildResult>` — `rebuild` defaults to `true`
  - `GraphRouterDeps.rebuild(): Promise<RebuildResult>`

- [ ] **Step 1: Write the failing rebuild tests**

Create `__tests__/vendor-graph-rebuild.test.ts`:

```ts
import { describe, expect, it } from "@jest/globals";
import {
  collectVendorGraphFacts,
  rebuildVendorGraph,
  type CypherRunner,
  type WriteTransaction,
} from "../src/services/vendor-graph-rebuild.js";

const BRIEF = [
  "---",
  "vendor: dell",
  "segment: storage-block",
  "position: leader",
  "confidence: high",
  "as_of: 2026-09-21",
  "products: [PowerMax]",
  "rationale: Strong block portfolio.",
  "---",
  "Body.",
].join("\n");

const NEEDS = "needs:\n  cyber-resilience: [storage-block]\n";
const ACCOUNTS = "accounts:\n  roche:\n    name: Roche\n    needs: [cyber-resilience]\n    incumbents:\n      storage-block: [dell]\n";

function enoent(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT" });
}

function files(contents: Record<string, string>) {
  return {
    root: "/repo",
    readDir: (dir: string) =>
      Object.keys(contents)
        .filter((p) => p.startsWith(`${dir}/`))
        .map((p) => p.slice(dir.length + 1)),
    readFile: (path: string) => {
      const text = contents[path];
      if (text === undefined) throw enoent(path);
      return text;
    },
  };
}

const ALL = {
  "/repo/knowledge/vendors/dell-storage-block.md": BRIEF,
  "/repo/config/needs.yaml": NEEDS,
  "/repo/config/accounts.local.yaml": ACCOUNTS,
};

function recordingTransaction(): { tx: WriteTransaction; queries: string[]; calls: number } {
  const state = { queries: [] as string[], calls: 0 };
  const runner: CypherRunner = {
    run: async (query: string) => {
      state.queries.push(query.trim());
      return undefined;
    },
  };
  const tx: WriteTransaction = async (work) => {
    state.calls++;
    return work(runner);
  };
  return {
    tx,
    get queries() {
      return state.queries;
    },
    get calls() {
      return state.calls;
    },
  };
}

describe("collectVendorGraphFacts", () => {
  it("collects briefs, the needs map and accounts", () => {
    const { batch, lines } = collectVendorGraphFacts(files(ALL));
    expect(batch).toHaveLength(3);
    expect(lines[0]).toMatch(/^dell-storage-block\.md\s+dell\/storage-block leader\/high -> 3 nodes, 3 rels$/);
  });

  it("skips and reports a missing accounts file", () => {
    const { batch, lines } = collectVendorGraphFacts(
      files({ "/repo/knowledge/vendors/dell-storage-block.md": BRIEF, "/repo/config/needs.yaml": NEEDS }),
    );
    expect(batch).toHaveLength(2);
    expect(lines).toContain("accounts.local.yaml          -> skipped (no such file)");
  });

  it("throws on an invalid accounts file rather than rebuilding without the accounts", () => {
    const broken = { ...ALL, "/repo/config/accounts.local.yaml": "accounts:\n  roche:\n    needs: [time-travel]\n" };
    expect(() => collectVendorGraphFacts(files(broken))).toThrow('accounts.local.yaml: invalid need "time-travel"');
  });

  it("throws on a bad brief, naming the file", () => {
    const broken = { ...ALL, "/repo/knowledge/vendors/dell-storage-block.md": "no frontmatter" };
    expect(() => collectVendorGraphFacts(files(broken))).toThrow("dell-storage-block.md: vendor brief has no frontmatter block");
  });
});

describe("rebuildVendorGraph", () => {
  it("wipes and writes inside one transaction", async () => {
    const rec = recordingTransaction();
    const result = await rebuildVendorGraph(files(ALL), rec.tx);
    expect(rec.calls).toBe(1);
    expect(rec.queries[0]).toBe("MATCH (n) DETACH DELETE n");
    expect(rec.queries.slice(1).every((q) => q.startsWith("MERGE") || q.startsWith("MATCH (a {id: $from})"))).toBe(true);
    expect(result.nodes).toBeGreaterThan(0);
    expect(result.relationships).toBeGreaterThan(0);
  });

  it("merges without wiping when asked to", async () => {
    const rec = recordingTransaction();
    await rebuildVendorGraph(files(ALL), rec.tx, { rebuild: false });
    expect(rec.queries).not.toContain("MATCH (n) DETACH DELETE n");
  });

  it("never opens a transaction when the sources are invalid", async () => {
    const rec = recordingTransaction();
    const broken = { ...ALL, "/repo/config/accounts.local.yaml": "accounts:\n  roche:\n    needs: [time-travel]\n" };
    await expect(rebuildVendorGraph(files(broken), rec.tx)).rejects.toThrow("invalid need");
    expect(rec.calls).toBe(0);
  });

  it("propagates a failed write so the transaction rolls back", async () => {
    const failing: WriteTransaction = async (work) =>
      work({
        run: async (query: string) => {
          if (query.includes("USES")) throw new Error("Neo4j write failed");
          return undefined;
        },
      });
    await expect(rebuildVendorGraph(files(ALL), failing)).rejects.toThrow("Neo4j write failed");
  });
});
```

Append to `__tests__/graph-routes.test.ts`:

```ts
describe("POST /api/graph/rebuild", () => {
  it("rebuilds whatever stack is active, and reports the counts", async () => {
    const base = await start(fakeDeps({ rebuild: async () => ({ nodes: 60, relationships: 127, lines: ["x"] }) }));
    const { status, body } = await post(`${base}/rebuild`, {});
    expect(status).toBe(200);
    expect(body).toEqual({ message: "Graph rebuild complete", nodes: 60, relationships: 127, output: ["x"] });
  });

  it("refuses a second rebuild while one is running", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = await start(
      fakeDeps({
        rebuild: async () => {
          await gate;
          return { nodes: 0, relationships: 0, lines: [] };
        },
      }),
    );
    const first = post(`${base}/rebuild`, {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await post(`${base}/rebuild`, {});
    expect(second.status).toBe(409);
    release();
    expect((await first).status).toBe(200);
  });

  it("returns 503 when Neo4j is down, without rebuilding", async () => {
    let called = false;
    const base = await start(
      fakeDeps({
        isAvailable: async () => false,
        rebuild: async () => {
          called = true;
          return { nodes: 0, relationships: 0, lines: [] };
        },
      }),
    );
    expect((await post(`${base}/rebuild`, {})).status).toBe(503);
    expect(called).toBe(false);
  });

  it("returns 500 with the validation message from a bad source", async () => {
    const base = await start(
      fakeDeps({
        rebuild: async () => {
          throw new Error("dell-storage-block.md: invalid position");
        },
      }),
    );
    const { status, body } = await post(`${base}/rebuild`, {});
    expect(status).toBe(500);
    expect(body.error).toBe("dell-storage-block.md: invalid position");
  });
});
```

and remove the `as GraphRouterDeps` cast from `fakeDeps` (its return becomes a plain `GraphRouterDeps` once `rebuild` is part of the interface).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- __tests__/vendor-graph-rebuild.test.ts __tests__/graph-routes.test.ts`
Expected: FAIL — module `vendor-graph-rebuild.js` not found; the rebuild route still answers 409 on a non-Ollama active stack or calls the Python builder.

- [ ] **Step 3: Implement `src/services/vendor-graph-rebuild.ts`**

```ts
// Rebuilds the vendor-intelligence graph from its three deterministic sources:
// knowledge/vendors/*.md, config/needs.yaml and config/accounts.local.yaml.
// Shared by scripts/rebuild-vendor-graph.ts and POST /api/graph/rebuild.
//
// No model is involved, so a rebuild works on every stack -- the Python builder
// this replaces called Ollama directly and was refused (409) on the other three.
// The wipe and the writes share one transaction: a failure part-way leaves the
// previous graph in place instead of a half-written one.
import type { Driver } from "neo4j-driver";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { accountToGraphFacts, needsMapToGraphFacts, parseAccounts, parseNeedsMap } from "./graph-accounts.js";
import { briefToGraphFacts, parseVendorBrief, type GraphFacts } from "./graph-schema.js";
import { writeGraphFacts, type GraphWriter } from "./graph-writer.js";

export interface RebuildSources {
  root: string;
  readDir?: (dir: string) => string[];
  readFile?: (path: string) => string;
}

export interface CollectedFacts {
  batch: GraphFacts[];
  lines: string[];
}

function isMissingFile(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}

/**
 * Read an optional source. A missing file is skipped and reported; a present
 * file that fails to parse throws. The difference matters for a wipe-and-write
 * rebuild: skipping a broken accounts file would silently delete every account.
 */
function optionalSource(
  name: string,
  path: string,
  readFile: (path: string) => string,
  lines: string[],
  toFacts: (text: string) => GraphFacts[],
): GraphFacts[] {
  let text: string;
  try {
    text = readFile(path);
  } catch (err) {
    if (isMissingFile(err)) {
      lines.push(`${name.padEnd(28)} -> skipped (no such file)`);
      return [];
    }
    throw err;
  }
  try {
    return toFacts(text);
  } catch (err) {
    throw new Error(`${name}: ${(err as Error).message}`);
  }
}

export function collectVendorGraphFacts(sources: RebuildSources): CollectedFacts {
  const readDir = sources.readDir ?? ((dir: string) => readdirSync(dir));
  const readFile = sources.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const briefsDir = join(sources.root, "knowledge", "vendors");
  const batch: GraphFacts[] = [];
  const lines: string[] = [];

  for (const file of readDir(briefsDir).filter((f) => f.endsWith(".md")).sort()) {
    // A bad brief throws: a rebuild without it would silently drop that vendor's position.
    let facts: GraphFacts;
    let label: string;
    try {
      const brief = parseVendorBrief(readFile(join(briefsDir, file)));
      facts = briefToGraphFacts(brief);
      label = `${brief.vendor}/${brief.segment} ${brief.position}/${brief.confidence}`;
    } catch (err) {
      throw new Error(`${file}: ${(err as Error).message}`);
    }
    batch.push(facts);
    lines.push(`${file.padEnd(28)} ${label} -> ${facts.nodes.length} nodes, ${facts.relationships.length} rels`);
  }

  batch.push(
    ...optionalSource("needs.yaml", join(sources.root, "config", "needs.yaml"), readFile, lines, (text) => {
      const facts = needsMapToGraphFacts(parseNeedsMap(text));
      lines.push(`${"needs.yaml".padEnd(28)} -> ${facts.relationships.length} ADDRESSED_BY edges`);
      return [facts];
    }),
  );

  batch.push(
    ...optionalSource("accounts.local.yaml", join(sources.root, "config", "accounts.local.yaml"), readFile, lines, (text) =>
      parseAccounts(text).map((account) => {
        const facts = accountToGraphFacts(account);
        lines.push(
          `${`${account.id}.account`.padEnd(28)} ${account.needs.length} needs, ` +
            `${Object.keys(account.incumbents).length} segment(s) with a known incumbent -> ${facts.relationships.length} rels`,
        );
        return facts;
      }),
    ),
  );

  return { batch, lines };
}

export interface CypherRunner {
  run(query: string, params?: Record<string, unknown>): PromiseLike<unknown>;
}

export function cypherGraphWriter(runner: CypherRunner): GraphWriter {
  return {
    async clear() {
      await runner.run("MATCH (n) DETACH DELETE n");
    },
    async mergeNode(label, id, properties) {
      // The label is interpolated because Cypher cannot parameterise it; it is
      // safe only because writeGraphFacts has already checked it against the
      // closed set. Never relax that check.
      await runner.run(`MERGE (n:${label} {id: $id}) SET n += $properties`, { id, properties });
    },
    async mergeRelationship(type, from, to, properties, identity) {
      // Identity properties belong in the MERGE pattern: without them, two USES
      // edges for different segments collapse into one and a segment is lost.
      const pattern = identity.length ? `{${identity.map((k) => `${k}: $id_${k}`).join(", ")}}` : "";
      const idParams = Object.fromEntries(identity.map((k) => [`id_${k}`, properties[k]]));
      await runner.run(
        `MATCH (a {id: $from}), (b {id: $to}) MERGE (a)-[r:${type} ${pattern}]->(b) SET r += $properties`,
        { from, to, properties, ...idParams },
      );
    },
  };
}

export type WriteTransaction = <T>(work: (runner: CypherRunner) => Promise<T>) => Promise<T>;

export function neo4jWriteTransaction(driver: Driver): WriteTransaction {
  return async (work) => {
    const session = driver.session();
    try {
      return await session.executeWrite((tx) => work(tx));
    } finally {
      await session.close();
    }
  };
}

export interface RebuildResult {
  nodes: number;
  relationships: number;
  lines: string[];
}

/** Validate every source, then (by default) wipe and rewrite the graph in one transaction. */
export async function rebuildVendorGraph(
  sources: RebuildSources,
  inTransaction: WriteTransaction,
  options: { rebuild?: boolean } = {},
): Promise<RebuildResult> {
  const { batch, lines } = collectVendorGraphFacts(sources);
  const written = await inTransaction((runner) =>
    writeGraphFacts(batch, cypherGraphWriter(runner), { rebuild: options.rebuild ?? true }),
  );
  return { ...written, lines };
}
```

Note: `writeGraphFacts` validates every label, type and endpoint before it calls `clear()`, so a dangling edge also fails before the wipe.

- [ ] **Step 4: Replace the rebuild route in `src/api/graph.ts`**

Add to the imports:

```ts
import { getDriver } from "../services/graph-store.js";
import { neo4jWriteTransaction, rebuildVendorGraph, type RebuildResult } from "../services/vendor-graph-rebuild.js";
```

(merge `getDriver` into the existing `graph-store.js` import line, and drop `clearGraph` from it, along with the now-unused `getActiveStack` and `serviceUrl` imports).

Add to `GraphRouterDeps`:

```ts
  /** Wipe and rewrite the graph from briefs, needs and accounts, in one transaction. */
  rebuild(): Promise<RebuildResult>;
```

Replace the whole `router.post("/rebuild", ...)` handler with:

```ts
  // POST /api/graph/rebuild - rebuild the graph from knowledge/vendors, config/needs.yaml and
  // config/accounts.local.yaml. Deterministic, no model call, so it works on every stack.
  let rebuilding = false;
  router.post("/rebuild", async (_req: Request, res: Response): Promise<void> => {
    if (rebuilding) {
      res.status(409).json({ error: "A graph rebuild is already running" });
      return;
    }
    rebuilding = true;
    try {
      if (!(await deps.isAvailable())) {
        res.status(503).json({ error: "Neo4j is not reachable" });
        return;
      }
      const result = await deps.rebuild();
      console.log(`[Graph Rebuild] ${result.nodes} nodes, ${result.relationships} relationships`);
      res.json({ message: "Graph rebuild complete", nodes: result.nodes, relationships: result.relationships, output: result.lines });
    } catch (err) {
      console.error("[Graph Rebuild] Error:", errorMessage(err));
      res.status(500).json({ error: errorMessage(err) });
    } finally {
      rebuilding = false;
    }
  });
```

Add to the object returned by `liveGraphRouterDeps()`:

```ts
    rebuild: () => rebuildVendorGraph({ root: process.cwd() }, neo4jWriteTransaction(getDriver())),
```

- [ ] **Step 5: Make the script a thin CLI over the service**

Replace `scripts/rebuild-vendor-graph.ts` with:

```ts
// Rebuild the vendor-intelligence graph from knowledge/vendors/*.md,
// config/needs.yaml and config/accounts.local.yaml.
//
// Usage:
//   npx tsx scripts/rebuild-vendor-graph.ts          dry run, prints the plan
//   npx tsx scripts/rebuild-vendor-graph.ts --apply  merge into the graph
//   npx tsx scripts/rebuild-vendor-graph.ts --apply --rebuild
//                                                    WIPE the graph, then write (one transaction)
//
// POST /api/graph/rebuild does the same as --apply --rebuild.
// --rebuild is destructive. Export first: scripts/export-graph.ts
import neo4j from "neo4j-driver";
import { serviceUrl } from "../src/platform/host-config.js";
import { writeGraphFacts, type GraphWriter } from "../src/services/graph-writer.js";
import {
  collectVendorGraphFacts,
  neo4jWriteTransaction,
  rebuildVendorGraph,
} from "../src/services/vendor-graph-rebuild.js";

const apply = process.argv.includes("--apply");
const rebuild = process.argv.includes("--rebuild");
const sources = { root: process.cwd() };

if (!apply) {
  const { batch, lines } = collectVendorGraphFacts(sources);
  for (const line of lines) console.log(line);
  // Still runs the whole validation and dedupe path, just against a writer that
  // records instead of writing -- a dry run that skipped it would prove nothing.
  const counted = { nodes: 0, relationships: 0 };
  const noop: GraphWriter = {
    async clear() {},
    async mergeNode() {
      counted.nodes++;
    },
    async mergeRelationship() {
      counted.relationships++;
    },
  };
  await writeGraphFacts(batch, noop);
  console.log(`\nDRY RUN — would write ${counted.nodes} nodes and ${counted.relationships} relationships`);
  console.log("pass --apply to write, add --rebuild to wipe the graph first");
  process.exit(0);
}

const driver = neo4j.driver(
  serviceUrl("neo4j"),
  neo4j.auth.basic(process.env.NEO4J_USER ?? "neo4j", process.env.NEO4J_PASSWORD ?? "pharma2024"),
);

try {
  if (rebuild) console.log("WIPING the graph before writing (--rebuild), in the same transaction");
  const result = await rebuildVendorGraph(sources, neo4jWriteTransaction(driver), { rebuild });
  for (const line of result.lines) console.log(line);
  console.log(`\nAPPLIED — ${result.nodes} nodes, ${result.relationships} relationships`);

  const session = driver.session({ defaultAccessMode: neo4j.session.READ });
  try {
    const check = await session.run(
      "MATCH (n) WITH count(n) AS nodes MATCH ()-[r]->() RETURN nodes, count(r) AS rels, count(DISTINCT type(r)) AS types",
    );
    const row = check.records[0];
    console.log(
      `graph now holds ${row.get("nodes")} nodes, ${row.get("rels")} relationships, ` +
        `${row.get("types")} distinct relationship types`,
    );
  } finally {
    await session.close();
  }
} finally {
  await driver.close();
}
```

- [ ] **Step 6: Delete the Python builder and its gate test**

```bash
git rm python/graph_builder.py __tests__/graph-stack-gate.test.ts
grep -rn "graph_builder" src scripts __tests__ python hermes mcp/src
```

Expected: the grep prints nothing (README and CLAUDE.md are updated in Task 7).

- [ ] **Step 7: Run the tests, the script's dry run and the typecheck**

Run: `npm test -- __tests__/vendor-graph-rebuild.test.ts __tests__/graph-routes.test.ts && npm run typecheck && npx tsx scripts/rebuild-vendor-graph.ts`
Expected: tests PASS; typecheck clean; the dry run (reads files only, writes nothing) prints one line per brief, the needs line, one line per account, and `DRY RUN — would write … nodes and … relationships`.

- [ ] **Step 8: Commit**

```bash
git add src/services/vendor-graph-rebuild.ts scripts/rebuild-vendor-graph.ts src/api/graph.ts \
  __tests__/vendor-graph-rebuild.test.ts __tests__/graph-routes.test.ts
git commit -m "feat: graph rebuild is deterministic, transactional and works on every stack

The Python builder called Ollama and wrote the old cyber schema; the route now
rebuilds from briefs, needs and accounts in one write transaction. A broken
accounts file now fails the rebuild instead of silently dropping every account.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Documentation, full verification, deployment

**Files:**
- Modify: `README.md` (lines 273, 888–893, 1057–1058, 1196, 1243 — find each with the grep below)
- Modify: `CLAUDE.md:77`
- Modify: `docs/superpowers/specs/2026-09-21-vendor-intel-graph-design.md:4`

- [ ] **Step 1: Find every stale reference**

Run: `grep -n "graph_builder\|graph/search\|graph_search\|Graph rebuild\|graph/rebuild" README.md CLAUDE.md`

- [ ] **Step 2: Update README.md**

- Stack comparison row (`| **Graph rebuild** |`, ~line 273): every stack cell becomes `✅ supported`; drop the `409` notes.
- The manual-rebuild block (~lines 888–893) that runs `python python/graph_builder.py` and explains Ollama's `/api/generate`: replace with

  ````markdown
  ```bash
  npx tsx scripts/rebuild-vendor-graph.ts                    # dry run
  npx tsx scripts/rebuild-vendor-graph.ts --apply --rebuild  # wipe and rewrite, one transaction
  ```

  The graph is built from `knowledge/vendors/*.md` (vendor briefs), `config/needs.yaml` and
  `config/accounts.local.yaml`, with no model call, so it rebuilds on any stack.
  `POST /api/graph/rebuild` does the same as `--apply --rebuild`. Browse it at http://localhost:7474.
  ````
- API table: replace the `/api/graph/search` row with
  `| /api/graph/competitive-position | POST | token | A vendor's standing per account segment: incumbency mode (defend / displace / greenfield), position, rationale, brief claims, recent news. Body: vendor?, account?, segment? |`
  and make the `/api/graph/rebuild` row read `Rebuild the graph from vendor briefs, needs and accounts (any stack; 409 while one is running)`.
- Project tree: delete the `graph_builder.py` line.
- Troubleshooting: delete the "`/api/graph/rebuild` returns `409`" row.

- [ ] **Step 3: Update CLAUDE.md:77**

Replace `Graph rebuild (`python/graph_builder.py`) only works on Ollama (409 otherwise).` with:

```
Graph rebuild (`POST /api/graph/rebuild`, `scripts/rebuild-vendor-graph.ts`) is deterministic — vendor briefs,
`config/needs.yaml`, `config/accounts.local.yaml`, one write transaction — and works on every stack. MCP
`competitive_position` (`competitive-graph.ts`) answers "what is <vendor> doing best for my accounts", incumbency first.
```

- [ ] **Step 4: Update the spec's status line**

Replace `**Status:** approved design, not yet implemented` with:

```
**Status:** implemented except the watchlist→`Evidence` live hook and legacy-document re-extraction
(plan: `docs/superpowers/plans/2026-10-01-competitive-position.md`; curated excerpts come from the brief
files and recent evidence from `watchlist.db` — see the plan's "Deliberate deviations")
```

- [ ] **Step 5: Full verification**

Run each and read the output:

```bash
npm run typecheck
npm run typecheck:tests
npm test
npm --prefix mcp run typecheck
npm --prefix mcp test
npm run test:hermes-plugin
```

Expected: every command exits 0; Jest reports 0 failed suites in both packages.

- [ ] **Step 6: Commit the docs**

```bash
git add README.md CLAUDE.md docs/superpowers/specs/2026-09-21-vendor-intel-graph-design.md
git commit -m "docs: competitive_position and the any-stack graph rebuild

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Deploy after merge (operator, against live services — not part of any test)**

1. The app reloads itself (`tsx watch` under `com.pharmaitchat.stack`). Restart the MCP server so it registers the new tool: `launchctl kickstart -k gui/$(id -u)/com.pharmaitchat.mcp`.
2. Smoke-test the route with the API token passed on stdin (never as an argument):

   ```bash
   printf 'Authorization: Bearer %s\n' "$(cat data/run/api-token)" | \
     curl -s -H @- -H 'Content-Type: application/json' \
     -d '{"vendor":"dell"}' http://localhost:3000/api/graph/competitive-position | head -c 1500
   ```

   Expected: JSON with `accounts` for roche, novartis and sandoz, `market` with Dell's three storage positions.
3. Hermes chats whose history used `graph_search` will call a tool that no longer exists. Run `bash scripts/check-stale-sessions.sh` and rotate any flagged chat with `/new` from inside it.
4. Ask the Telegram agent "What is Dell doing best for my accounts?" and check the answer names a mode per segment and does not rank vendors.
