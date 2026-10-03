# Install-base History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Who held each account segment before, and when: dated incumbents in the accounts file, 27B-proposed changes from news that the user approves, merged by the rebuild into dated `USES` edges, shown by `competitive_position` and the chat as recent changes (or the full history when asked).

**Architecture:** `graph-accounts.ts` parses dated entries into `Account.history` (every stint) while `Account.incumbents` keeps meaning "current", so incumbency logic is untouched. `install-history.ts` owns the proposals file and the merge rules (`applyHistory`); the rebuild applies approved entries to each account before turning it into graph facts and stores conflicts on the Account node. The resolver derives `history` per segment (18-month window or full); the answer, chat, route and MCP pass the mode through. `install-history-extract.ts` + a CLI produce proposals from watchlist items and archive news.

**Tech Stack:** TypeScript ESM (Node16, strict), Jest (ESM), `yaml`, `node:crypto`, neo4j-driver, zod (MCP).

**Spec:** `docs/superpowers/specs/2026-10-03-install-history-design.md`

**Worktree:** `.worktrees/install-history`, branch `feature/install-history`, stacked on PR #67. Run every command from the worktree root.

## Global Constraints

- Tests never touch live services, never call the 27B, never read the real `config/`, `knowledge/`, `data/`. No `any`. Interfaces for object shapes. Siblings imported as `./x.js`.
- `npm run typecheck` after every code change; `npm run typecheck:tests` before each commit; `npm --prefix mcp run typecheck` after MCP changes.
- Commit prefixes `feat:` `fix:` `refactor:` `test:` `docs:`; every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Dates in the accounts file: `YYYY`, `YYYY-MM` or `YYYY-MM-DD` (`DATE_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/`). A stint is `{vendor, since, until, source}`; `since`/`until` are `""` when unknown; `until: ""` means **current**; `until: "?"` means **past, end unknown** (only from news); `source` is `"declared"` or `"news:<source>"`.
- `USES` edges: `{segment, since, until, source}`; `EDGE_IDENTITY.USES = ["segment", "since", "until"]`.
- Proposals file: `config/install-history.local.yaml` (gitignored); ids `ih-` + 10 hex of sha256(account, segment, vendor, change, whitespace-normalised quote); quote verbatim and ≥ 6 words; the date is the item's own date (`YYYY-MM-DD`).
- Recent window: `HISTORY_RECENT_MONTHS = 18`; modes `"recent"` (default) | `"full"`.
- Chat full-history wording: `/\b(history|over time|previously|before|used to|since when|who had)\b/i`.
- Chat lines: recent `    changed: <stints> · +N older`, full `    history: <stints>`; a stint renders as `<vendor> <since or ?>–<until | now> (<source>)`.
- Real 27B calls, edits to the user's `config/accounts.local.yaml`, and live rebuilds happen **only after the user's yes** (Task 7).

## Review Focus

1. **Today's accounts file (plain lists, no dates)** must parse to exactly the same incumbents, graph facts (plus empty dates) and answers as before. Pinned in Tasks 1 and 4.
2. **A vendor that held a segment, lost it and won it back** (two stints, same vendor, same segment) stays two edges and two history rows. Pinned in Tasks 1 and 4.
3. **A news proposal contradicting the accounts file** (news: Dell left; file: Dell current) never changes incumbency and always reaches the answer as a note. Pinned in Tasks 2, 3 and 4.
4. **An entry only in news, with no end** ("Novartis installed Pure in 2024", absent from the file) must not become a current incumbent. Pinned in Task 2 (`until: "?"`) and Task 4 (current = `until === ""`).
5. **A graph built before this change** (USES without dates) answers as today: every edge current, no history. Pinned in Task 4.

---

### Task 1: Dated incumbents in the accounts file

**Files:**
- Modify: `src/services/graph-accounts.ts` (`Account`, `parseAccounts`, `accountToGraphFacts`)
- Modify: `src/services/graph-schema.ts` (`EDGE_IDENTITY.USES`)
- Modify: `config/accounts.example.yaml`
- Modify: `__tests__/need-evidence.test.ts`, `__tests__/need-evidence-extract.test.ts` (Account fixtures gain `history: {}`)
- Test: `__tests__/graph-accounts.test.ts`

**Interfaces:**
- Produces:
  - `interface Stint { vendor: string; since: string; until: string; source: string }`
  - `Account.history: Partial<Record<Segment, Stint[]>>` (every stint, current included); `Account.incumbents` = current vendors (`until === ""`), deduped, in file order; `Account.conflicts?: string[]` (set by Task 3)
  - `parseAccounts(yaml: string, now?: Date): Account[]`
  - USES properties `{segment, since, until, source}`; Account property `historyConflicts` (JSON array) when `conflicts` is non-empty

- [ ] **Step 1: Write the failing tests**

In `__tests__/graph-accounts.test.ts`, inside `describe("parseAccounts", …)`:

```ts
  const NOW = new Date("2026-10-03T00:00:00Z");
  const dated = (entries: string) =>
    yaml(`  novartis:
    name: Novartis
    needs: []
    incumbents:
      storage-block:
${entries}`);

  it("reads dated and plain entries; only entries without until are current", () => {
    const account = parseAccounts(
      dated(`        - {vendor: hds, since: 2026-03}
        - {vendor: dell, since: 2019, until: 2026-03}
        - netapp
`),
      NOW,
    )[0];
    expect(account.incumbents).toEqual({ "storage-block": ["hds", "netapp"] });
    expect(account.history["storage-block"]).toEqual([
      { vendor: "hds", since: "2026-03", until: "", source: "declared" },
      { vendor: "dell", since: "2019", until: "2026-03", source: "declared" },
      { vendor: "netapp", since: "", until: "", source: "declared" },
    ]);
  });

  it("keeps two stints of the same vendor apart", () => {
    const account = parseAccounts(
      dated(`        - {vendor: dell, since: 2024-06}
        - {vendor: dell, since: 2015, until: 2021}
        - {vendor: hpe, since: 2021, until: 2024-06}
`),
      NOW,
    )[0];
    expect(account.incumbents["storage-block"]).toEqual(["dell"]);
    expect(account.history["storage-block"]).toHaveLength(3);
  });

  it("reads a segment whose entries are all past as declared empty, with history", () => {
    const account = parseAccounts(dated("        - {vendor: dell, until: 2025}\n"), NOW)[0];
    expect(account.incumbents).toEqual({ "storage-block": [] });
    expect(account.history["storage-block"]).toEqual([{ vendor: "dell", since: "", until: "2025", source: "declared" }]);
  });

  it("refuses a malformed date, since after until, a future until, an unknown key and a missing vendor", () => {
    const at = "novartis: incumbents.storage-block";
    expect(() => parseAccounts(dated("        - {vendor: dell, since: March 2026}\n"), NOW)).toThrow(
      `${at}: since "March 2026" must be YYYY, YYYY-MM or YYYY-MM-DD`,
    );
    expect(() => parseAccounts(dated("        - {vendor: dell, since: 2026-05, until: 2026-03}\n"), NOW)).toThrow(
      `${at}: dell since 2026-05 is after until 2026-03`,
    );
    expect(() => parseAccounts(dated("        - {vendor: dell, until: 2027-01}\n"), NOW)).toThrow(
      `${at}: dell until 2027-01 is in the future — an announced end date belongs in triggers`,
    );
    expect(() => parseAccounts(dated("        - {vendor: dell, from: 2020}\n"), NOW)).toThrow(`${at}: unknown key "from"`);
    expect(() => parseAccounts(dated("        - {since: 2020}\n"), NOW)).toThrow(`${at}: an entry needs a vendor`);
  });

  it("still requires a current incumbent for a trigger", () => {
    const yamlText = yaml(`  novartis:
    name: Novartis
    needs: []
    incumbents:
      storage-block:
        - {vendor: dell, until: 2025}
    triggers:
      storage-block: "end of support"
`);
    expect(() => parseAccounts(yamlText, NOW)).toThrow("opens a segment held by a rival; declare its incumbents first");
  });
```

In the `accountToGraphFacts` describe, add:

```ts
  it("writes one dated USES edge per stint, past ones included, and stores conflicts", () => {
    const account = parseAccounts(
      yaml(`  novartis:
    name: Novartis
    needs: []
    incumbents:
      storage-block:
        - {vendor: hds, since: 2026-03}
        - {vendor: dell, since: 2019, until: 2026-03}
`),
      new Date("2026-10-03T00:00:00Z"),
    )[0];
    const facts = accountToGraphFacts({ ...account, conflicts: ["approved news says x"] });
    expect(facts.relationships.filter((r) => r.type === "USES").map((r) => [r.to, r.properties])).toEqual([
      ["hds", { segment: "storage-block", since: "2026-03", until: "", source: "declared" }],
      ["dell", { segment: "storage-block", since: "2019", until: "2026-03", source: "declared" }],
    ]);
    expect(facts.nodes.find((n) => n.label === "Account")?.properties.historyConflicts).toBe(JSON.stringify(["approved news says x"]));
    expect(facts.nodes.filter((n) => n.label === "Vendor").map((n) => n.id).sort()).toEqual(["dell", "hds"]);
  });

  it("keeps today's plain lists as current edges with empty dates", () => {
    const facts = accountToGraphFacts(parseAccounts(roche)[0]);
    expect(facts.relationships.filter((r) => r.type === "USES").map((r) => r.properties)).toContainEqual({
      segment: "storage-file",
      since: "",
      until: "",
      source: "declared",
    });
  });
```

In the example-file describe, add:

```ts
  it("shows a dated change of hands", () => {
    const novartis = parseAccounts(readFileSync("config/accounts.example.yaml", "utf8")).find((a) => a.id === "novartis");
    expect(novartis?.history["storage-block"]?.some((s) => s.until !== "")).toBe(true);
  });
```

In `__tests__/need-evidence.test.ts` and `__tests__/need-evidence-extract.test.ts`, add `history: {},` to the `roche: Account` fixture after `incumbents: {},`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- __tests__/graph-accounts.test.ts`
Expected: FAIL (`history` undefined; dated entries rejected as non-strings or mis-parsed).

- [ ] **Step 3: Implement**

In `src/services/graph-schema.ts`, change `USES: ["segment"],` to:

```ts
  // Dates in the identity: two stints of one vendor in one segment stay two edges.
  USES: ["segment", "since", "until"],
```

In `src/services/graph-accounts.ts`, add before `export interface Account`:

```ts
/**
 * One vendor's time in one segment. since/until are YYYY, YYYY-MM or
 * YYYY-MM-DD, or "" when unknown; until "" means current; until "?" means a
 * past stint whose end is unknown (only news produces it, install-history.ts).
 */
export interface Stint {
  vendor: string;
  since: string;
  until: string;
  /** "declared" (the accounts file) or "news:<source>" (an approved proposal). */
  source: string;
}

const DATE_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

/** Earliest or latest day a partial date can mean: 2026 -> 2026-01-01 / 2026-12-31. */
export function boundOf(date: string, end: "low" | "high"): string {
  const [y, m, d] = date.split("-");
  const month = m ?? (end === "low" ? "01" : "12");
  const day = d ?? (end === "low" ? "01" : String(new Date(Date.UTC(Number(y), Number(month), 0)).getUTCDate()).padStart(2, "0"));
  return `${y}-${month}-${day}`;
}

function parseStint(entry: unknown, where: string, now: Date): Stint {
  if (typeof entry === "string") return { vendor: entry, since: "", until: "", source: "declared" };
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`${where}: an entry is a vendor name or {vendor, since, until}`);
  }
  const raw = entry as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!["vendor", "since", "until"].includes(key)) throw new Error(`${where}: unknown key "${key}"`);
  }
  if (typeof raw.vendor !== "string" || raw.vendor.trim() === "") throw new Error(`${where}: an entry needs a vendor`);
  const date = (key: "since" | "until"): string => {
    if (raw[key] === undefined || raw[key] === null) return "";
    const value = String(raw[key]);
    if (!DATE_RE.test(value)) throw new Error(`${where}: ${key} "${value}" must be YYYY, YYYY-MM or YYYY-MM-DD`);
    return value;
  };
  const vendor = raw.vendor.trim();
  const since = date("since");
  const until = date("until");
  if (since !== "" && until !== "" && boundOf(since, "low") > boundOf(until, "high")) {
    throw new Error(`${where}: ${vendor} since ${since} is after until ${until}`);
  }
  if (until !== "" && boundOf(until, "low") > now.toISOString().slice(0, 10)) {
    throw new Error(`${where}: ${vendor} until ${until} is in the future — an announced end date belongs in triggers`);
  }
  return { vendor, since, until, source: "declared" };
}
```

In `Account`, change the `incumbents` doc to `/** Vendors installed now, per segment (stints without until). Several per segment is normal. */` and add after it:

```ts
  /** Every stint per segment, current ones included, in file order. */
  history: Partial<Record<Segment, Stint[]>>;
  /** Approved news that contradicts the file (install-history.ts); stored on the Account node. */
  conflicts?: string[];
```

Change `parseAccounts`'s signature to `export function parseAccounts(yaml: string, now: Date = new Date()): Account[] {` and replace the incumbents loop body after the `Array.isArray` check:

```ts
      const stints = vendors.map((entry) => parseStint(entry, `${id}: incumbents.${key}`, now));
      history[key] = stints;
      incumbents[key] = [...new Set(stints.filter((s) => s.until === "").map((s) => s.vendor))];
```

declaring `const history: Partial<Record<Segment, Stint[]>> = {};` next to `const incumbents`, and adding `history,` after `incumbents,` in the returned object.

In `accountToGraphFacts`, replace the vendors loop with:

```ts
  const stints = Object.entries(account.history) as Array<[Segment, Stint[] | undefined]>;
  for (const [, list] of stints) for (const s of list ?? []) vendors.add(s.vendor);
```

add to the Account node properties after the `triggers` spread:

```ts
        ...(account.conflicts !== undefined && account.conflicts.length > 0
          ? { historyConflicts: JSON.stringify(account.conflicts) }
          : {}),
```

and replace the USES relationships block (`...Object.entries(account.incumbents).flatMap(…)`) with:

```ts
    ...stints.flatMap(([segment, list]) =>
      (list ?? []).map((s): GraphRelationship => ({
        type: "USES",
        from: account.id,
        to: s.vendor,
        // Incumbency is per segment, never per account; past stints are kept
        // so the graph remembers who held the segment before.
        properties: { segment, since: s.since, until: s.until, source: s.source },
      })),
    ),
```

In `config/accounts.example.yaml`, in the `novartis` account, replace `      storage-block: [dell]` with:

```yaml
      # Dated entries record history: only entries without `until` are current.
      # Dates may be YYYY, YYYY-MM or YYYY-MM-DD.
      storage-block:
        - {vendor: hds, since: 2026-03}
        - {vendor: dell, since: 2019, until: 2026-03}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -- __tests__/graph-accounts.test.ts __tests__/vendor-graph-rebuild.test.ts __tests__/need-evidence.test.ts __tests__/need-evidence-extract.test.ts && npm run typecheck && npm run typecheck:tests`
Expected: PASS. Existing tests asserting USES counts or `declaredSegments` still pass; update any test that pins USES `properties` exactly as `{ segment }` to the new four-field shape.

- [ ] **Step 5: Commit**

```bash
git add src/services/graph-accounts.ts src/services/graph-schema.ts config/accounts.example.yaml __tests__/graph-accounts.test.ts __tests__/need-evidence.test.ts __tests__/need-evidence-extract.test.ts
git commit -m "feat: dated incumbents in the accounts file, kept as dated USES edges

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `install-history.ts`, the proposals file and the merge rules

**Files:**
- Create: `src/services/install-history.ts`
- Test: `__tests__/install-history.test.ts`

**Interfaces:**
- Consumes (Task 1): `Account`, `Stint`, `boundOf`; `SEGMENTS` (`graph-schema.ts`); `normaliseSpace` (`need-evidence.ts`).
- Produces:
  - `INSTALL_HISTORY_FILE = "config/install-history.local.yaml"`
  - `type Change = "installed" | "replaced" | "removed"`
  - `interface HistoryEntry { id: string; status: "proposed" | "approved" | "rejected"; account: string; segment: string; vendor: string; change: Change; replaced_vendor?: string; date: string; quote: string; source: string; extracted: string }`
  - `interface InstallHistoryFile { sources: Record<string, string>; entries: HistoryEntry[] }`
  - `historyEntryId(account, segment, vendor, change, quote): string`
  - `parseInstallHistory(yaml: string): InstallHistoryFile`, `renderInstallHistory(file): string`, `mergeInstallHistory(onDisk, fromRun): InstallHistoryFile`
  - `checkHistoryAgainstAccounts(file, accounts: Account[]): void`
  - `applyHistory(account: Account, entries: HistoryEntry[]): Account` (approved entries for that account only; returns a new Account with merged `history` and `conflicts`)

- [ ] **Step 1: Write the failing tests**

Create `__tests__/install-history.test.ts`:

```ts
import { describe, expect, it } from "@jest/globals";
import type { Account } from "../src/services/graph-accounts.js";
import {
  applyHistory,
  checkHistoryAgainstAccounts,
  historyEntryId,
  mergeInstallHistory,
  parseInstallHistory,
  renderInstallHistory,
  type HistoryEntry,
  type InstallHistoryFile,
} from "../src/services/install-history.js";

function entry(over: Partial<HistoryEntry> & { id: string }): HistoryEntry {
  return {
    status: "approved",
    account: "novartis",
    segment: "storage-block",
    vendor: "hds",
    change: "installed",
    date: "2026-03-12",
    quote: "Novartis has deployed Hitachi Vantara storage across its EU sites.",
    source: "https://news.test/a",
    extracted: "2026-10-03",
    ...over,
  };
}

const file = (entries: HistoryEntry[]): InstallHistoryFile => ({ sources: {}, entries });

function account(stints: Account["history"]): Account {
  const incumbents: Account["incumbents"] = {};
  for (const [segment, list] of Object.entries(stints)) {
    incumbents[segment as keyof Account["incumbents"]] = (list ?? []).filter((s) => s.until === "").map((s) => s.vendor);
  }
  return { id: "novartis", name: "Novartis", aliases: [], needs: [], incumbents, history: stints, triggers: {}, notes: "" };
}

const declared = (vendor: string, since = "", until = "") => ({ vendor, since, until, source: "declared" });

describe("historyEntryId / file", () => {
  it("is stable and whitespace-insensitive", () => {
    const id = historyEntryId("novartis", "storage-block", "hds", "installed", "Novartis has\n deployed it.");
    expect(id).toMatch(/^ih-[0-9a-f]{10}$/);
    expect(historyEntryId("novartis", "storage-block", "hds", "installed", "Novartis has deployed it.")).toBe(id);
  });

  it("round-trips, and refuses a bad change, a bad segment, a bad date or a missing replaced_vendor", () => {
    const f = file([entry({ id: "ih-1" }), entry({ id: "ih-2", change: "replaced", replaced_vendor: "dell" })]);
    expect(parseInstallHistory(renderInstallHistory(f))).toEqual(f);
    const bad = (e: HistoryEntry) => () => parseInstallHistory(renderInstallHistory(file([e])));
    expect(bad(entry({ id: "ih-3", change: "moved" as HistoryEntry["change"] }))).toThrow("ih-3: change must be installed, replaced or removed");
    expect(bad(entry({ id: "ih-4", segment: "mainframe" }))).toThrow('ih-4: invalid segment "mainframe"');
    expect(bad(entry({ id: "ih-5", date: "March" }))).toThrow("ih-5: date must be YYYY-MM-DD");
    expect(bad(entry({ id: "ih-6", change: "replaced" }))).toThrow("ih-6: replaced_vendor is required exactly when change is replaced");
  });

  it("merges a run into the file on disk, keeping the user's decisions", () => {
    const onDisk = file([entry({ id: "ih-1", status: "approved" })]);
    const fromRun: InstallHistoryFile = { sources: { "https://news.test/b": "done" }, entries: [entry({ id: "ih-1", status: "proposed" }), entry({ id: "ih-2", status: "proposed" })] };
    const merged = mergeInstallHistory(onDisk, fromRun);
    expect(merged.entries.map((e) => [e.id, e.status])).toEqual([["ih-1", "approved"], ["ih-2", "proposed"]]);
    expect(merged.sources).toEqual({ "https://news.test/b": "done" });
  });
});

describe("checkHistoryAgainstAccounts", () => {
  it("refuses an approved entry for an unknown account, ignores pending ones", () => {
    expect(() => checkHistoryAgainstAccounts(file([entry({ id: "ih-1", account: "acme" })]), [account({})])).toThrow(
      'ih-1 names unknown account "acme"',
    );
    expect(() => checkHistoryAgainstAccounts(file([entry({ id: "ih-2", account: "acme", status: "proposed" })]), [account({})])).not.toThrow();
  });
});

describe("applyHistory", () => {
  it("fills a missing since on a current incumbent", () => {
    const merged = applyHistory(account({ "storage-block": [declared("hds")] }), [entry({ id: "ih-1" })]);
    expect(merged.history["storage-block"]).toEqual([declared("hds", "2026-03-12")]);
    expect(merged.conflicts).toEqual([]);
  });

  it("adds a past stint, end unknown, for a vendor installed in the news but not current in the file", () => {
    const merged = applyHistory(account({ "storage-block": [declared("dell")] }), [entry({ id: "ih-1", vendor: "pure" })]);
    expect(merged.history["storage-block"]).toContainEqual({ vendor: "pure", since: "2026-03-12", until: "?", source: "news:https://news.test/a" });
    expect(merged.incumbents["storage-block"]).toEqual(["dell"]);
  });

  it("records the replaced vendor's end and the new vendor's start", () => {
    const merged = applyHistory(account({ "storage-block": [declared("hds")] }), [
      entry({ id: "ih-1", change: "replaced", replaced_vendor: "dell" }),
    ]);
    expect(merged.history["storage-block"]).toEqual([
      declared("hds", "2026-03-12"),
      { vendor: "dell", since: "", until: "2026-03-12", source: "news:https://news.test/a" },
    ]);
  });

  it("never overrides the file: news saying a current vendor left becomes a conflict", () => {
    const merged = applyHistory(account({ "storage-block": [declared("dell")] }), [
      entry({ id: "ih-1", change: "removed", vendor: "dell" }),
    ]);
    expect(merged.incumbents["storage-block"]).toEqual(["dell"]);
    expect(merged.history["storage-block"]).toEqual([declared("dell")]);
    expect(merged.conflicts).toEqual([
      "approved news says dell left storage-block on 2026-03-12; accounts.local.yaml still lists it as current",
    ]);
  });

  it("ignores pending entries and other accounts", () => {
    const base = account({ "storage-block": [declared("hds")] });
    const merged = applyHistory(base, [entry({ id: "ih-1", status: "proposed" }), entry({ id: "ih-2", account: "roche" })]);
    expect(merged.history).toEqual(base.history);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- __tests__/install-history.test.ts`
Expected: FAIL with `Could not locate module ../src/services/install-history.js`.

- [ ] **Step 3: Implement `src/services/install-history.ts`**

```ts
// Install-base changes proposed from news (install-history-extract.ts) and
// approved by the user in config/install-history.local.yaml, merged into an
// account's stints at rebuild (spec 2026-10-03-install-history-design.md).
//
// The accounts file is the truth for now; approved news only adds the past.
// A contradiction never overrides the file: it becomes a conflict note.
import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import type { Account, Stint } from "./graph-accounts.js";
import { SEGMENTS, type Segment } from "./graph-schema.js";
import { normaliseSpace } from "./need-evidence.js";

export const INSTALL_HISTORY_FILE = "config/install-history.local.yaml";

const CHANGES = ["installed", "replaced", "removed"] as const;
export type Change = (typeof CHANGES)[number];
const STATUSES = ["proposed", "approved", "rejected"] as const;

export interface HistoryEntry {
  id: string;
  status: (typeof STATUSES)[number];
  account: string;
  segment: string;
  vendor: string;
  change: Change;
  replaced_vendor?: string;
  /** The news item's own date, YYYY-MM-DD: never the model's. */
  date: string;
  quote: string;
  source: string;
  extracted: string;
}

export interface InstallHistoryFile {
  /** Processed item -> "done", so a re-run skips it. */
  sources: Record<string, string>;
  entries: HistoryEntry[];
}

const HEADER = `# Written by scripts/extract-install-history.ts. Change status to approved or
# rejected; approved entries add history at the next graph rebuild. The accounts
# file stays the truth for who is installed now.
`;

export function historyEntryId(account: string, segment: string, vendor: string, change: string, quote: string): string {
  const key = `${account}\n${segment}\n${vendor}\n${change}\n${normaliseSpace(quote)}`;
  return `ih-${createHash("sha256").update(key).digest("hex").slice(0, 10)}`;
}

const text = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));

export function parseInstallHistory(yaml: string): InstallHistoryFile {
  const doc = (parse(yaml) ?? {}) as { sources?: unknown; entries?: unknown };
  const sources: Record<string, string> = {};
  if (doc.sources !== null && typeof doc.sources === "object" && !Array.isArray(doc.sources)) {
    for (const [k, v] of Object.entries(doc.sources as Record<string, unknown>)) sources[k] = text(v);
  }
  const seen = new Set<string>();
  const entries = (Array.isArray(doc.entries) ? doc.entries : []).map((raw): HistoryEntry => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const id = text(r.id);
    if (seen.has(id)) throw new Error(`duplicate id ${id}`);
    seen.add(id);
    const status = text(r.status);
    if (!(STATUSES as readonly string[]).includes(status)) throw new Error(`${id}: status must be proposed, approved or rejected`);
    const change = text(r.change);
    if (!(CHANGES as readonly string[]).includes(change)) throw new Error(`${id}: change must be installed, replaced or removed`);
    const segment = text(r.segment);
    if (!(SEGMENTS as readonly string[]).includes(segment)) throw new Error(`${id}: invalid segment "${segment}"`);
    const date = text(r.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${id}: date must be YYYY-MM-DD`);
    const replaced = text(r.replaced_vendor);
    if ((change === "replaced") !== (replaced !== "")) {
      throw new Error(`${id}: replaced_vendor is required exactly when change is replaced`);
    }
    return {
      id,
      status: status as HistoryEntry["status"],
      account: text(r.account),
      segment,
      vendor: text(r.vendor),
      change: change as Change,
      ...(replaced !== "" ? { replaced_vendor: replaced } : {}),
      date,
      quote: text(r.quote).trim(),
      source: text(r.source),
      extracted: text(r.extracted),
    };
  });
  return { sources, entries };
}

export function renderInstallHistory(file: InstallHistoryFile): string {
  return HEADER + stringify({ sources: file.sources, entries: file.entries }, { lineWidth: 0 });
}

/** A run's result folded into the file as it is on disk now: the user's entries win. */
export function mergeInstallHistory(onDisk: InstallHistoryFile, fromRun: InstallHistoryFile): InstallHistoryFile {
  const known = new Set(onDisk.entries.map((e) => e.id));
  return {
    sources: { ...onDisk.sources, ...fromRun.sources },
    entries: [...onDisk.entries.map((e) => ({ ...e })), ...fromRun.entries.filter((e) => !known.has(e.id))],
  };
}

export function checkHistoryAgainstAccounts(file: InstallHistoryFile, accounts: Account[]): void {
  const ids = new Set(accounts.map((a) => a.id));
  for (const e of file.entries) {
    if (e.status === "approved" && !ids.has(e.account)) throw new Error(`${e.id} names unknown account "${e.account}"`);
  }
}

/** Approved entries for this account, oldest first, applied to its stints. */
export function applyHistory(account: Account, entries: HistoryEntry[]): Account {
  const history: Account["history"] = {};
  for (const [segment, list] of Object.entries(account.history)) history[segment as Segment] = (list ?? []).map((s) => ({ ...s }));
  const conflicts: string[] = [...(account.conflicts ?? [])];

  const approved = entries
    .filter((e) => e.status === "approved" && e.account === account.id)
    .sort((a, b) => a.date.localeCompare(b.date));

  for (const e of approved) {
    const segment = e.segment as Segment;
    const stints = (history[segment] ??= []);
    const source = `news:${e.source}`;
    const current = (vendor: string) => stints.find((s) => s.vendor === vendor && s.until === "");

    const ended = (vendor: string): void => {
      if (current(vendor) !== undefined) {
        conflicts.push(
          `approved news says ${vendor} left ${segment} on ${e.date}; accounts.local.yaml still lists it as current`,
        );
        return;
      }
      const open = stints.find((s) => s.vendor === vendor && s.until === "?");
      if (open !== undefined) open.until = e.date;
      else if (!stints.some((s) => s.vendor === vendor && s.until === e.date)) {
        stints.push({ vendor, since: "", until: e.date, source });
      }
    };

    const installed = (vendor: string): void => {
      const now = current(vendor);
      if (now !== undefined) {
        if (now.since === "") now.since = e.date;
        return;
      }
      // Not current in the file: a past stint whose end the news does not say.
      if (!stints.some((s) => s.vendor === vendor && s.since === e.date)) {
        stints.push({ vendor, since: e.date, until: "?", source } satisfies Stint);
      }
    };

    if (e.change === "installed") installed(e.vendor);
    else if (e.change === "removed") ended(e.vendor);
    else {
      ended(e.replaced_vendor ?? "");
      installed(e.vendor);
    }
  }

  return { ...account, history, conflicts };
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -- __tests__/install-history.test.ts && npm run typecheck && npm run typecheck:tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/install-history.ts __tests__/install-history.test.ts
git commit -m "feat: install-history proposals file and merge rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The rebuild applies approved history

**Files:**
- Modify: `src/services/vendor-graph-rebuild.ts`
- Test: `__tests__/vendor-graph-rebuild.test.ts`

**Interfaces:**
- Consumes (Task 2): `parseInstallHistory`, `checkHistoryAgainstAccounts`, `applyHistory`.
- Produces: report line `install-history.local.yaml   -> <a> approved, <p> proposed, <r> rejected, <c> conflicts` or `install-history.local.yaml   -> skipped (no such file)`.

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/vendor-graph-rebuild.test.ts`:

```ts
describe("collectVendorGraphFacts — install history", () => {
  const HISTORY = `entries:
  - id: ih-1
    status: approved
    account: roche
    segment: storage-block
    vendor: dell
    change: installed
    date: 2024-05-02
    quote: Roche has standardised its block storage on Dell PowerMax arrays.
    source: https://news.test/a
    extracted: 2026-10-03
  - id: ih-2
    status: approved
    account: roche
    segment: storage-block
    vendor: dell
    change: removed
    date: 2026-01-10
    quote: Roche retired its last Dell PowerMax arrays in January this year.
    source: https://news.test/b
    extracted: 2026-10-03
`;

  it("adds approved history to the accounts' USES edges, stores conflicts and reports the file", () => {
    const { batch, lines } = collectVendorGraphFacts(files({ ...ALL, "/repo/config/install-history.local.yaml": HISTORY }));
    const uses = batch.flatMap((f) => f.relationships.filter((r) => r.type === "USES"));
    expect(uses.map((r) => r.properties)).toContainEqual({ segment: "storage-block", since: "2024-05-02", until: "", source: "declared" });
    const account = batch.flatMap((f) => f.nodes).find((n) => n.label === "Account");
    expect(JSON.parse(String(account?.properties.historyConflicts))).toEqual([
      "approved news says dell left storage-block on 2026-01-10; accounts.local.yaml still lists it as current",
    ]);
    expect(lines).toContain("install-history.local.yaml   -> 2 approved, 0 proposed, 0 rejected, 1 conflicts");
  });

  it("skips and reports a missing file", () => {
    expect(collectVendorGraphFacts(files(ALL)).lines).toContain("install-history.local.yaml   -> skipped (no such file)");
  });

  it("fails before the wipe on an approved entry for an unknown account", async () => {
    const rec = recordingTransaction();
    const bad = HISTORY.replace("account: roche", "account: acme");
    await expect(rebuildVendorGraph(files({ ...ALL, "/repo/config/install-history.local.yaml": bad }), rec.tx)).rejects.toThrow(
      'install-history.local.yaml: ih-1 names unknown account "acme"',
    );
    expect(rec.calls).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- __tests__/vendor-graph-rebuild.test.ts -t "install history"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/services/vendor-graph-rebuild.ts`, add the import:

```ts
import { applyHistory, checkHistoryAgainstAccounts, parseInstallHistory, type HistoryEntry } from "./install-history.js";
```

Inside `collectVendorGraphFacts`, before the accounts `batch.push(` (and after `let accounts: Account[] = [];`), read the history file through the same missing/invalid rules:

```ts
  // Approved install-base changes from news, applied to each account before it
  // becomes graph facts. Read first: the accounts source below needs them.
  let historyEntries: HistoryEntry[] = [];
  let historyLine: string | null = null;
  const historyFile = optionalSource(
    "install-history.local.yaml",
    join(sources.root, "config", "install-history.local.yaml"),
    readFile,
    lines,
    (text) => [parseInstallHistory(text)],
  )[0];
  if (historyFile !== undefined) historyEntries = historyFile.entries;
```

`optionalSource` is typed for `GraphFacts[]`; make it generic so this compiles — change its signature to:

```ts
function optionalSource<T>(
  name: string,
  path: string,
  readFile: (path: string) => string,
  lines: string[],
  toFacts: (text: string) => T[],
): T[] {
```

(the body is unchanged). In the accounts callback, replace `(accounts = parseAccounts(text)).map((account) => {` and the following `const facts = accountToGraphFacts(account);` with:

```ts
      (accounts = parseAccounts(text)).map((parsed) => {
        const account = applyHistory(parsed, historyEntries);
        const facts = accountToGraphFacts(account);
```

and, right after that accounts `batch.push(…)` closes, add:

```ts
  if (historyFile !== undefined) {
    // Validated against the accounts file, and before the wipe like every source.
    try {
      checkHistoryAgainstAccounts(historyFile, accounts);
    } catch (err) {
      throw new Error(`install-history.local.yaml: ${(err as Error).message}`);
    }
    const count = (s: string) => historyFile.entries.filter((e) => e.status === s).length;
    const conflicts = accounts.reduce((n, a) => n + applyHistory(a, historyEntries).conflicts!.length, 0);
    historyLine =
      `${"install-history.local.yaml".padEnd(28)} -> ${count("approved")} approved, ${count("proposed")} proposed, ` +
      `${count("rejected")} rejected, ${conflicts} conflicts`;
    lines.push(historyLine);
  }
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -- __tests__/vendor-graph-rebuild.test.ts __tests__/watchlist-cli.test.ts && npm run typecheck && npm run typecheck:tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/vendor-graph-rebuild.ts __tests__/vendor-graph-rebuild.test.ts
git commit -m "feat: graph rebuild applies approved install history; conflicts stored on the account

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Snapshot and resolver: current vs history, recent or full

**Files:**
- Modify: `src/services/competitive-position.ts`
- Modify: `src/services/competitive-graph.ts` (`ACCOUNTS_CYPHER`, `uses()`, `readGraphSnapshot`, `competitivePositionFrom`)
- Test: `__tests__/competitive-position.test.ts`, `__tests__/competitive-graph.test.ts`

**Interfaces:**
- Consumes (Tasks 1, 3): USES `{since, until, source}`; Account `historyConflicts`.
- Produces:
  - `SnapshotAccount.uses: Array<{segment; vendor; since?: string; until?: string; source?: string}>`, `SnapshotAccount.historyConflicts?: string[]`
  - `CompetitiveQuery.history?: "recent" | "full"`; resolution `query.history: "recent" | "full"`
  - `HISTORY_RECENT_MONTHS = 18`; `interface HistoryStint { vendor; since; until; source }`
  - `SegmentView.history?: HistoryStint[]` (newest first; absent when empty), `SegmentView.olderChanges?: number` (recent mode, absent when 0)
  - `resolveCompetitivePosition(snap, query, now?: Date)`

- [ ] **Step 1: Write the failing tests**

In `__tests__/competitive-position.test.ts`, add:

```ts
describe("resolveCompetitivePosition — install history", () => {
  const NOW = new Date("2026-10-03T00:00:00Z");
  const base = snapshot();
  const withUses = (uses: GraphSnapshot["accounts"][number]["uses"], extra: Partial<GraphSnapshot["accounts"][number]> = {}) =>
    snapshot({ accounts: [{ ...base.accounts[0], uses, ...extra }] });
  const seg = (snap: GraphSnapshot, query: Parameters<typeof resolveCompetitivePosition>[1] = { account: "roche", segment: "storage-block" }) =>
    ok(resolveCompetitivePosition(snap, query, NOW)).accounts[0].segments[0];

  it("counts only stints without until as incumbents", () => {
    const s = seg(withUses([
      { segment: "storage-block", vendor: "hds", since: "2026-03", until: "", source: "declared" },
      { segment: "storage-block", vendor: "dell", since: "2019", until: "2026-03", source: "declared" },
    ]));
    expect(s.incumbents).toEqual(["hds"]);
  });

  it("shows changes from the last 18 months newest first, and counts the older ones", () => {
    const s = seg(withUses([
      { segment: "storage-block", vendor: "hds", since: "2026-03", until: "", source: "declared" },
      { segment: "storage-block", vendor: "dell", since: "2019", until: "2026-03", source: "declared" },
      { segment: "storage-block", vendor: "ibm", since: "2010", until: "2019", source: "news:https://n.test" },
    ]));
    expect(s.history?.map((h) => h.vendor)).toEqual(["hds", "dell"]);
    expect(s.olderChanges).toBe(1);
  });

  it("lists every stint, undated current ones included, in full mode", () => {
    const s = seg(
      withUses([
        { segment: "storage-block", vendor: "netapp", since: "", until: "", source: "declared" },
        { segment: "storage-block", vendor: "ibm", since: "2010", until: "2019", source: "news:https://n.test" },
      ]),
      { account: "roche", segment: "storage-block", history: "full" },
    );
    expect(s.history?.map((h) => h.vendor)).toEqual(["netapp", "ibm"]);
    expect(s.olderChanges).toBeUndefined();
  });

  it("answers a graph without dates as today: all current, no history", () => {
    const s = seg(withUses([{ segment: "storage-block", vendor: "dell" }]));
    expect(s.incumbents).toEqual(["dell"]);
    expect(s.history).toBeUndefined();
  });

  it("keeps two stints of one vendor as two history rows", () => {
    const s = seg(withUses([
      { segment: "storage-block", vendor: "dell", since: "2025-09", until: "", source: "declared" },
      { segment: "storage-block", vendor: "dell", since: "2015", until: "2025-06", source: "declared" },
    ]), { account: "roche", segment: "storage-block", history: "full" });
    expect(s.history).toHaveLength(2);
  });

  it("turns stored conflicts into notes", () => {
    const snap = withUses(base.accounts[0].uses, { historyConflicts: ["approved news says dell left storage-block on 2026-03-12; accounts.local.yaml still lists it as current"] });
    expect(ok(resolveCompetitivePosition(snap, { account: "roche" }, NOW)).notes).toContain(
      "approved news says dell left storage-block on 2026-03-12; accounts.local.yaml still lists it as current",
    );
  });
});
```

In `__tests__/competitive-graph.test.ts`, in the "turns rows into a snapshot…" expected account, change `uses: [{ segment: "storage-block", vendor: "dell" }]` to `uses: [{ segment: "storage-block", vendor: "dell", since: "", until: "", source: "declared" }]` and add `historyConflicts: [],` after `triggers: {},`. Add to `describe("readGraphSnapshot", …)`:

```ts
  it("reads dated uses and stored conflicts", async () => {
    const rows = {
      ...ROWS,
      accounts: [
        {
          ...ROWS.accounts[0],
          uses: [{ segment: "storage-block", vendor: "dell", since: "2019", until: "2026-03", source: "declared" }],
          historyConflicts: JSON.stringify(["x"]),
        },
      ],
    };
    const snap = await readGraphSnapshot(fakeCypher(rows), {});
    expect(snap.accounts[0].uses).toEqual([{ segment: "storage-block", vendor: "dell", since: "2019", until: "2026-03", source: "declared" }]);
    expect(snap.accounts[0].historyConflicts).toEqual(["x"]);
  });
```

In `__tests__/chat-graph-context.test.ts`, in the `answer()` fixture's `query`, add `history: "recent"` (the resolution query gains that field in this task).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- __tests__/competitive-position.test.ts __tests__/competitive-graph.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the resolver changes in `src/services/competitive-position.ts`**

Change `SnapshotAccount.uses` to:

```ts
  /** USES edges; since/until/source are absent on graphs built before history (all current). */
  uses: Array<{ segment: string; vendor: string; since?: string; until?: string; source?: string }>;
  /** Approved news that contradicts the accounts file (install-history.ts). */
  historyConflicts?: string[];
```

Add to `CompetitiveQuery`: `history?: "recent" | "full";`. In `CompetitiveResolution.query`, add `history: "recent" | "full";`.

Add after `REGIME_GUIDANCE`:

```ts
export const HISTORY_RECENT_MONTHS = 18;

export interface HistoryStint {
  vendor: string;
  since: string;
  until: string;
  source: string;
}

/** The latest day a stint's dates mention, for ordering and the recent window ("" when undated). */
function stintDay(s: HistoryStint): string {
  const dates = [s.since, s.until].filter((d) => d !== "" && d !== "?");
  return dates.map((d) => (d.length === 4 ? `${d}-12-31` : d.length === 7 ? `${d}-28` : d)).sort().pop() ?? "";
}
```

Add to `SegmentView`:

```ts
  /** Who held the segment, newest first: recent changes by default, every stint in full mode. */
  history?: HistoryStint[];
  /** Recent mode: dated stints older than the window, left out. */
  olderChanges?: number;
```

Change the resolver signature to `export function resolveCompetitivePosition(snap: GraphSnapshot, query: CompetitiveQuery, now: Date = new Date()): ResolveResult {`, and add near the top (after the input checks): `const historyMode = query.history ?? "recent";` and

```ts
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - HISTORY_RECENT_MONTHS);
  const cutoffDay = cutoff.toISOString().slice(0, 10);
```

Change the notes initialisation to also add conflicts for the accounts in scope — after `scope` is resolved add:

```ts
  for (const account of scope) for (const conflict of account.historyConflicts ?? []) notes.add(conflict);
```

Wherever the resolver reads `account.uses` for incumbency — the `inPlay` line and the `incumbents` line — filter to current edges with `(u.until ?? "") === ""`:

```ts
      if (vendor !== null) for (const use of account.uses) if (use.vendor === vendor && (use.until ?? "") === "") inPlay.add(use.segment);
```

```ts
      const incumbents = [
        ...new Set(account.uses.filter((u) => u.segment === seg && (u.until ?? "") === "").map((u) => u.vendor)),
      ].sort();
```

In the segment view, before the `return {`, compute history:

```ts
      const stints: HistoryStint[] = account.uses
        .filter((u) => u.segment === seg)
        .map((u) => ({ vendor: u.vendor, since: u.since ?? "", until: u.until ?? "", source: u.source ?? "declared" }))
        // Current stints first, then newest first; the name only keeps the output stable.
        .sort(
          (a, b) =>
            Number(b.until === "") - Number(a.until === "") ||
            stintDay(b).localeCompare(stintDay(a)) ||
            a.vendor.localeCompare(b.vendor),
        );
      const dated = stints.filter((s) => stintDay(s) !== "");
      const shown = historyMode === "full" ? stints : dated.filter((s) => stintDay(s) >= cutoffDay);
      const older = historyMode === "full" ? 0 : dated.length - shown.length;
```

and add to the returned segment object:

```ts
        ...(shown.length > 0 ? { history: shown } : {}),
        ...(older > 0 ? { olderChanges: older } : {}),
```

In the returned `query`, add `history: historyMode`.

- [ ] **Step 4: Implement the snapshot changes in `src/services/competitive-graph.ts`**

Change the `uses` collect in `ACCOUNTS_CYPHER` to include the dates and source, and return the conflicts:

```ts
  RETURN a.id AS id, a.name AS name, a.aliases AS aliases, a.declaredSegments AS declaredSegments,
         a.triggers AS triggers, a.historyConflicts AS historyConflicts, needs,
         collect(CASE WHEN v IS NULL THEN null ELSE {segment: u.segment, vendor: v.id, since: u.since, until: u.until,
                                                      source: u.source} END) AS uses
```

Replace `uses()`'s map body with:

```ts
    const row = (entry ?? {}) as Record<string, unknown>;
    return {
      segment: str(row.segment, `uses[${i}].segment`),
      vendor: str(row.vendor, `uses[${i}].vendor`),
      // Absent on graphs built before history: read as current and declared.
      since: typeof row.since === "string" ? row.since : "",
      until: typeof row.until === "string" ? row.until : "",
      source: typeof row.source === "string" && row.source !== "" ? row.source : "declared",
    };
```

In `readGraphSnapshot`'s account mapping, add after `triggers: …,`:

```ts
      historyConflicts: jsonStrings(r.historyConflicts),
```

with, below `triggers()`:

```ts
function jsonStrings(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
```

In `competitivePositionFrom`, pass `now` through: change its signature to add `now: Date = new Date()` as the last parameter and call `resolveCompetitivePosition(snapshot, query, now)`.

- [ ] **Step 5: Run the tests and typecheck**

Run: `npm test -- __tests__/competitive-position.test.ts __tests__/competitive-graph.test.ts __tests__/chat-graph-context.test.ts __tests__/graph-routes.test.ts && npm run typecheck && npm run typecheck:tests`
Expected: PASS (existing tests that build `uses` without dates still pass: absent dates read as current).

- [ ] **Step 6: Commit**

```bash
git add src/services/competitive-position.ts src/services/competitive-graph.ts __tests__/competitive-position.test.ts __tests__/competitive-graph.test.ts __tests__/chat-graph-context.test.ts
git commit -m "feat: competitive_position separates current incumbents from history, recent or full

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Budget, route, MCP and chat

**Files:**
- Modify: `src/services/competitive-graph.ts` (`TRIM_STEPS`)
- Modify: `src/api/graph.ts` (body `history`)
- Modify: `mcp/src/tools/graph.ts` (`history` parameter and description)
- Modify: `src/services/chat-graph-context.ts` (`wantsFullHistory`, history line)
- Test: `__tests__/competitive-graph.test.ts`, `__tests__/graph-routes.test.ts`, `__tests__/chat-graph-context.test.ts`

**Interfaces:**
- Consumes (Task 4): `SegmentView.history`, `olderChanges`, `CompetitiveQuery.history`, resolution `query.history`.
- Produces: trim steps "history beyond the newest change per segment" (after "claim details") and "history" (last); route 400 on a `history` that is not `"recent"`/`"full"`; `wantsFullHistory(message: string): boolean`.

- [ ] **Step 1: Write the failing tests**

In `__tests__/competitive-graph.test.ts` (size budget describe):

```ts
  it("trims history to the newest change per segment before claims", async () => {
    const rows: Rows = {
      ...ROWS,
      accounts: [
        {
          ...ROWS.accounts[0],
          uses: [
            { segment: "storage-block", vendor: "dell", since: "2026-03", until: "", source: "declared" },
            ...[1, 2, 3, 4].map((n) => ({ segment: "storage-block", vendor: `v${n}${"x".repeat(200)}`, since: "2025", until: "2026-02", source: "declared" })),
          ],
        },
      ],
    };
    const result = await competitivePosition(deps({ runCypher: fakeCypher(rows) }), { account: "roche", history: "full" });
    if (!result.ok) throw new Error(result.error);
    const answer = result.answer;
    fitBudget(answer, JSON.stringify(answer).length - 10);
    const block = answer.accounts[0].segments.find((s) => s.segment === "storage-block");
    expect(block?.history).toHaveLength(1);
    expect(answer.standings["dell/storage-block"].strong.length).toBeGreaterThan(0);
    expect(answer.notes.some((n) => n.includes("history beyond the newest change per segment"))).toBe(true);
  });
```

In `__tests__/graph-routes.test.ts`, in `describe("POST /api/graph/competitive-position", …)`:

```ts
  it("returns 400 for a history mode other than recent or full", async () => {
    const res = await post("/api/graph/competitive-position", { vendor: "dell", history: "all" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('history must be "recent" or "full" when given');
  });
```

(use the file's existing request helper; if it is named differently than `post`, call that helper the same way the neighbouring tests do.)

In `__tests__/chat-graph-context.test.ts`:

```ts
describe("install history in the chat", () => {
  it("asks for the full history only when the message is about the past", () => {
    expect(wantsFullHistory("Who had storage at Novartis before HDS?")).toBe(true);
    expect(wantsFullHistory("What changed over time at Roche?")).toBe(true);
    expect(wantsFullHistory("How is Dell placed at Roche?")).toBe(false);
  });

  it("prints recent changes under the installs, and the full history in full mode", () => {
    const base = answer();
    base.accounts[0].segments[0].history = [
      { vendor: "hds", since: "2026-03", until: "", source: "declared" },
      { vendor: "dell", since: "2019", until: "2026-03", source: "news:https://n.test" },
    ];
    base.accounts[0].segments[0].olderChanges = 2;
    expect(renderCompetitiveContext(base)).toContain(
      "    changed: hds 2026-03–now (declared) · dell 2019–2026-03 (news:https://n.test) · +2 older",
    );
    const full = answer();
    full.query = { ...full.query, history: "full" };
    full.accounts[0].segments[0].history = [{ vendor: "netapp", since: "", until: "", source: "declared" }];
    expect(renderCompetitiveContext(full)).toContain("    history: netapp ?–now (declared)");
  });
});
```

and add `wantsFullHistory` to the import from `chat-graph-context.js`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- __tests__/competitive-graph.test.ts __tests__/graph-routes.test.ts __tests__/chat-graph-context.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/services/competitive-graph.ts`: in `TRIM_STEPS`, insert after the "claim details" step:

```ts
  {
    drops: "history beyond the newest change per segment",
    applies: (a) => a.accounts.some((acc) => acc.segments.some((s) => (s.history?.length ?? 0) > 1)),
    apply: (a) => {
      for (const acc of a.accounts) for (const s of acc.segments) if (s.history !== undefined) s.history = s.history.slice(0, 1);
    },
  },
```

and append as the last step (after "sources"):

```ts
  {
    drops: "history",
    applies: (a) => a.accounts.some((acc) => acc.segments.some((s) => s.history !== undefined)),
    apply: (a) => {
      for (const acc of a.accounts) {
        for (const s of acc.segments) {
          delete s.history;
          delete s.olderChanges;
        }
      }
    },
  },
```

`src/api/graph.ts`: after the string check, add:

```ts
    if (body.history !== undefined && body.history !== "recent" && body.history !== "full") {
      res.status(400).json({ error: 'history must be "recent" or "full" when given' });
      return;
    }
```

and pass `history: body.history as "recent" | "full" | undefined,` in the `competitivePosition` query.

`mcp/src/tools/graph.ts`: add to `inputSchema`:

```ts
        history: z
          .enum(["recent", "full"])
          .optional()
          .describe("'full' when the user asks about past vendors, changes over time or who had a segment before; default 'recent' (last 18 months)"),
```

pass `history` in the handler (`async ({ vendor, account, segment, history }) => … client.post("/api/graph/competitive-position", { vendor, account, segment, history })`), and add to the description: `"Each segment also carries \`history\` (who held it, newest first: recent changes, or every stint with history: 'full'). " +`.

`src/services/chat-graph-context.ts`: add

```ts
const HISTORY_WORDING = /\b(history|over time|previously|before|used to|since when|who had)\b/i;

/** The chat asks for the full install history only when the message is about the past. */
export function wantsFullHistory(message: string): boolean {
  return HISTORY_WORDING.test(message);
}

function stintText(s: { vendor: string; since: string; until: string; source: string }): string {
  return `${s.vendor} ${s.since || "?"}–${s.until === "" ? "now" : s.until} (${s.source})`;
}
```

In `competitiveContext`, after `const query = matchCompetitiveQuery(message, snapshot); if (query === null) return null;`, add `if (wantsFullHistory(message)) query.history = "full";`. In `renderLines`, right after the `installed:` line push, add:

```ts
      if (s.history !== undefined && s.history.length > 0) {
        const label = a.query.history === "full" ? "history" : "changed";
        const older = s.olderChanges !== undefined ? ` · +${s.olderChanges} older` : "";
        lines.push(`    ${label}: ${s.history.map(stintText).join(" · ")}${older}`);
      }
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -- __tests__/competitive-graph.test.ts __tests__/graph-routes.test.ts __tests__/chat-graph-context.test.ts && npm run typecheck && npm run typecheck:tests && npm --prefix mcp test && npm --prefix mcp run typecheck`
Expected: PASS (existing fitBudget order tests still pass: the history steps are skipped without history).

- [ ] **Step 5: Commit**

```bash
git add src/services/competitive-graph.ts src/api/graph.ts mcp/src/tools/graph.ts src/services/chat-graph-context.ts __tests__/competitive-graph.test.ts __tests__/graph-routes.test.ts __tests__/chat-graph-context.test.ts
git commit -m "feat: history in the answer budget, route, MCP and chat

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `install-history-extract.ts` and the CLI

**Files:**
- Create: `src/services/install-history-extract.ts`, `scripts/extract-install-history.ts`
- Modify: `.gitignore`
- Test: `__tests__/install-history-extract.test.ts`

**Interfaces:**
- Consumes (Task 2): `InstallHistoryFile`, `HistoryEntry`, `historyEntryId`, `mergeInstallHistory`, `parseInstallHistory`, `renderInstallHistory`, `INSTALL_HISTORY_FILE`; `normaliseSpace`, `MIN_QUOTE_WORDS` (`need-evidence*.ts`); `SEGMENTS`.
- Produces:
  - `interface NewsItem { source: string; date: string; text: string }`
  - `interface NameList { id: string; names: string[] }`
  - `mentioned(text: string, lists: NameList[]): string[]`
  - `candidates(items: NewsItem[], accounts: NameList[], vendors: NameList[]): Array<{ item: NewsItem; accounts: string[]; vendors: string[] }>`
  - `historyPrompt(item: NewsItem, accounts: string[], vendors: string[]): string`
  - `interface ProposedChange { account: string; segment: string; vendor: string; change: string; replaced_vendor?: string; quote: string }`
  - `parseHistoryReply(reply: string): ProposedChange | "none" | null`
  - `type HistoryDrop = "unknown account" | "unknown segment" | "unknown vendor" | "replaced_vendor rule" | "quote too short" | "quote not in source"`
  - `checkChange(p: ProposedChange, item: NewsItem, accounts: string[], vendors: string[]): HistoryDrop | null`
  - `runHistoryExtraction(file, candidates, deps: { complete(prompt: string): Promise<string>; today(): string; log(line: string): void }, options?: { onItem?: (file: InstallHistoryFile) => void }): Promise<{ file; proposed: HistoryEntry[]; dropped: Record<HistoryDrop, number>; skipped: number; failed: number }>`
  - `historyStatusReport(file: InstallHistoryFile): string[]`

- [ ] **Step 1: Write the failing tests**

Create `__tests__/install-history-extract.test.ts`:

```ts
import { describe, expect, it } from "@jest/globals";
import {
  candidates,
  checkChange,
  historyStatusReport,
  mentioned,
  parseHistoryReply,
  runHistoryExtraction,
  type NewsItem,
} from "../src/services/install-history-extract.js";
import type { InstallHistoryFile } from "../src/services/install-history.js";

const accounts = [{ id: "novartis", names: ["novartis", "Novartis", "Sandoz"] }];
const vendors = [
  { id: "hds", names: ["hds", "Hitachi Vantara"] },
  { id: "dell", names: ["dell", "Dell Technologies"] },
];
const ITEM: NewsItem = {
  source: "https://news.test/a",
  date: "2026-03-12",
  text: "Novartis has replaced its Dell arrays with Hitachi Vantara storage across its EU manufacturing sites.",
};
const GOOD = {
  account: "novartis",
  segment: "storage-block",
  vendor: "hds",
  change: "replaced",
  replaced_vendor: "dell",
  quote: "Novartis has replaced its Dell arrays with Hitachi Vantara storage",
};
const empty = (): InstallHistoryFile => ({ sources: {}, entries: [] });

describe("prefilter", () => {
  it("finds account and vendor names as whole words, aliases included", () => {
    expect(mentioned(ITEM.text, vendors).sort()).toEqual(["dell", "hds"]);
    expect(mentioned("Dellwood news", vendors)).toEqual([]);
  });

  it("keeps only items naming both an account and a vendor", () => {
    const other: NewsItem = { source: "x", date: "2026-01-01", text: "Novartis opens a new site in Basel." };
    expect(candidates([ITEM, other], accounts, vendors).map((c) => c.item.source)).toEqual(["https://news.test/a"]);
  });
});

describe("reply and checks", () => {
  it("reads one change, none, or nothing usable", () => {
    expect(parseHistoryReply(`ok: ${JSON.stringify(GOOD)}`)).toEqual(GOOD);
    expect(parseHistoryReply('{"none": true}')).toBe("none");
    expect(parseHistoryReply("no json")).toBeNull();
  });

  it("drops unknown names, the replaced_vendor rule, short quotes and invented quotes", () => {
    const a = ["novartis"];
    const v = ["hds", "dell"];
    expect(checkChange({ ...GOOD, account: "roche" }, ITEM, a, v)).toBe("unknown account");
    expect(checkChange({ ...GOOD, segment: "mainframe" }, ITEM, a, v)).toBe("unknown segment");
    expect(checkChange({ ...GOOD, vendor: "pure" }, ITEM, a, v)).toBe("unknown vendor");
    expect(checkChange({ ...GOOD, replaced_vendor: undefined }, ITEM, a, v)).toBe("replaced_vendor rule");
    expect(checkChange({ ...GOOD, quote: "Novartis replaced Dell" }, ITEM, a, v)).toBe("quote too short");
    expect(checkChange({ ...GOOD, quote: "Novartis moved every workload to Hitachi Vantara last year" }, ITEM, a, v)).toBe("quote not in source");
    expect(checkChange(GOOD, ITEM, a, v)).toBeNull();
  });
});

describe("runHistoryExtraction", () => {
  const cands = candidates([ITEM], accounts, vendors);

  it("proposes a checked change dated by the item, never by the model", async () => {
    const result = await runHistoryExtraction(empty(), cands, {
      complete: async () => JSON.stringify({ ...GOOD, date: "1999-01-01" }),
      today: () => "2026-10-03",
      log: () => {},
    });
    expect(result.proposed).toHaveLength(1);
    expect(result.file.entries[0]).toMatchObject({ status: "proposed", date: "2026-03-12", source: "https://news.test/a", change: "replaced", replaced_vendor: "dell" });
    expect(result.file.sources).toEqual({ "https://news.test/a": "done" });
  });

  it("skips processed items, retries failed ones, and saves after each item", async () => {
    const saved: number[] = [];
    const failed = await runHistoryExtraction(empty(), cands, {
      complete: async () => {
        throw new Error("stack down");
      },
      today: () => "2026-10-03",
      log: () => {},
    });
    expect(failed.failed).toBe(1);
    expect(failed.file.sources).toEqual({});
    const done = await runHistoryExtraction(
      { sources: { "https://news.test/a": "done" }, entries: [] },
      cands,
      { complete: async () => JSON.stringify(GOOD), today: () => "2026-10-03", log: () => {} },
      { onItem: (f) => saved.push(f.entries.length) },
    );
    expect(done.skipped).toBe(1);
    expect(saved).toEqual([]);
  });

  it("reports counts and the next proposals", () => {
    const lines = historyStatusReport({
      sources: {},
      entries: [
        { id: "ih-1", status: "proposed", account: "novartis", segment: "storage-block", vendor: "hds", change: "installed", date: "2026-03-12", quote: "q", source: "s", extracted: "" },
      ],
    });
    expect(lines).toContain("novartis / storage-block: 0 approved, 1 proposed, 0 rejected");
    expect(lines).toContain('ih-1  novartis / storage-block  installed hds  2026-03-12  — "q" (s)');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- __tests__/install-history-extract.test.ts`
Expected: FAIL with `Could not locate module …install-history-extract.js`.

- [ ] **Step 3: Implement `src/services/install-history-extract.ts`**

```ts
// Proposes install-base changes from news with the local 27B (spec
// 2026-10-03-install-history-design.md). Items are pre-filtered without the
// model (they must name an account and a vendor); the model may only answer
// one change from the closed sets, with a verbatim quote; the date is always
// the item's own. Every side effect is injected.
import { SEGMENTS } from "./graph-schema.js";
import { historyEntryId, type HistoryEntry, type InstallHistoryFile } from "./install-history.js";
import { MIN_QUOTE_WORDS } from "./need-evidence-extract.js";
import { normaliseSpace } from "./need-evidence.js";

export interface NewsItem {
  source: string;
  /** YYYY-MM-DD: the item's own date. */
  date: string;
  text: string;
}

export interface NameList {
  id: string;
  names: string[];
}

export interface ProposedChange {
  account: string;
  segment: string;
  vendor: string;
  change: string;
  replaced_vendor?: string;
  quote: string;
}

export type HistoryDrop =
  | "unknown account"
  | "unknown segment"
  | "unknown vendor"
  | "replaced_vendor rule"
  | "quote too short"
  | "quote not in source";

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Ids whose names appear in the text as whole words. */
export function mentioned(text: string, lists: NameList[]): string[] {
  const padded = `-${slug(text)}-`;
  return lists.filter((l) => l.names.some((n) => slug(n) !== "" && padded.includes(`-${slug(n)}-`))).map((l) => l.id);
}

export function candidates(items: NewsItem[], accounts: NameList[], vendors: NameList[]) {
  return items
    .map((item) => ({ item, accounts: mentioned(item.text, accounts), vendors: mentioned(item.text, vendors) }))
    .filter((c) => c.accounts.length > 0 && c.vendors.length > 0);
}

export function historyPrompt(item: NewsItem, accounts: string[], vendors: string[]): string {
  return `Does this news item report that one of these accounts installed, replaced or removed an IT vendor in one segment?

Accounts: ${accounts.join(", ")}
Vendors: ${vendors.join(", ")}
Segments: ${SEGMENTS.join(", ")}

Answer with JSON only:
- a change: {"account": "...", "segment": "...", "vendor": "...", "change": "installed" | "replaced" | "removed", "replaced_vendor": "..." (only for replaced), "quote": "..."}
- or {"none": true} when the item reports no such change.
"quote" is one sentence copied word for word from the item. Use only the names listed above.

Item:
"""
${item.text}
"""`;
}

export function parseHistoryReply(reply: string): ProposedChange | "none" | null {
  const match = reply.match(/\{[\s\S]*\}/);
  if (match === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (p.none === true) return "none";
  const s = (k: string) => (typeof p[k] === "string" ? (p[k] as string).trim() : "");
  if (["account", "segment", "vendor", "change", "quote"].some((k) => s(k) === "")) return null;
  return {
    account: s("account"),
    segment: s("segment"),
    vendor: s("vendor"),
    change: s("change"),
    ...(s("replaced_vendor") !== "" ? { replaced_vendor: s("replaced_vendor") } : {}),
    quote: s("quote"),
  };
}

export function checkChange(p: ProposedChange, item: NewsItem, accounts: string[], vendors: string[]): HistoryDrop | null {
  if (!accounts.includes(p.account)) return "unknown account";
  if (!(SEGMENTS as readonly string[]).includes(p.segment)) return "unknown segment";
  if (!vendors.includes(p.vendor)) return "unknown vendor";
  const replaced = p.change === "replaced";
  if (!["installed", "replaced", "removed"].includes(p.change)) return "replaced_vendor rule";
  if (replaced !== (p.replaced_vendor !== undefined) || (replaced && !vendors.includes(p.replaced_vendor ?? ""))) {
    return "replaced_vendor rule";
  }
  if (normaliseSpace(p.quote).split(" ").length < MIN_QUOTE_WORDS) return "quote too short";
  if (!normaliseSpace(item.text).includes(normaliseSpace(p.quote))) return "quote not in source";
  return null;
}

export async function runHistoryExtraction(
  file: InstallHistoryFile,
  cands: Array<{ item: NewsItem; accounts: string[]; vendors: string[] }>,
  deps: { complete(prompt: string): Promise<string>; today(): string; log(line: string): void },
  options: { onItem?: (file: InstallHistoryFile) => void } = {},
) {
  const result = {
    file: { sources: { ...file.sources }, entries: file.entries.map((e) => ({ ...e })) },
    proposed: [] as HistoryEntry[],
    dropped: {
      "unknown account": 0,
      "unknown segment": 0,
      "unknown vendor": 0,
      "replaced_vendor rule": 0,
      "quote too short": 0,
      "quote not in source": 0,
    } as Record<HistoryDrop, number>,
    skipped: 0,
    failed: 0,
  };
  const known = new Set(result.file.entries.map((e) => e.id));

  for (const c of cands) {
    if (result.file.sources[c.item.source] === "done") {
      result.skipped++;
      continue;
    }
    let reply: ProposedChange | "none" | null;
    try {
      reply = parseHistoryReply(await deps.complete(historyPrompt(c.item, c.accounts, c.vendors)));
    } catch (err) {
      deps.log(`${c.item.source}: model call failed: ${err instanceof Error ? err.message : String(err)}`);
      reply = null;
    }
    if (reply === null) {
      result.failed++;
      continue; // unrecorded: retried next run
    }
    if (reply !== "none") {
      const reason = checkChange(reply, c.item, c.accounts, c.vendors);
      if (reason !== null) result.dropped[reason]++;
      else {
        const id = historyEntryId(reply.account, reply.segment, reply.vendor, reply.change, reply.quote);
        if (!known.has(id)) {
          known.add(id);
          const entry: HistoryEntry = {
            id,
            status: "proposed",
            account: reply.account,
            segment: reply.segment,
            vendor: reply.vendor,
            change: reply.change as HistoryEntry["change"],
            ...(reply.replaced_vendor !== undefined ? { replaced_vendor: reply.replaced_vendor } : {}),
            date: c.item.date,
            quote: reply.quote,
            source: c.item.source,
            extracted: deps.today(),
          };
          result.file.entries.push(entry);
          result.proposed.push(entry);
        }
      }
    }
    result.file.sources[c.item.source] = "done";
    options.onItem?.(result.file);
  }
  return result;
}

export function historyStatusReport(file: InstallHistoryFile): string[] {
  const groups = new Map<string, Record<string, number>>();
  for (const e of file.entries) {
    const key = `${e.account} / ${e.segment}`;
    const counts = groups.get(key) ?? { approved: 0, proposed: 0, rejected: 0 };
    counts[e.status]++;
    groups.set(key, counts);
  }
  const lines = [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, c]) => `${key}: ${c.approved} approved, ${c.proposed} proposed, ${c.rejected} rejected`);
  const next = file.entries.filter((e) => e.status === "proposed").slice(0, 10);
  if (next.length > 0) {
    lines.push("", "Next to review:");
    for (const e of next) {
      const what = e.change === "replaced" ? `replaced ${e.replaced_vendor} by ${e.vendor}` : `${e.change} ${e.vendor}`;
      lines.push(`${e.id}  ${e.account} / ${e.segment}  ${what}  ${e.date}  — "${e.quote}" (${e.source})`);
    }
  }
  return lines;
}
```

- [ ] **Step 4: Write `scripts/extract-install-history.ts`**

```ts
// Propose install-base changes from watchlist items and archive news with the
// active stack's model. Writes only config/install-history.local.yaml.
//
// Usage:
//   npx tsx scripts/extract-install-history.ts [--dry-run]
//   npx tsx scripts/extract-install-history.ts --status
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAccounts } from "../src/services/graph-accounts.js";
import { candidates, historyStatusReport, runHistoryExtraction, type NewsItem } from "../src/services/install-history-extract.js";
import {
  INSTALL_HISTORY_FILE,
  mergeInstallHistory,
  parseInstallHistory,
  renderInstallHistory,
  type InstallHistoryFile,
} from "../src/services/install-history.js";
import { getLlmClient } from "../src/services/llm-client.js";
import { listRawDocuments } from "../src/services/raw-documents.js";
import { loadWatchlist } from "../src/services/watchlist-config.js";
import { openWatchlistStore } from "../src/services/watchlist-store.js";

const root = process.cwd();
const dryRun = process.argv.includes("--dry-run");
const filePath = join(root, INSTALL_HISTORY_FILE);
const read = (): InstallHistoryFile =>
  existsSync(filePath) ? parseInstallHistory(readFileSync(filePath, "utf8")) : { sources: {}, entries: [] };

if (process.argv.includes("--status")) {
  for (const line of historyStatusReport(read())) console.log(line);
  process.exit(0);
}

const accountsPath = join(root, "config", "accounts.local.yaml");
if (!existsSync(accountsPath)) {
  console.error("declare accounts first: copy config/accounts.example.yaml to config/accounts.local.yaml");
  process.exit(1);
}
const accounts = parseAccounts(readFileSync(accountsPath, "utf8")).map((a) => ({ id: a.id, names: [a.id, a.name, ...a.aliases] }));
const vendors = [...loadWatchlist().entities.values()]
  .filter((e) => e.kind === "vendor")
  .map((e) => ({ id: e.id, names: [e.id, e.name, ...e.aliases] }));

const items: NewsItem[] = [];
const dbPath = join(root, "data", "watchlist.db");
if (existsSync(dbPath)) {
  const store = openWatchlistStore(dbPath);
  try {
    for (const it of store.itemsInPeriod("0000-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z", { entities: accounts.map((a) => a.id) })) {
      items.push({ source: it.urlCanonical, date: it.publishedAt.slice(0, 10), text: [it.title, it.summary, it.body].join("\n\n").slice(0, 6000) });
    }
  } finally {
    store.close();
  }
}
for (const doc of await listRawDocuments()) {
  const day = /^news-(\d{4}-\d{2}-\d{2})$/.exec(doc.source)?.[1];
  if (day !== undefined) items.push({ source: doc.source, date: day, text: doc.content.slice(0, 6000) });
}

const cands = candidates(items, accounts, vendors);
console.log(`${items.length} items, ${cands.length} name an account and a vendor`);

const llm = getLlmClient();
if (!(await llm.isReachable())) {
  console.error(`the active stack (${llm.stack.name}) is not reachable: start it before extracting`);
  process.exit(1);
}

function save(fromRun: InstallHistoryFile): void {
  writeFileSync(`${filePath}.tmp`, renderInstallHistory(mergeInstallHistory(read(), fromRun)));
  renameSync(`${filePath}.tmp`, filePath);
}

const result = await runHistoryExtraction(
  read(),
  cands,
  {
    complete: (prompt) => llm.chat([{ role: "user", content: prompt }], { temperature: 0.1 }),
    today: () => new Date().toISOString().slice(0, 10),
    log: (line) => console.log(line),
  },
  { onItem: dryRun ? undefined : save },
);

for (const e of result.proposed) console.log(`+ ${e.id}  ${e.account} / ${e.segment}  ${e.change} ${e.vendor}  ${e.date}  — "${e.quote}"`);
const dropped = Object.entries(result.dropped).filter(([, n]) => n > 0).map(([r, n]) => `${n} ${r}`);
console.log(`\n${result.proposed.length} proposed, ${result.skipped} already processed, ${result.failed} failed${dropped.length > 0 ? `, dropped: ${dropped.join(", ")}` : ""}`);
if (dryRun) console.log("DRY RUN: nothing written");
else {
  save(result.file);
  console.log(`written: ${INSTALL_HISTORY_FILE} (approve entries by changing their status)`);
}
```

- [ ] **Step 5: Gitignore, run the tests and typecheck**

In `.gitignore`, add below `config/need-evidence.local.yaml`:

```
config/install-history.local.yaml
```

Run: `npm test -- __tests__/install-history-extract.test.ts && npm run typecheck && npm run typecheck:tests && npx tsx scripts/extract-install-history.ts --status; echo "exit $?"`
Expected: PASS; `--status` prints nothing and exits 0 (no file in the worktree; no model call).

- [ ] **Step 6: Commit**

```bash
git add src/services/install-history-extract.ts scripts/extract-install-history.ts .gitignore __tests__/install-history-extract.test.ts
git commit -m "feat: extract-install-history — 27B proposes install-base changes from news

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Docs and verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update `CLAUDE.md`**

In the Retrieval bullet, after the need-evidence sentence, add:

```
  Install-base history: incumbents in `accounts.local.yaml` may be dated (`{vendor, since, until}`; only entries without
  `until` are current); `scripts/extract-install-history.ts` proposes changes from news into the gitignored
  `config/install-history.local.yaml` (approve by `status`); the rebuild merges them into `USES {segment, since, until,
  source}` (the accounts file wins; contradictions become notes). The answer shows `history` per segment: last 18
  months by default, every stint with `history: "full"` (chat: history wording).
```

and in the Commands block:

```
npx tsx scripts/extract-install-history.ts [--dry-run] | --status    # 27B proposes install-base changes; approve in config/install-history.local.yaml
```

- [ ] **Step 2: Full verification**

Run: `npm run typecheck && npm run typecheck:tests && npm test && npm --prefix mcp test && npm --prefix mcp run typecheck`
Expected: all pass. Then, read-only from the main checkout: `npx tsx .worktrees/install-history/scripts/rebuild-vendor-graph.ts` parses the real accounts file unchanged and prints `install-history.local.yaml -> skipped (no such file)`.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: install-base history in CLAUDE.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Ask before anything live**

Ask separately, and act only on a yes: (a) `extract-install-history.ts --dry-run` (a few 27B calls, nothing written); (b) the full run (writes only `config/install-history.local.yaml`); (c) adding the user's dated Novartis lines to `config/accounts.local.yaml` (the date only the user knows) and a live rebuild after a graph export, then a read-only Novartis probe showing the `changed:` line.

- [ ] **Step 5: Push and PR**

```bash
git push -u origin feature/install-history
gh pr create --base feature/need-evidence --title "feat: install-base history — dated incumbents and news-proposed changes" --body-file /tmp/claude-rank/pr-history.md
```

Write the PR body first (What, test totals, dry-run/live results, rulings, final line `🤖 Generated with [Claude Code](https://claude.com/claude-code)`).
