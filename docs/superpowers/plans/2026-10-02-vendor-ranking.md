# Win-likelihood Ranking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `competitive_position` ranks vendors by win likelihood inside each account segment (top 3 plus the asked vendor, with reasons), using deterministic rules and install-base triggers declared in `accounts.local.yaml`.

**Architecture:** Triggers are parsed and validated with the accounts (`graph-accounts.ts`), stored on the Account node as a JSON string, and read defensively into the snapshot (`competitive-graph.ts`). A new pure module (`segment-ranking.ts`) turns one segment's declared state, incumbents, trigger and positions into a regime and a ranking; the resolver (`competitive-position.ts`) attaches it to every `SegmentView`; the answer adds regime guidance; the chat renders a trigger and a ranking line.

**Tech Stack:** TypeScript ESM (Node16, strict), Jest (ESM), `yaml`, neo4j-driver, zod (MCP).

**Spec:** `docs/superpowers/specs/2026-10-02-vendor-ranking-design.md` (amended in `c5381c1`: top 3 plus the queried vendor, compact reasons).

**Worktree:** `.worktrees/vendor-ranking`, branch `feature/vendor-ranking`, stacked on PR #65. Run every command from the worktree root.

## Global Constraints

- Tests never touch live services. No `any`. Interfaces for object shapes. Siblings imported as `./x.js`.
- `npm run typecheck` after every code change; `npm run typecheck:tests` before each commit; `npm --prefix mcp run typecheck` after MCP changes.
- Commit prefixes `feat:` `fix:` `refactor:` `test:` `docs:`; every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Regimes: `unknown` (segment not declared and no incumbent) → `ranking: null`, `ranked: 0`; `greenfield` (declared `[]`) → by position; `defend` (incumbents, no trigger) → incumbents first, then by position; `open` (incumbents + trigger) → by position, incumbent wins a tie.
- Position order: `leader` 4 > `strong` 3 > `present` 2 > no brief 1 > `absent` 0. `absent` vendors are candidates only if incumbent.
- Competition ranks (1, 1, 3); no tie-breaker except incumbency in `open`; tied entries listed by vendor id for stable output.
- Shown: rank ≤ `RANKING_TOP` (3), ties at 3 included, plus the queried vendor wherever it ranks; `ranked` = number of candidates ranked.
- Reasons: exactly two, `[role, position]`; role ∈ `incumbent` | `rival` | `nobody installed`; position = `<label>/<confidence>` or `no brief`.
- Triggers are install-base facts, never pipeline data (no stages, amounts, close dates). The user's `config/accounts.local.yaml` is **not edited without the user's yes**; no live rebuild without a yes.

## Review Focus

1. **A graph built before `declaredSegments` existed** (incumbents as USES edges, `declared: []`) must rank a segment with incumbents as `defend`, never `unknown`. Pinned in Task 4 ("legacy graph").
2. **`triggers:` written as a list or a scalar** in YAML must fail with a clear message, not iterate characters or array indexes. Pinned in Task 1.
3. **Trigger text with quotes, a colon or a newline** must survive YAML → JSON property → snapshot unchanged. Pinned in Tasks 1 and 2.
4. **The queried vendor is `absent` in a segment and not installed there**: it is not a candidate, so it is neither ranked nor shown, and `ranked` excludes it. Pinned in Task 3.
5. **A full-graph account question** must stay under the 24k budget with rankings on every segment, and no ranking is ever trimmed. Pinned in Task 4 (budget assertion).

---

### Task 1: Triggers in the accounts file

**Files:**
- Modify: `src/services/graph-accounts.ts` (`Account`, `parseAccounts`, `accountToGraphFacts`)
- Modify: `config/accounts.example.yaml`
- Test: `__tests__/graph-accounts.test.ts`

**Interfaces:**
- Produces: `Account.triggers: Partial<Record<Segment, string>>` (trimmed text); Account node property `triggers` = `JSON.stringify` of the map with keys in `SEGMENTS` order, omitted when empty.

- [ ] **Step 1: Write the failing tests**

Add inside `describe("parseAccounts", …)` in `__tests__/graph-accounts.test.ts`:

```ts
  const withTriggers = (triggers: string, incumbents = "      storage-block: [everpure]\n") =>
    yaml(`  roche:
    name: Roche
    needs: []
    incumbents:
${incumbents}    triggers:
${triggers}`);

  it("reads a trigger on a segment held by a rival, trimmed", () => {
    const account = parseAccounts(withTriggers('      storage-block: "  everpure arrays reach end of support 2027-03 "\n'))[0];
    expect(account.triggers).toEqual({ "storage-block": "everpure arrays reach end of support 2027-03" });
  });

  it("reads no triggers when the key is absent", () => {
    expect(parseAccounts(roche)[0].triggers).toEqual({});
  });

  it("refuses a trigger on a segment outside the closed set", () => {
    expect(() => parseAccounts(withTriggers('      time-machine: "x"\n'))).toThrow(
      "roche: triggers.time-machine is not a segment",
    );
  });

  it("refuses an empty or non-text trigger", () => {
    const message = "roche: triggers.storage-block must be a non-empty description of the install-base event";
    expect(() => parseAccounts(withTriggers('      storage-block: "  "\n'))).toThrow(message);
    expect(() => parseAccounts(withTriggers("      storage-block: [a, b]\n"))).toThrow(message);
  });

  it("refuses a trigger on a segment with no declared incumbents, empty or omitted", () => {
    const message = "roche: triggers.storage-block opens a segment held by a rival; declare its incumbents first";
    expect(() => parseAccounts(withTriggers('      storage-block: "x"\n', "      storage-block: []\n"))).toThrow(message);
    expect(() => parseAccounts(withTriggers('      storage-block: "x"\n', "      storage-file: [netapp]\n"))).toThrow(message);
  });

  it("refuses triggers written as a list or a scalar", () => {
    const message = "roche: triggers must be a map of segment to description";
    expect(() => parseAccounts(withTriggers("      - storage-block\n"))).toThrow(message);
    const scalar = yaml(`  roche:
    name: Roche
    needs: []
    triggers: soon
`);
    expect(() => parseAccounts(scalar)).toThrow(message);
  });
```

Add inside the `describe` that tests `accountToGraphFacts` (next to "records every declared segment on the account…"):

```ts
  it("stores triggers on the account as JSON, quotes and newlines intact, and nothing when there are none", () => {
    const account = parseAccounts(
      yaml(`  roche:
    name: Roche
    needs: []
    incumbents:
      storage-file: [netapp]
      storage-block: [everpure]
    triggers:
      storage-file: "NetApp \\"ONTAP 9\\": renewal 2027-01\\nsecond line"
      storage-block: "end of support"
`),
    )[0];
    const node = accountToGraphFacts(account).nodes.find((n) => n.label === "Account");
    expect(node?.properties.triggers).toBe(
      JSON.stringify({ "storage-block": "end of support", "storage-file": 'NetApp "ONTAP 9": renewal 2027-01\nsecond line' }),
    );
    expect(accountToGraphFacts({ ...account, triggers: {} }).nodes[0].properties).not.toHaveProperty("triggers");
  });
```

Extend the example-file test (`describe("config/accounts.example.yaml", …)`) with:

```ts
  it("shows a trigger on a segment with declared incumbents", () => {
    const roche = parseAccounts(readFileSync("config/accounts.example.yaml", "utf8")).find((a) => a.id === "roche");
    expect(roche?.triggers["storage-block"]).toBe("PowerMax arrays reach end of support 2027-03");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- __tests__/graph-accounts.test.ts`
Expected: FAIL (`triggers` is undefined; no refusals thrown).

- [ ] **Step 3: Implement in `src/services/graph-accounts.ts`**

Add to `Account` after `incumbents`:

```ts
  /**
   * Install-base events that open a segment held by a rival (end of support,
   * refresh due, a renewal date). Facts, not a pipeline: no stages or amounts.
   */
  triggers: Partial<Record<Segment, string>>;
```

In `parseAccounts`, after the incumbents loop and before `return {`, add:

```ts
    const triggers: Partial<Record<Segment, string>> = {};
    if (raw.triggers !== undefined && raw.triggers !== null) {
      if (typeof raw.triggers !== "object" || Array.isArray(raw.triggers)) {
        throw new Error(`${id}: triggers must be a map of segment to description`);
      }
      for (const [segment, text] of Object.entries(raw.triggers as Record<string, unknown>)) {
        if (!(SEGMENTS as readonly string[]).includes(segment)) {
          throw new Error(`${id}: triggers.${segment} is not a segment (expected one of: ${SEGMENTS.join(", ")})`);
        }
        const key = segment as Segment;
        if (typeof text !== "string" || text.trim().length === 0) {
          throw new Error(`${id}: triggers.${key} must be a non-empty description of the install-base event`);
        }
        // A trigger opens a segment a rival holds: on [] there is nothing to
        // displace, and on an undeclared segment it would hide "find out first".
        if ((incumbents[key] ?? []).length === 0) {
          throw new Error(`${id}: triggers.${key} opens a segment held by a rival; declare its incumbents first`);
        }
        triggers[key] = text.trim();
      }
    }
```

and add `triggers,` after `incumbents,` in the returned object.

In `accountToGraphFacts`, in the Account node's `properties`, after `declaredSegments: …,` add:

```ts
        // Neo4j properties cannot be maps: JSON, keys in segment order, omitted when none.
        ...(Object.keys(account.triggers).length > 0
          ? {
              triggers: JSON.stringify(
                Object.fromEntries(SEGMENTS.filter((s) => account.triggers[s] !== undefined).map((s) => [s, account.triggers[s]])),
              ),
            }
          : {}),
```

- [ ] **Step 4: Add the example**

In `config/accounts.example.yaml`, in the `roche` account, insert before the line `    # Free text. Anything a brief cannot know: site names, live programmes,`:

```yaml
    # Install-base events that open a segment held by a rival: end of support,
    # refresh due, a renewal date. Facts, not a pipeline -- no stages, amounts or
    # close dates. Only on segments with declared incumbents. Without one, the
    # incumbent keeps the segment in the ranking; with one, position decides.
    triggers:
      storage-block: "PowerMax arrays reach end of support 2027-03"

```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npm test -- __tests__/graph-accounts.test.ts __tests__/vendor-graph-rebuild.test.ts && npm run typecheck && npm run typecheck:tests`
Expected: PASS. If the typecheck flags another place that builds an `Account` literal, add `triggers: {}` there.

- [ ] **Step 6: Commit**

```bash
git add src/services/graph-accounts.ts config/accounts.example.yaml __tests__/graph-accounts.test.ts
git commit -m "feat: install-base triggers in the accounts file, validated and stored on the account

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The snapshot reads triggers, never throwing

**Files:**
- Modify: `src/services/competitive-position.ts` (`SnapshotAccount`, `GraphSnapshot` types only)
- Modify: `src/services/competitive-graph.ts` (`ACCOUNTS_CYPHER`, `readGraphSnapshot`)
- Test: `__tests__/competitive-graph.test.ts`

**Interfaces:**
- Consumes (Task 1): Account property `triggers` (JSON string or absent).
- Produces: `SnapshotAccount.triggers?: Record<string, string>` (always set by `readGraphSnapshot`; optional so hand-built snapshots in tests stay valid); `GraphSnapshot.notes?: string[]` (always set by `readGraphSnapshot`).

- [ ] **Step 1: Write the failing tests**

In `__tests__/competitive-graph.test.ts`, in the existing "turns rows into a snapshot…" test, add `triggers: {},` to the expected Roche account (after `uses: …`) and `notes: [],` to the expected snapshot (after `vendorAliases`). Then add to `describe("readGraphSnapshot", …)`:

```ts
  it("reads an account's triggers, quotes and newlines intact", async () => {
    const text = 'NetApp "ONTAP 9": renewal\nsecond line';
    const rows = { ...ROWS, accounts: [{ ...ROWS.accounts[0], triggers: JSON.stringify({ "storage-block": text }) }] };
    const snap = await readGraphSnapshot(fakeCypher(rows), {});
    expect(snap.accounts[0].triggers).toEqual({ "storage-block": text });
    expect(snap.notes).toEqual([]);
  });

  it("reads unreadable triggers as none, with a note, and never throws", async () => {
    for (const bad of ["{not json", JSON.stringify(["storage-block"]), JSON.stringify({ "storage-block": 3 })]) {
      const rows = { ...ROWS, accounts: [{ ...ROWS.accounts[0], triggers: bad }] };
      const snap = await readGraphSnapshot(fakeCypher(rows), {});
      expect(snap.accounts[0].triggers).toEqual({});
      expect(snap.notes).toEqual(["account roche: unreadable triggers, ignored until the next rebuild"]);
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- __tests__/competitive-graph.test.ts -t "readGraphSnapshot"`
Expected: FAIL (`triggers`/`notes` missing from the snapshot).

- [ ] **Step 3: Implement**

In `src/services/competitive-position.ts`, add to `SnapshotAccount` after `uses`:

```ts
  /** Declared install-base triggers by segment; absent on hand-built snapshots. */
  triggers?: Record<string, string>;
```

and to `GraphSnapshot` after `vendorAliases`:

```ts
  /** Problems met while reading the graph, passed on to the answer's notes. */
  notes?: string[];
```

In `src/services/competitive-graph.ts`, change the `RETURN` line of `ACCOUNTS_CYPHER` to:

```ts
  RETURN a.id AS id, a.name AS name, a.aliases AS aliases, a.declaredSegments AS declaredSegments,
         a.triggers AS triggers, needs,
```

(keep the following `collect(…) AS uses` line as is). Below `commaList`, add:

```ts
// graph-accounts.ts stores triggers as JSON (Neo4j properties cannot be maps).
// A graph built before triggers existed has none; a bad value is reported and
// ignored, never thrown: one account's typo must not take every answer down.
function triggers(value: unknown, account: string, notes: string[]): Record<string, string> {
  if (value === undefined || value === null) return {};
  try {
    const parsed: unknown = typeof value === "string" ? JSON.parse(value) : null;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Object.values(parsed).every((v) => typeof v === "string")
    ) {
      return { ...(parsed as Record<string, string>) };
    }
  } catch {
    // Reported below.
  }
  notes.push(`account ${account}: unreadable triggers, ignored until the next rebuild`);
  return {};
}
```

In `readGraphSnapshot`, add `const notes: string[] = [];` before `return {`, add to each account object after `uses: uses(r.uses),`:

```ts
      triggers: triggers(r.triggers, str(r.id, "id"), notes),
```

and add `notes,` after `vendorAliases,` in the returned snapshot.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -- __tests__/competitive-graph.test.ts __tests__/competitive-position.test.ts __tests__/chat-graph-context.test.ts && npm run typecheck && npm run typecheck:tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/competitive-position.ts src/services/competitive-graph.ts __tests__/competitive-graph.test.ts
git commit -m "feat: snapshot reads account triggers defensively

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `segment-ranking.ts`, the rules

**Files:**
- Create: `src/services/segment-ranking.ts`
- Test: `__tests__/segment-ranking.test.ts`

**Interfaces:**
- Produces:
  - `type Regime = "unknown" | "greenfield" | "defend" | "open"`
  - `interface RankedVendor { vendor: string; rank: number; reasons: string[] }`
  - `interface SegmentPosition { position: string; confidence: string }`
  - `interface RankingInput { declared: boolean; incumbents: string[]; trigger: string | null; positions: ReadonlyMap<string, SegmentPosition>; keep: string | null }`
  - `interface SegmentRanking { regime: Regime; ranking: RankedVendor[] | null; ranked: number }`
  - `RANKING_TOP = 3`
  - `rankSegment(input: RankingInput): SegmentRanking`

- [ ] **Step 1: Write the failing tests**

Create `__tests__/segment-ranking.test.ts`:

```ts
import { describe, expect, it } from "@jest/globals";
import { RANKING_TOP, rankSegment, type RankingInput, type SegmentPosition } from "../src/services/segment-ranking.js";

function positions(entries: Record<string, string>): Map<string, SegmentPosition> {
  return new Map(Object.entries(entries).map(([vendor, label]) => [vendor, { position: label, confidence: "high" }]));
}

function input(over: Partial<RankingInput>): RankingInput {
  return { declared: true, incumbents: [], trigger: null, positions: new Map(), keep: null, ...over };
}

const brief = (ranking: ReturnType<typeof rankSegment>["ranking"]) => ranking?.map((r) => `${r.rank} ${r.vendor}`);

describe("rankSegment", () => {
  it("does not rank a segment nobody declared", () => {
    expect(rankSegment(input({ declared: false, positions: positions({ dell: "leader" }) }))).toEqual({
      regime: "unknown",
      ranking: null,
      ranked: 0,
    });
  });

  it("ranks a declared-empty segment by position, ties sharing a rank", () => {
    const result = rankSegment(input({ positions: positions({ hpe: "leader", dell: "leader", netapp: "strong" }) }));
    expect(result.regime).toBe("greenfield");
    expect(brief(result.ranking)).toEqual(["1 dell", "1 hpe", "3 netapp"]);
    expect(result.ranking?.[0].reasons).toEqual(["nobody installed", "leader/high"]);
  });

  it("keeps the incumbent first without a trigger, even above a leader", () => {
    const result = rankSegment(input({ incumbents: ["everpure"], positions: positions({ dell: "leader", hpe: "strong" }) }));
    expect(result.regime).toBe("defend");
    expect(brief(result.ranking)).toEqual(["1 everpure", "2 dell", "3 hpe"]);
    expect(result.ranking?.map((r) => r.reasons)).toEqual([
      ["incumbent", "no brief"],
      ["rival", "leader/high"],
      ["rival", "strong/high"],
    ]);
  });

  it("lets position decide once a trigger is declared", () => {
    const result = rankSegment(
      input({ incumbents: ["everpure"], trigger: "end of support", positions: positions({ dell: "leader", hpe: "strong" }) }),
    );
    expect(result.regime).toBe("open");
    expect(brief(result.ranking)).toEqual(["1 dell", "2 hpe", "3 everpure"]);
  });

  it("gives the incumbent a tie in an open segment, and nothing else breaks ties", () => {
    const result = rankSegment(
      input({ incumbents: ["hpe"], trigger: "renewal", positions: positions({ hpe: "strong", dell: "strong", netapp: "strong" }) }),
    );
    expect(brief(result.ranking)).toEqual(["1 hpe", "2 dell", "2 netapp"]);
  });

  it("leaves out a vendor absent from the segment unless it is installed there", () => {
    const result = rankSegment(
      input({ incumbents: ["ibm"], positions: positions({ ibm: "absent", dell: "absent", hpe: "strong" }), keep: "dell" }),
    );
    expect(brief(result.ranking)).toEqual(["1 ibm", "2 hpe"]);
    expect(result.ranked).toBe(2);
  });

  it(`shows the top ${RANKING_TOP} with ties at ${RANKING_TOP}, plus the asked vendor, and counts them all`, () => {
    const result = rankSegment(
      input({
        incumbents: ["x"],
        positions: positions({ a: "leader", b: "strong", c: "strong", d: "present", e: "present" }),
        keep: "e",
      }),
    );
    expect(brief(result.ranking)).toEqual(["1 x", "2 a", "3 b", "3 c", "5 e"]);
    expect(result.ranked).toBe(6);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- __tests__/segment-ranking.test.ts`
Expected: FAIL with `Could not locate module ../src/services/segment-ranking.js`.

- [ ] **Step 3: Implement `src/services/segment-ranking.ts`**

```ts
// Win likelihood inside one account segment (spec 2026-10-02-vendor-ranking).
//
// Pure and deterministic: incumbency decides first, position second, and
// nothing else breaks a tie -- never alphabetical order. A segment whose
// install base is unknown is not ranked at all: guessing there is what the
// whole design refuses to do.
export type Regime = "unknown" | "greenfield" | "defend" | "open";

export interface RankedVendor {
  vendor: string;
  /** Competition rank: equal keys share it and the next rank skips (1, 1, 3). */
  rank: number;
  /** [role, position]: role is incumbent | rival | nobody installed; position is label/confidence or "no brief". */
  reasons: string[];
}

export interface SegmentPosition {
  position: string;
  confidence: string;
}

export interface RankingInput {
  /** The account declared this segment's incumbents, an empty list included. */
  declared: boolean;
  incumbents: string[];
  trigger: string | null;
  /** Every vendor a brief places in this segment. */
  positions: ReadonlyMap<string, SegmentPosition>;
  /** The asked-about vendor: shown wherever it ranks. */
  keep: string | null;
}

export interface SegmentRanking {
  regime: Regime;
  /** Top RANKING_TOP (ties included) plus `keep`; null exactly when the regime is unknown. */
  ranking: RankedVendor[] | null;
  /** How many candidates were ranked, shown or not. */
  ranked: number;
}

/** A full list costs ~7k of untrimmable JSON on a full graph; the top 3 answers the question. */
export const RANKING_TOP = 3;

const POSITION_SCORE: Record<string, number> = { leader: 4, strong: 3, present: 2, absent: 0 };
const NO_BRIEF_SCORE = 1;

/** True when key a sorts strictly above key b (compared element by element, higher first). */
function above(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export function rankSegment(input: RankingInput): SegmentRanking {
  if (!input.declared) return { regime: "unknown", ranking: null, ranked: 0 };
  const regime: Regime = input.incumbents.length === 0 ? "greenfield" : input.trigger !== null ? "open" : "defend";

  // An installed vendor is always a candidate; anyone else needs a brief that places it here.
  const candidates = new Set(input.incumbents);
  for (const [vendor, p] of input.positions) if (p.position !== "absent") candidates.add(vendor);

  const entries = [...candidates].map((vendor) => {
    const p = input.positions.get(vendor) ?? null;
    const incumbent = input.incumbents.includes(vendor);
    const score = p === null ? NO_BRIEF_SCORE : (POSITION_SCORE[p.position] ?? NO_BRIEF_SCORE);
    const key =
      regime === "defend" ? [incumbent ? 1 : 0, score] : regime === "open" ? [score, incumbent ? 1 : 0] : [score];
    const role = regime === "greenfield" ? "nobody installed" : incumbent ? "incumbent" : "rival";
    return { vendor, key, reasons: [role, p === null ? "no brief" : `${p.position}/${p.confidence}`] };
  });

  const ranked = entries
    .map((e) => ({ vendor: e.vendor, rank: 1 + entries.filter((o) => above(o.key, e.key)).length, reasons: e.reasons }))
    // Tied entries are listed by id only so the output is stable; the shared rank carries the meaning.
    .sort((a, b) => a.rank - b.rank || a.vendor.localeCompare(b.vendor));

  return {
    regime,
    ranking: ranked.filter((r) => r.rank <= RANKING_TOP || r.vendor === input.keep),
    ranked: ranked.length,
  };
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -- __tests__/segment-ranking.test.ts && npm run typecheck && npm run typecheck:tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/segment-ranking.ts __tests__/segment-ranking.test.ts
git commit -m "feat: segment-ranking — deterministic win-likelihood rules per account segment

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The resolver ranks every segment; the answer explains regimes

**Files:**
- Modify: `src/services/competitive-position.ts` (header comment, `SegmentView`, `REGIME_GUIDANCE`, resolver)
- Modify: `src/services/competitive-graph.ts` (`CompetitiveAnswer.regimes`, `competitivePositionFrom`)
- Test: `__tests__/competitive-position.test.ts`, `__tests__/competitive-graph.test.ts`, `__tests__/chat-graph-context.test.ts` (fixture only)

**Interfaces:**
- Consumes (Task 2): `SnapshotAccount.triggers?`, `GraphSnapshot.notes?`; (Task 3): `rankSegment`, `Regime`, `RankedVendor`.
- Produces: `SegmentView` gains `regime: Regime; trigger: string | null; ranking: RankedVendor[] | null; ranked: number`; `REGIME_GUIDANCE: Record<Regime, string>`; `CompetitiveAnswer.regimes: Partial<Record<Regime, string>>`.

- [ ] **Step 1: Write the failing tests**

In `__tests__/competitive-position.test.ts`, add `REGIME_GUIDANCE` to the import, then add:

```ts
describe("resolveCompetitivePosition — win-likelihood ranking", () => {
  const segmentOf = (answer: CompetitiveResolution, segment: string) =>
    answer.accounts[0].segments.find((s) => s.segment === segment);
  const brief = (ranking: Array<{ rank: number; vendor: string }> | null | undefined) =>
    ranking?.map((r) => `${r.rank} ${r.vendor}`);

  it("keeps the incumbent first in a segment without a trigger", () => {
    const answer = ok(resolveCompetitivePosition(snapshot(), { account: "roche", segment: "storage-block" }));
    const seg = segmentOf(answer, "storage-block");
    expect(seg?.regime).toBe("defend");
    expect(seg?.trigger).toBeNull();
    expect(brief(seg?.ranking)).toEqual(["1 dell", "2 hpe"]);
    expect(seg?.ranked).toBe(2);
  });

  it("opens the segment when a trigger is declared: position decides", () => {
    const base = snapshot();
    const snap = snapshot({
      accounts: [{ ...base.accounts[0], triggers: { "storage-block": "PowerMax end of support 2027-03" } }],
      positions: [
        { vendor: "dell", segment: "storage-block", position: "present", confidence: "low", rationale: "r", asOf: "" },
        { vendor: "hpe", segment: "storage-block", position: "leader", confidence: "high", rationale: "r", asOf: "" },
      ],
    });
    const seg = segmentOf(ok(resolveCompetitivePosition(snap, { account: "roche", segment: "storage-block" })), "storage-block");
    expect(seg?.regime).toBe("open");
    expect(seg?.trigger).toBe("PowerMax end of support 2027-03");
    expect(brief(seg?.ranking)).toEqual(["1 hpe", "2 dell"]);
  });

  it("does not rank a segment whose install base is unknown, and ranks a declared-empty one", () => {
    const answer = ok(resolveCompetitivePosition(snapshot(), { account: "roche" }));
    expect(segmentOf(answer, "data-protection")).toMatchObject({ regime: "unknown", ranking: null, ranked: 0 });
    expect(segmentOf(answer, "compute-standard")).toMatchObject({ regime: "greenfield", ranking: [], ranked: 0 });
  });

  it("ranks the rivals too when only a vendor is asked about", () => {
    const answer = ok(resolveCompetitivePosition(snapshot(), { vendor: "hpe", account: "roche", segment: "storage-block" }));
    const seg = segmentOf(answer, "storage-block");
    expect(seg?.vendors.map((v) => v.vendor)).toEqual(["hpe"]);
    expect(brief(seg?.ranking)).toEqual(["1 dell", "2 hpe"]);
  });

  it("ranks a legacy graph's installed segment as defend, not unknown", () => {
    // Built before declaredSegments existed: incumbents are USES edges only.
    const base = snapshot();
    const snap = snapshot({ accounts: [{ ...base.accounts[0], declared: [] }] });
    const seg = segmentOf(ok(resolveCompetitivePosition(snap, { account: "roche", segment: "storage-block" })), "storage-block");
    expect(seg?.regime).toBe("defend");
  });

  it("passes snapshot notes on to the answer", () => {
    const snap = snapshot({ notes: ["account roche: unreadable triggers, ignored until the next rebuild"] });
    const answer = ok(resolveCompetitivePosition(snap, { account: "roche" }));
    expect(answer.notes).toContain("account roche: unreadable triggers, ignored until the next rebuild");
  });

  it("has guidance for every regime", () => {
    expect(Object.keys(REGIME_GUIDANCE).sort()).toEqual(["defend", "greenfield", "open", "unknown"]);
  });
});
```

In the existing test "never ranks: vendors in a segment are alphabetical whatever their position", rename it to `"never ranks by ordering: vendors and market stay alphabetical; only ranking orders, with reasons"` and add before its closing `});`:

```ts
    const ranking = answer.accounts[0].segments[0].ranking;
    expect(ranking?.map((r) => r.vendor)).toEqual(["dell", "hpe"]);
    expect(ranking?.every((r) => r.reasons.length === 2)).toBe(true);
```

(Roche declares `storage-block` with `dell` installed, so `defend` puts dell first even though hpe is the leader here.)

In `__tests__/competitive-graph.test.ts`:
- add `REGIME_GUIDANCE` import from `../src/services/competitive-position.js`;
- in `describe("competitivePosition", …)` add:

```ts
  it("explains the regimes its segments use", async () => {
    const result = await competitivePosition(deps(), { account: "roche" });
    if (!result.ok) throw new Error(result.error);
    expect(result.answer.regimes).toEqual({ unknown: REGIME_GUIDANCE.unknown, defend: REGIME_GUIDANCE.defend });
  });
```

- in the budget `it.each` ("keeps a full-graph %s-only answer under the budget…"), add after the existing expectations:

```ts
    // Rankings are structure: present on every segment, never trimmed.
    expect(result.answer.accounts.every((a) => a.segments.every((s) => s.ranking !== undefined && s.ranked >= 0))).toBe(true);
```

- in the `fitBudget` describe's `answer()` fixture, add `regimes: {},` after `modes: {},`.

In `__tests__/chat-graph-context.test.ts`, in `answer()`: add `regimes: {},` after `modes: …,`; add to the storage-block segment object `regime: "defend", trigger: null, ranking: [{ vendor: "dell", rank: 1, reasons: ["incumbent", "leader/high"] }], ranked: 1,` and to the storage-object segment object `regime: "greenfield", trigger: null, ranking: [], ranked: 0,`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- __tests__/competitive-position.test.ts`
Expected: FAIL (`REGIME_GUIDANCE` not exported; `regime`/`ranking` undefined).

- [ ] **Step 3: Implement the resolver changes in `src/services/competitive-position.ts`**

Replace the header's last three comment lines (from `// Vendors are never ranked: every list is alphabetical,` to `// carries little signal and ordering by it would invent one.`) with:

```ts
// Lists are never ordered by position: every list is alphabetical whatever its
// label says -- six of eight vendors are Gartner Leaders, so the label alone
// carries little signal. The one order is each segment's `ranking`
// (segment-ranking.ts): win likelihood there, incumbency first, with reasons.
```

Add the import below `import { SEGMENTS } from "./graph-schema.js";`:

```ts
import { rankSegment, type RankedVendor, type Regime } from "./segment-ranking.js";
```

Add after `MODE_GUIDANCE`:

```ts
export const REGIME_GUIDANCE: Record<Regime, string> = {
  open: "a declared trigger opens the segment: position decides, incumbency only breaks ties",
  defend: "the incumbent keeps the segment unless a trigger is declared: rivals rank behind it",
  greenfield: "nobody is installed: position decides",
  unknown: "no ranking until you record who is installed",
};
```

Add to `SegmentView` after `vendors: VendorInSegment[];`:

```ts
  regime: Regime;
  /** The declared install-base trigger, stated once per segment. */
  trigger: string | null;
  /** Win likelihood here: top 3 plus the asked vendor; null when who is installed is unknown. */
  ranking: RankedVendor[] | null;
  /** How many vendors were ranked, shown or not. */
  ranked: number;
```

In `resolveCompetitivePosition`, change `const notes = new Set<string>();` to:

```ts
  const notes = new Set<string>(snap.notes ?? []);
```

and replace the segment view's `return { segment: seg, via, incumbents, vendors };` with:

```ts
      const trigger = account.triggers?.[seg] ?? null;
      const { regime, ranking, ranked } = rankSegment({
        // A graph built before declaredSegments existed still knows its incumbents.
        declared: account.declared.includes(seg) || incumbents.length > 0,
        incumbents,
        trigger,
        positions: new Map(
          snap.positions
            .filter((p) => p.segment === seg)
            .map((p) => [p.vendor, { position: p.position, confidence: p.confidence }]),
        ),
        keep: vendor,
      });
      return { segment: seg, via, incumbents, vendors, regime, trigger, ranking, ranked };
```

- [ ] **Step 4: Add `regimes` to the answer in `src/services/competitive-graph.ts`**

Add `REGIME_GUIDANCE` to the import from `./competitive-position.js` and `import type { Regime } from "./segment-ranking.js";`. Add to `CompetitiveAnswer` after `modes`:

```ts
  /** What each ranking regime in this answer means; only the regimes that occur. */
  regimes: Partial<Record<Regime, string>>;
```

In `competitivePositionFrom`, after the `modes` loop, add:

```ts
  const regimes: Partial<Record<Regime, string>> = {};
  for (const account of r.accounts) for (const segment of account.segments) regimes[segment.regime] = REGIME_GUIDANCE[segment.regime];
```

and add `regimes,` after `modes,` in the `answer` object literal.

- [ ] **Step 5: Run the tests and typecheck**

Run: `npm test -- __tests__/competitive-position.test.ts __tests__/competitive-graph.test.ts __tests__/chat-graph-context.test.ts __tests__/graph-routes.test.ts && npm run typecheck && npm run typecheck:tests`
Expected: PASS, including the full-graph budget tests with rankings present. If a budget test now reports "still over budget", stop and ledger it: that contradicts the spec's budget decision and needs a ruling, not a looser test.

- [ ] **Step 6: Commit**

```bash
git add src/services/competitive-position.ts src/services/competitive-graph.ts __tests__/competitive-position.test.ts __tests__/competitive-graph.test.ts __tests__/chat-graph-context.test.ts
git commit -m "feat: competitive_position ranks each account segment by win likelihood

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The chat shows the trigger and the ranking

**Files:**
- Modify: `src/services/chat-graph-context.ts` (`renderLines`)
- Test: `__tests__/chat-graph-context.test.ts`

**Interfaces:**
- Consumes (Task 4): `AnswerSegment.regime`, `.trigger`, `.ranking`, `.ranked`.
- Produces: lines `    trigger: <text>` and `    ranking (<regime>): <rank> <vendor> (<reasons, comma-joined>) · … · +N more`, or `    ranking: none, find out who is installed`; an empty ranking prints `    ranking (<regime>): nobody ranked`.

- [ ] **Step 1: Write the failing test**

Add inside `describe("renderCompetitiveContext", …)`:

```ts
  it("prints the trigger and the ranking under each segment's installs", () => {
    const base = answer();
    const block = base.accounts[0].segments[0];
    block.regime = "open";
    block.trigger = "PowerMax end of support 2027-03";
    block.ranking = [
      { vendor: "hpe", rank: 1, reasons: ["rival", "leader/high"] },
      { vendor: "dell", rank: 2, reasons: ["incumbent", "present/low"] },
    ];
    block.ranked = 4;
    base.accounts[0].segments[1].regime = "unknown";
    base.accounts[0].segments[1].ranking = null;
    const text = renderCompetitiveContext(base);
    expect(text).toContain(
      "  storage-block (via cyber-resilience), installed: dell\n" +
        "    trigger: PowerMax end of support 2027-03\n" +
        "    ranking (open): 1 hpe (rival, leader/high) · 2 dell (incumbent, present/low) · +2 more",
    );
    expect(text).toContain("  storage-object, installed: nobody\n    ranking: none, find out who is installed");
  });

  it("says nobody is ranked when a declared segment has no candidates", () => {
    const base = answer();
    expect(renderCompetitiveContext(base)).toContain("  storage-object, installed: nobody\n    ranking (greenfield): nobody ranked");
  });
```

In the existing test "shows each segment's events under its installs, and account-wide news as general", the ranking
line now sits between the `installed:` line and the first event; change its second expectation to:

```ts
    expect(text).toContain(
      "  storage-block (via cyber-resilience), installed: dell\n" +
        "    ranking (defend): 1 dell (incumbent, leader/high)\n" +
        "    ↳ 2026-09-14 [it_move] Roche consolidates EU data centres",
    );
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- __tests__/chat-graph-context.test.ts -t "ranking|ranked|events under its installs"`
Expected: FAIL (no trigger/ranking lines).

- [ ] **Step 3: Implement**

In `src/services/chat-graph-context.ts`, add `type AnswerSegment` to the import from `./competitive-graph.js`, add above `renderLines`:

```ts
function rankingLine(s: AnswerSegment): string {
  if (s.ranking === null) return "    ranking: none, find out who is installed";
  const shown = s.ranking.map((r) => `${r.rank} ${r.vendor} (${r.reasons.join(", ")})`);
  const more = s.ranked - s.ranking.length;
  if (more > 0) shown.push(`+${more} more`);
  return `    ranking (${s.regime}): ${shown.join(" · ") || "nobody ranked"}`;
}
```

and in `renderLines`, right after the `installed:` line push (`lines.push(\`  ${s.segment}${via}, installed: …\`);`), add:

```ts
      if (s.trigger !== null) lines.push(`    trigger: ${s.trigger}`);
      lines.push(rankingLine(s));
```

(before the existing `lines.push(...s.events.map(eventLine));`).

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -- __tests__/chat-graph-context.test.ts && npm run typecheck && npm run typecheck:tests`
Expected: PASS (existing event and budget tests still pass).

- [ ] **Step 5: Commit**

```bash
git add src/services/chat-graph-context.ts __tests__/chat-graph-context.test.ts
git commit -m "feat: chat graph block shows each segment's trigger and ranking

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: MCP contract, docs and verification

**Files:**
- Modify: `mcp/src/tools/graph.ts` (`competitive_position` description)
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-09-21-vendor-intel-graph-design.md` (one pointer)

- [ ] **Step 1: Update the MCP description**

In `mcp/src/tools/graph.ts`, replace `"Positions are labels, not a ranking: never present vendors as ranked. " +` with:

```ts
        "Each segment also carries `ranking`: win likelihood there (top 3 plus the asked vendor, `ranked` = how many " +
        "were ranked; null when who is installed is unknown), with `regime` and any declared `trigger`. Rank vendors " +
        "only as `ranking` gives them, per account and segment, with its reasons; never rank from positions alone, and " +
        "never across accounts. " +
```

Run: `npm --prefix mcp test && npm --prefix mcp run typecheck`
Expected: PASS (update any test that pins the old sentence).

- [ ] **Step 2: Update the docs**

In `CLAUDE.md`, replace `accounts \`general\` (newest Evidence).` with:

```
accounts `general` (newest Evidence), and a win-likelihood `ranking`
  (`segment-ranking.ts`: top 3 + the asked vendor; regimes defend/open/greenfield/unknown; `open` needs an install-base
  trigger declared in `accounts.local.yaml`).
```

In `docs/superpowers/specs/2026-09-21-vendor-intel-graph-design.md`, after the paragraph containing `Ranking was deliberately deferred as too complex.` (insert after the blank line that ends it), add:

```
> **2026-10-02:** win likelihood per account segment is now ranked (`2026-10-02-vendor-ranking-design.md`).
> A market order across accounts stays unranked, for the reason above.

```

- [ ] **Step 3: Full verification**

Run: `npm run typecheck && npm run typecheck:tests && npm test && npm --prefix mcp test && npm --prefix mcp run typecheck`
Expected: all pass. Record totals.

- [ ] **Step 4: Read-only checks on real data**

From the main checkout (real `config/` and `data/`), with this branch's code:

```bash
cd /Users/seb/claude/PharmaLLM && npx tsx .worktrees/vendor-ranking/scripts/rebuild-vendor-graph.ts
```

Expected: the usual lines and `DRY RUN — would write …`; no error from the user's `accounts.local.yaml` (it has no `triggers` yet).

Then a read-only probe (a `.mts` file under `/tmp/claude-rank/`, importing from `.worktrees/vendor-ranking/src/services/`): `competitivePosition(liveCompetitiveDeps(), { vendor: "dell", account: "roche" })`, printing each segment's `regime`, `trigger` and `ranking`, and `renderCompetitiveContext` of the same answer. Expected: `defend`/`unknown` regimes from the live graph (no triggers yet), every ranking entry with two reasons.

- [ ] **Step 5: Offer the live `open` check**

Suggest one trigger line for the user's `config/accounts.local.yaml`, on a segment where the probe shows a rival incumbent, and ask: "Add it and rebuild the live graph?" Only on a yes: add the line, run `npx tsx .worktrees/vendor-ranking/scripts/rebuild-vendor-graph.ts --apply --rebuild` from the main checkout (after `npx tsx scripts/export-graph.ts data/backups/graph-before-ranking-2026-10-02.json`), and re-run the probe to see `open`.

- [ ] **Step 6: Commit, push, PR**

```bash
git add mcp/src/tools/graph.ts CLAUDE.md docs/superpowers/specs/2026-09-21-vendor-intel-graph-design.md
git commit -m "docs: competitive_position ranking contract and pointers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin feature/vendor-ranking
gh pr create --base feature/watchlist-evidence-graph --title "feat: win-likelihood ranking per account segment" --body-file /tmp/claude-rank/pr.md
```

Write `/tmp/claude-rank/pr.md` first: What (triggers, regimes, top-3 ranking, chat lines, contract change), test totals, the dry-run and probe results, rulings, and the final line `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Retarget to `main` once #64 and #65 merge.
