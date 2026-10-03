# Need Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reviewed, cited reasons why each account has each need: a one-off 27B extraction proposes them into a local file, the user approves entries, and the graph rebuild turns approved ones into reference Evidence that `competitive_position` and the chat show.

**Architecture:** `need-evidence.ts` owns the proposals-file model (ids, validation, serialisation, graph facts) and is pure. `need-evidence-extract.ts` owns chunking, the prompt, reply parsing, proposal checks and the resumable run, with every side effect injected. `scripts/extract-need-evidence.ts` wires files and the active LLM stack. The rebuild reads the file as a fifth source through the existing `optionalSource`; the answer reads approved entries with one Cypher query and keeps them apart from news by `kind`.

**Tech Stack:** TypeScript ESM (Node16, strict), Jest (ESM), `yaml`, `node:crypto`, neo4j-driver, zod (MCP).

**Spec:** `docs/superpowers/specs/2026-10-02-need-evidence-design.md`

**Worktree:** `.worktrees/need-evidence`, branch `feature/need-evidence`, stacked on PR #66. Run every command from the worktree root.

## Global Constraints

- Tests never touch live services, never call the 27B, never read the real `config/` or `knowledge/`. No `any`. Interfaces for object shapes. Siblings imported as `./x.js`.
- `npm run typecheck` after every code change; `npm run typecheck:tests` before each commit; `npm --prefix mcp run typecheck` after MCP changes.
- Commit prefixes `feat:` `fix:` `refactor:` `test:` `docs:`; every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- File: `config/need-evidence.local.yaml` (gitignored). Statuses `proposed | approved | rejected`. Ids `ne-` + 6 hex chars of sha256(account, need, whitespace-normalised quote).
- Claim ≤ 200 characters (`MAX_CLAIM_CHARS`); ≤ 5 entries per chunk (`MAX_PER_CHUNK`); chunks ~2,500 words (`CHUNK_WORDS`) at paragraph boundaries; ≤ 3 entries per need in the answer (`NEED_EVIDENCE_PER_NEED`).
- Graph: `(Evidence {kind: "reference", claim, quote, source, order})-[:SUPPORTS {url: "<source>#<id>", need}]->(Account)`; watchlist Evidence gains `kind: "watchlist"`; news queries filter `coalesce(e.kind, "watchlist") = "watchlist"`.
- Real 27B calls (extraction dry run, full extraction) and any live rebuild happen **only after the user's yes** (Task 6).

## Review Focus

1. **The user approved some entries, then re-runs the extraction** (new documents, or a changed one): approved and rejected statuses stay, and a quote met again is not duplicated. Pinned in Task 2.
2. **A chunk's model call fails mid-document**: that document's hash is not recorded, so the next run retries it instead of silently skipping it forever. Pinned in Task 2.
3. **A quote that wraps across lines in the source** (Markdown hard wraps, PDF line breaks) must still match after whitespace normalisation; a quote the model paraphrased must not. Pinned in Task 2.
4. **Reference Evidence never appears as news** (vendor evidence, account events, general) on any graph, including one built before `kind` existed. Pinned in Task 5.
5. **The proposals file hand-edited into invalid YAML** fails the rebuild before the wipe, naming the file. Pinned in Task 4.

---

### Task 1: `need-evidence.ts`, the proposals file

**Files:**
- Create: `src/services/need-evidence.ts`
- Test: `__tests__/need-evidence.test.ts`

**Interfaces:**
- Consumes: `NEEDS`, `GraphFacts`, `GraphNode`, `GraphRelationship` (`graph-schema.ts`); `Account` (`graph-accounts.ts`).
- Produces:
  - `NEED_EVIDENCE_FILE = "config/need-evidence.local.yaml"`, `MAX_CLAIM_CHARS = 200`
  - `type EvidenceStatus = "proposed" | "approved" | "rejected"`
  - `interface NeedEvidenceEntry { id: string; status: EvidenceStatus; account: string; need: string; claim: string; quote: string; source: string; extracted: string }`
  - `interface NeedEvidenceFile { sources: Record<string, string>; entries: NeedEvidenceEntry[] }`
  - `normaliseSpace(text: string): string`
  - `entryId(account: string, need: string, quote: string): string`
  - `parseNeedEvidence(yaml: string): NeedEvidenceFile`
  - `checkAgainstAccounts(file: NeedEvidenceFile, accounts: Account[]): void`
  - `renderNeedEvidence(file: NeedEvidenceFile): string`
  - `needEvidenceToGraphFacts(file: NeedEvidenceFile): { facts: GraphFacts; line: string }`

- [ ] **Step 1: Write the failing tests**

Create `__tests__/need-evidence.test.ts`:

```ts
import { describe, expect, it } from "@jest/globals";
import type { Account } from "../src/services/graph-accounts.js";
import {
  checkAgainstAccounts,
  entryId,
  needEvidenceToGraphFacts,
  parseNeedEvidence,
  renderNeedEvidence,
  type NeedEvidenceEntry,
  type NeedEvidenceFile,
} from "../src/services/need-evidence.js";

function entry(over: Partial<NeedEvidenceEntry> & { id: string }): NeedEvidenceEntry {
  return {
    id: over.id,
    status: over.status ?? "approved",
    account: over.account ?? "roche",
    need: over.need ?? "cyber-resilience",
    claim: over.claim ?? "Ransomware on a pharma peer halted production for weeks",
    quote: over.quote ?? "Merck's operations were disrupted for weeks by NotPetya.",
    source: over.source ?? "knowledge/cyber-pharma-major-attacks.md",
    extracted: over.extracted ?? "2026-10-02",
  };
}

function file(entries: NeedEvidenceEntry[], sources: Record<string, string> = {}): NeedEvidenceFile {
  return { sources, entries };
}

const roche: Account = {
  id: "roche",
  name: "Roche",
  aliases: [],
  needs: ["cyber-resilience", "gxp-compliance"],
  incumbents: {},
  triggers: {},
  notes: "",
};

describe("entryId", () => {
  it("is stable, prefixed, and ignores whitespace differences in the quote", () => {
    const id = entryId("roche", "cyber-resilience", "Merck's operations were\n  disrupted.");
    expect(id).toMatch(/^ne-[0-9a-f]{6}$/);
    expect(entryId("roche", "cyber-resilience", "Merck's operations were disrupted.")).toBe(id);
    expect(entryId("novartis", "cyber-resilience", "Merck's operations were disrupted.")).not.toBe(id);
  });
});

describe("parseNeedEvidence / renderNeedEvidence", () => {
  it("round-trips a file", () => {
    const original = file([entry({ id: "ne-000001", status: "proposed" })], { "knowledge/a.md": "abc" });
    expect(parseNeedEvidence(renderNeedEvidence(original))).toEqual(original);
  });

  it("starts the file with the instructions comment", () => {
    expect(renderNeedEvidence(file([]))).toMatch(/^# Written by scripts\/extract-need-evidence\.ts/);
  });

  it("reads an empty document as an empty file", () => {
    expect(parseNeedEvidence("")).toEqual({ sources: {}, entries: [] });
  });

  it("refuses an unknown status, naming the entry", () => {
    const yaml = renderNeedEvidence(file([entry({ id: "ne-000001" })])).replace("status: approved", "status: maybe");
    expect(() => parseNeedEvidence(yaml)).toThrow("ne-000001: status must be proposed, approved or rejected");
  });

  it("refuses an empty claim or quote", () => {
    const yaml = renderNeedEvidence(file([entry({ id: "ne-000001", claim: "x" })])).replace("claim: x", 'claim: ""');
    expect(() => parseNeedEvidence(yaml)).toThrow("ne-000001: claim and quote must be non-empty");
  });

  it("refuses a need outside the closed set", () => {
    const yaml = renderNeedEvidence(file([entry({ id: "ne-000001", need: "time-travel" })]));
    expect(() => parseNeedEvidence(yaml)).toThrow('ne-000001: invalid need "time-travel"');
  });

  it("refuses a duplicate id", () => {
    const yaml = renderNeedEvidence(file([entry({ id: "ne-000001" }), entry({ id: "ne-000001", need: "gxp-compliance" })]));
    expect(() => parseNeedEvidence(yaml)).toThrow("duplicate id ne-000001");
  });
});

describe("checkAgainstAccounts", () => {
  it("refuses approved entries for a need the account no longer declares, listing them", () => {
    const stale = file([
      entry({ id: "ne-000001", need: "data-sovereignty" }),
      entry({ id: "ne-000002", need: "data-sovereignty" }),
      entry({ id: "ne-000003", need: "data-sovereignty", status: "proposed" }),
    ]);
    expect(() => checkAgainstAccounts(stale, [roche])).toThrow(
      "roche no longer declares data-sovereignty: reject or re-approve ne-000001, ne-000002",
    );
  });

  it("refuses an approved entry for an unknown account", () => {
    expect(() => checkAgainstAccounts(file([entry({ id: "ne-000004", account: "acme" })]), [roche])).toThrow(
      'ne-000004 names unknown account "acme"',
    );
  });

  it("ignores proposed and rejected entries", () => {
    const pending = file([
      entry({ id: "ne-000005", account: "acme", status: "proposed" }),
      entry({ id: "ne-000006", need: "data-sovereignty", status: "rejected" }),
    ]);
    expect(() => checkAgainstAccounts(pending, [roche])).not.toThrow();
  });
});

describe("needEvidenceToGraphFacts", () => {
  it("writes approved entries only, in file order, and reports every status", () => {
    const { facts, line } = needEvidenceToGraphFacts(
      file([
        entry({ id: "ne-000001" }),
        entry({ id: "ne-000002", status: "proposed" }),
        entry({ id: "ne-000003", account: "novartis" }),
        entry({ id: "ne-000004", status: "rejected" }),
        entry({ id: "ne-000005", need: "gxp-compliance" }),
      ]),
    );
    expect(facts.nodes.map((n) => [n.id, n.properties.order])).toEqual([
      ["ne-000001", 0],
      ["ne-000003", 1],
      ["ne-000005", 2],
    ]);
    expect(facts.nodes[0]).toEqual({
      label: "Evidence",
      id: "ne-000001",
      properties: {
        kind: "reference",
        claim: "Ransomware on a pharma peer halted production for weeks",
        quote: "Merck's operations were disrupted for weeks by NotPetya.",
        source: "knowledge/cyber-pharma-major-attacks.md",
        order: 0,
      },
    });
    expect(facts.relationships[0]).toEqual({
      type: "SUPPORTS",
      from: "ne-000001",
      to: "roche",
      properties: { url: "knowledge/cyber-pharma-major-attacks.md#ne-000001", need: "cyber-resilience" },
    });
    expect(line).toBe("need-evidence.local.yaml     -> 3 approved (novartis 1, roche 2), 1 proposed, 1 rejected");
  });

  it("reports a file with nothing approved", () => {
    expect(needEvidenceToGraphFacts(file([entry({ id: "ne-000001", status: "proposed" })])).line).toBe(
      "need-evidence.local.yaml     -> 0 approved, 1 proposed, 0 rejected",
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- __tests__/need-evidence.test.ts`
Expected: FAIL with `Could not locate module ../src/services/need-evidence.js`.

- [ ] **Step 3: Implement `src/services/need-evidence.ts`**

```ts
// The need-evidence proposals file: reasons why each account has each need,
// cited from the legacy documents (spec 2026-10-02-need-evidence-design.md).
//
// The 27B proposes entries (need-evidence-extract.ts); the user approves them
// by editing `status`; only approved entries reach the graph, through the
// rebuild. Pure: the callers read and write the file.
import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import type { Account } from "./graph-accounts.js";
import { NEEDS, type GraphFacts, type GraphNode, type GraphRelationship } from "./graph-schema.js";

export const NEED_EVIDENCE_FILE = "config/need-evidence.local.yaml";
export const MAX_CLAIM_CHARS = 200;

const STATUSES = ["proposed", "approved", "rejected"] as const;
export type EvidenceStatus = (typeof STATUSES)[number];

export interface NeedEvidenceEntry {
  id: string;
  status: EvidenceStatus;
  account: string;
  need: string;
  claim: string;
  quote: string;
  source: string;
  extracted: string;
}

export interface NeedEvidenceFile {
  /** Processed document -> content hash, so a re-run skips what has not changed. */
  sources: Record<string, string>;
  entries: NeedEvidenceEntry[];
}

const HEADER = `# Written by scripts/extract-need-evidence.ts. Change status to approved or
# rejected; only approved entries reach the graph. Re-runs never touch an
# entry that is already here, so your decisions stay.
`;

export function normaliseSpace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Stable across re-runs: the same quote for the same account and need is the same entry. */
export function entryId(account: string, need: string, quote: string): string {
  return `ne-${createHash("sha256").update(`${account}\n${need}\n${normaliseSpace(quote)}`).digest("hex").slice(0, 6)}`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parseNeedEvidence(yaml: string): NeedEvidenceFile {
  const doc = (parse(yaml) ?? {}) as { sources?: unknown; entries?: unknown };
  const sources: Record<string, string> = {};
  if (doc.sources !== null && typeof doc.sources === "object" && !Array.isArray(doc.sources)) {
    for (const [path, hash] of Object.entries(doc.sources as Record<string, unknown>)) sources[path] = String(hash);
  }

  const seen = new Set<string>();
  const entries = (Array.isArray(doc.entries) ? doc.entries : []).map((raw): NeedEvidenceEntry => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const id = text(r.id);
    if (seen.has(id)) throw new Error(`duplicate id ${id}`);
    seen.add(id);
    const status = text(r.status);
    if (!(STATUSES as readonly string[]).includes(status)) {
      throw new Error(`${id}: status must be proposed, approved or rejected`);
    }
    const need = text(r.need);
    if (!(NEEDS as readonly string[]).includes(need)) throw new Error(`${id}: invalid need "${need}"`);
    const claim = text(r.claim).trim();
    const quote = text(r.quote).trim();
    if (claim.length === 0 || quote.length === 0) throw new Error(`${id}: claim and quote must be non-empty`);
    return {
      id,
      status: status as EvidenceStatus,
      account: text(r.account),
      need,
      claim,
      quote,
      source: text(r.source),
      extracted: text(r.extracted),
    };
  });

  return { sources, entries };
}

/** Approved entries must still match the accounts file: fail loudly rather than drop the user's decisions. */
export function checkAgainstAccounts(file: NeedEvidenceFile, accounts: Account[]): void {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const stale = new Map<string, string[]>();
  for (const e of file.entries) {
    if (e.status !== "approved") continue;
    const account = byId.get(e.account);
    if (account === undefined) throw new Error(`${e.id} names unknown account "${e.account}"`);
    if (!(account.needs as readonly string[]).includes(e.need)) {
      const key = `${e.account} no longer declares ${e.need}`;
      stale.set(key, [...(stale.get(key) ?? []), e.id]);
    }
  }
  for (const [problem, ids] of stale) throw new Error(`${problem}: reject or re-approve ${ids.join(", ")}`);
}

export function renderNeedEvidence(file: NeedEvidenceFile): string {
  return HEADER + stringify({ sources: file.sources, entries: file.entries }, { lineWidth: 0 });
}

export function needEvidenceToGraphFacts(file: NeedEvidenceFile): { facts: GraphFacts; line: string } {
  const approved = file.entries.filter((e) => e.status === "approved");
  const nodes: GraphNode[] = approved.map((e, order) => ({
    label: "Evidence",
    id: e.id,
    // `order` keeps file order: the answer shows the first entries per need.
    properties: { kind: "reference", claim: e.claim, quote: e.quote, source: e.source, order },
  }));
  const relationships: GraphRelationship[] = approved.map((e) => ({
    type: "SUPPORTS",
    from: e.id,
    to: e.account,
    properties: { url: `${e.source}#${e.id}`, need: e.need },
  }));

  const perAccount = new Map<string, number>();
  for (const e of approved) perAccount.set(e.account, (perAccount.get(e.account) ?? 0) + 1);
  const breakdown = [...perAccount].sort(([a], [b]) => a.localeCompare(b)).map(([a, n]) => `${a} ${n}`);
  const count = (status: EvidenceStatus) => file.entries.filter((e) => e.status === status).length;
  const line =
    `${"need-evidence.local.yaml".padEnd(28)} -> ${approved.length} approved` +
    (breakdown.length > 0 ? ` (${breakdown.join(", ")})` : "") +
    `, ${count("proposed")} proposed, ${count("rejected")} rejected`;

  return { facts: { nodes, relationships }, line };
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -- __tests__/need-evidence.test.ts && npm run typecheck && npm run typecheck:tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/need-evidence.ts __tests__/need-evidence.test.ts
git commit -m "feat: need-evidence proposals file — ids, validation, graph facts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `need-evidence-extract.ts`, the resumable extraction

**Files:**
- Create: `src/services/need-evidence-extract.ts`
- Test: `__tests__/need-evidence-extract.test.ts`

**Interfaces:**
- Consumes (Task 1): `NeedEvidenceFile`, `NeedEvidenceEntry`, `entryId`, `normaliseSpace`, `MAX_CLAIM_CHARS`; `Account` (`graph-accounts.ts`).
- Produces:
  - `CHUNK_WORDS = 2500`, `MAX_PER_CHUNK = 5`
  - `chunkText(text: string, maxWords?: number): string[]`
  - `extractionPrompt(chunk: string, accounts: Account[]): string`
  - `interface ProposedEntry { account: string; need: string; claim: string; quote: string }`
  - `parseReply(reply: string): ProposedEntry[] | null`
  - `type DropReason = "unknown account" | "undeclared need" | "claim too long" | "quote not in source"`
  - `checkProposal(p: ProposedEntry, chunk: string, accounts: Account[]): DropReason | null`
  - `interface ExtractDeps { documents(): string[]; read(path: string): Promise<string>; complete(prompt: string): Promise<string>; today(): string; log(line: string): void }`
  - `interface ExtractResult { file: NeedEvidenceFile; proposed: NeedEvidenceEntry[]; dropped: Record<DropReason, number>; skippedDocs: number; failedChunks: number }`
  - `runExtraction(file: NeedEvidenceFile, accounts: Account[], deps: ExtractDeps, options?: { only?: string }): Promise<ExtractResult>`
  - `statusReport(file: NeedEvidenceFile): string[]`
  - `LEGACY_EXTENSIONS = [".md", ".pdf", ".docx"]`, `legacyDocuments(names: string[]): string[]` (top-level names → `knowledge/<name>` for supported extensions, sorted)
  - `interface ExtractArgs { only?: string; dryRun: boolean; status: boolean }`, `parseExtractArgs(argv: string[]): ExtractArgs`

- [ ] **Step 1: Write the failing tests**

Create `__tests__/need-evidence-extract.test.ts`:

```ts
import { describe, expect, it } from "@jest/globals";
import type { Account } from "../src/services/graph-accounts.js";
import { entryId, type NeedEvidenceFile } from "../src/services/need-evidence.js";
import {
  chunkText,
  checkProposal,
  extractionPrompt,
  legacyDocuments,
  parseExtractArgs,
  parseReply,
  runExtraction,
  statusReport,
  type ExtractDeps,
} from "../src/services/need-evidence-extract.js";

const roche: Account = {
  id: "roche",
  name: "Roche",
  aliases: [],
  needs: ["cyber-resilience", "gxp-compliance"],
  incumbents: {},
  triggers: {},
  notes: "",
};

const DOC = "Intro paragraph.\n\nMerck's operations were\ndisrupted for weeks by NotPetya.\n\nLast paragraph.";

function reply(entries: Array<Record<string, string>>): string {
  return `Here you go:\n${JSON.stringify(entries)}`;
}

const GOOD = {
  account: "roche",
  need: "cyber-resilience",
  claim: "Ransomware on a pharma peer halted production for weeks",
  quote: "Merck's operations were disrupted for weeks by NotPetya.",
};

function deps(over: Partial<ExtractDeps> & { docs?: Record<string, string> } = {}): ExtractDeps & { prompts: string[] } {
  const docs = over.docs ?? { "knowledge/a.md": DOC };
  const prompts: string[] = [];
  return {
    documents: () => Object.keys(docs),
    read: async (path) => docs[path],
    complete: async (prompt) => {
      prompts.push(prompt);
      return reply([GOOD]);
    },
    today: () => "2026-10-02",
    log: () => {},
    prompts,
    ...over,
  };
}

const empty = (): NeedEvidenceFile => ({ sources: {}, entries: [] });

describe("chunkText", () => {
  it("splits at paragraph boundaries under the word limit", () => {
    expect(chunkText("a b c\n\nd e\n\nf g h i", 5)).toEqual(["a b c\n\nd e", "f g h i"]);
  });

  it("splits a paragraph longer than the limit by words", () => {
    expect(chunkText("a b c d e f g", 3)).toEqual(["a b c", "d e f", "g"]);
  });
});

describe("parseReply / checkProposal", () => {
  it("reads the JSON array in a reply, keeping at most five well-formed entries", () => {
    const many = Array.from({ length: 7 }, () => GOOD);
    expect(parseReply(reply([...many, { account: "roche" }]))).toHaveLength(5);
    expect(parseReply("no json here")).toBeNull();
  });

  it("drops an unknown account, an undeclared need, a long claim and a quote not in the chunk", () => {
    const chunk = DOC;
    expect(checkProposal({ ...GOOD, account: "acme" }, chunk, [roche])).toBe("unknown account");
    expect(checkProposal({ ...GOOD, need: "sustainability" }, chunk, [roche])).toBe("undeclared need");
    expect(checkProposal({ ...GOOD, claim: "x".repeat(201) }, chunk, [roche])).toBe("claim too long");
    expect(checkProposal({ ...GOOD, quote: "Merck lost weeks to NotPetya." }, chunk, [roche])).toBe("quote not in source");
  });

  it("matches a quote that wraps across lines in the source", () => {
    expect(checkProposal(GOOD, DOC, [roche])).toBeNull();
  });

  it("names each account with its needs in the prompt", () => {
    expect(extractionPrompt("chunk text", [roche])).toContain("roche (Roche): cyber-resilience, gxp-compliance");
  });
});

describe("runExtraction", () => {
  it("appends checked proposals with stable ids and records the document's hash", async () => {
    const result = await runExtraction(empty(), [roche], deps());
    expect(result.proposed).toHaveLength(1);
    expect(result.file.entries[0]).toEqual({
      id: entryId("roche", "cyber-resilience", GOOD.quote),
      status: "proposed",
      ...GOOD,
      source: "knowledge/a.md",
      extracted: "2026-10-02",
    });
    expect(Object.keys(result.file.sources)).toEqual(["knowledge/a.md"]);
  });

  it("keeps the user's decisions and skips unchanged documents on a re-run", async () => {
    const first = await runExtraction(empty(), [roche], deps());
    const decided: NeedEvidenceFile = {
      ...first.file,
      entries: first.file.entries.map((e) => ({ ...e, status: "approved" as const })),
    };
    const d = deps();
    const second = await runExtraction(decided, [roche], d);
    expect(second.skippedDocs).toBe(1);
    expect(d.prompts).toHaveLength(0);
    expect(second.file.entries).toEqual(decided.entries);
  });

  it("does not duplicate an entry met again in a changed document", async () => {
    const first = await runExtraction(empty(), [roche], deps());
    const approved: NeedEvidenceFile = { ...first.file, entries: [{ ...first.file.entries[0], status: "approved" }] };
    const second = await runExtraction(approved, [roche], deps({ docs: { "knowledge/a.md": `${DOC}\n\nAn added paragraph.` } }));
    expect(second.file.entries).toHaveLength(1);
    expect(second.file.entries[0].status).toBe("approved");
  });

  it("counts drops by reason", async () => {
    const result = await runExtraction(
      empty(),
      [roche],
      deps({ complete: async () => reply([{ ...GOOD, account: "acme" }, { ...GOOD, quote: "invented" }]) }),
    );
    expect(result.dropped).toEqual({ "unknown account": 1, "undeclared need": 0, "claim too long": 0, "quote not in source": 1 });
    expect(result.file.entries).toEqual([]);
  });

  it("skips a chunk whose reply fails and retries the document next time", async () => {
    const result = await runExtraction(empty(), [roche], deps({ complete: async () => "not json" }));
    expect(result.failedChunks).toBe(1);
    expect(result.file.sources).toEqual({});
    const thrown = await runExtraction(
      empty(),
      [roche],
      deps({
        complete: async () => {
          throw new Error("stack down");
        },
      }),
    );
    expect(thrown.failedChunks).toBe(1);
    expect(thrown.file.sources).toEqual({});
  });

  it("processes only the named document", async () => {
    const d = deps({ docs: { "knowledge/a.md": DOC, "knowledge/b.md": DOC } });
    await runExtraction(empty(), [roche], d, { only: "knowledge/b.md" });
    expect(d.prompts).toHaveLength(1);
  });
});

describe("statusReport", () => {
  it("counts statuses per account and need and lists the next proposals", () => {
    const base = { account: "roche", need: "cyber-resilience", claim: "c", source: "knowledge/a.md", extracted: "" };
    const lines = statusReport({
      sources: {},
      entries: [
        { ...base, id: "ne-1", status: "approved", quote: "q1" },
        { ...base, id: "ne-2", status: "proposed", quote: "q2" },
      ],
    });
    expect(lines).toContain("roche / cyber-resilience: 1 approved, 1 proposed, 0 rejected");
    expect(lines).toContain('ne-2  roche / cyber-resilience  c  — "q2" (knowledge/a.md)');
  });
});

describe("documents and arguments", () => {
  it("keeps top-level Markdown, PDF and Word documents only", () => {
    expect(legacyDocuments(["b.md", "vendors", "a.pdf", "c.docx", ".index.mlx.json", "d.txt"])).toEqual([
      "knowledge/a.pdf",
      "knowledge/b.md",
      "knowledge/c.docx",
    ]);
  });

  it("parses the flags and refuses unknown ones", () => {
    expect(parseExtractArgs(["--only", "knowledge/a.md", "--dry-run"])).toEqual({ only: "knowledge/a.md", dryRun: true, status: false });
    expect(parseExtractArgs(["--status"])).toEqual({ dryRun: false, status: true });
    expect(() => parseExtractArgs(["--force"])).toThrow('unknown option "--force"');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- __tests__/need-evidence-extract.test.ts`
Expected: FAIL with `Could not locate module ../src/services/need-evidence-extract.js`.

- [ ] **Step 3: Implement `src/services/need-evidence-extract.ts`**

```ts
// One-off extraction of need evidence from the legacy documents with the local
// 27B (spec 2026-10-02-need-evidence-design.md). Every side effect is
// injected: scripts/extract-need-evidence.ts binds files and the active stack.
//
// The model only proposes; checks drop what cannot be right (an account or
// need outside the user's, an over-long claim, a quote not in the text), and
// the user approves the rest in the proposals file.
import { createHash } from "node:crypto";
import type { Account } from "./graph-accounts.js";
import {
  MAX_CLAIM_CHARS,
  entryId,
  normaliseSpace,
  type NeedEvidenceEntry,
  type NeedEvidenceFile,
} from "./need-evidence.js";

export const CHUNK_WORDS = 2500;
export const MAX_PER_CHUNK = 5;
export const LEGACY_EXTENSIONS = [".md", ".pdf", ".docx"];

export interface ProposedEntry {
  account: string;
  need: string;
  claim: string;
  quote: string;
}

export type DropReason = "unknown account" | "undeclared need" | "claim too long" | "quote not in source";

export interface ExtractDeps {
  documents(): string[];
  read(path: string): Promise<string>;
  complete(prompt: string): Promise<string>;
  today(): string;
  log(line: string): void;
}

export interface ExtractResult {
  file: NeedEvidenceFile;
  /** Entries appended by this run. */
  proposed: NeedEvidenceEntry[];
  dropped: Record<DropReason, number>;
  skippedDocs: number;
  failedChunks: number;
}

export interface ExtractArgs {
  only?: string;
  dryRun: boolean;
  status: boolean;
}

const words = (text: string): string[] => text.split(/\s+/).filter((w) => w.length > 0);

/** ~maxWords per chunk, at paragraph boundaries; a paragraph longer than that is split by words. */
export function chunkText(text: string, maxWords = CHUNK_WORDS): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let count = 0;
  const flush = () => {
    if (current.length > 0) chunks.push(current.join("\n\n"));
    current = [];
    count = 0;
  };
  for (const paragraph of text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0)) {
    const w = words(paragraph);
    if (w.length > maxWords) {
      flush();
      for (let i = 0; i < w.length; i += maxWords) chunks.push(w.slice(i, i + maxWords).join(" "));
      continue;
    }
    if (count + w.length > maxWords) flush();
    current.push(paragraph);
    count += w.length;
  }
  flush();
  return chunks;
}

export function extractionPrompt(chunk: string, accounts: Account[]): string {
  const list = accounts.map((a) => `- ${a.id} (${a.name}): ${a.needs.join(", ")}`).join("\n");
  return `You read an excerpt of a document and find facts that explain why one of these accounts has one of its needs.

Accounts and their needs:
${list}

Rules:
- Use only the accounts and needs listed above.
- "claim": one line, under ${MAX_CLAIM_CHARS} characters, saying why that account has that need.
- "quote": one sentence copied word for word from the excerpt that supports the claim.
- A fact about the whole sector may be given for several accounts, one entry each.
- At most ${MAX_PER_CHUNK} entries. If nothing in the excerpt applies, answer [].

Answer with a JSON array only: [{"account": "...", "need": "...", "claim": "...", "quote": "..."}]

Excerpt:
"""
${chunk}
"""`;
}

export function parseReply(reply: string): ProposedEntry[] | null {
  const match = reply.match(/\[[\s\S]*\]/);
  if (match === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed
    .filter((p): p is Record<string, unknown> => p !== null && typeof p === "object")
    .filter((p) => ["account", "need", "claim", "quote"].every((k) => typeof p[k] === "string" && (p[k] as string).trim() !== ""))
    .map((p) => ({ account: String(p.account), need: String(p.need), claim: String(p.claim).trim(), quote: String(p.quote).trim() }))
    .slice(0, MAX_PER_CHUNK);
}

export function checkProposal(p: ProposedEntry, chunk: string, accounts: Account[]): DropReason | null {
  const account = accounts.find((a) => a.id === p.account);
  if (account === undefined) return "unknown account";
  if (!(account.needs as readonly string[]).includes(p.need)) return "undeclared need";
  if (p.claim.length > MAX_CLAIM_CHARS) return "claim too long";
  // A guard against invented quotes, not a trust signal: whitespace and line
  // wraps are forgiven, wording is not.
  if (!normaliseSpace(chunk).includes(normaliseSpace(p.quote))) return "quote not in source";
  return null;
}

export async function runExtraction(
  file: NeedEvidenceFile,
  accounts: Account[],
  deps: ExtractDeps,
  options: { only?: string } = {},
): Promise<ExtractResult> {
  const result: ExtractResult = {
    file: { sources: { ...file.sources }, entries: file.entries.map((e) => ({ ...e })) },
    proposed: [],
    dropped: { "unknown account": 0, "undeclared need": 0, "claim too long": 0, "quote not in source": 0 },
    skippedDocs: 0,
    failedChunks: 0,
  };
  const known = new Set(result.file.entries.map((e) => e.id));

  for (const doc of deps.documents().filter((d) => options.only === undefined || d === options.only)) {
    const text = await deps.read(doc);
    const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
    if (result.file.sources[doc] === hash) {
      result.skippedDocs++;
      continue;
    }

    let docFailed = false;
    for (const [i, chunk] of chunkText(text).entries()) {
      let entries: ProposedEntry[] | null;
      try {
        entries = parseReply(await deps.complete(extractionPrompt(chunk, accounts)));
      } catch (err) {
        deps.log(`${doc} chunk ${i + 1}: model call failed: ${err instanceof Error ? err.message : String(err)}`);
        entries = null;
      }
      if (entries === null) {
        deps.log(`${doc} chunk ${i + 1}: skipped (no usable reply)`);
        result.failedChunks++;
        docFailed = true;
        continue;
      }
      for (const p of entries) {
        const reason = checkProposal(p, chunk, accounts);
        if (reason !== null) {
          result.dropped[reason]++;
          continue;
        }
        const id = entryId(p.account, p.need, p.quote);
        if (known.has(id)) continue; // the user's decision on it stays
        known.add(id);
        const entry: NeedEvidenceEntry = { id, status: "proposed", ...p, source: doc, extracted: deps.today() };
        result.file.entries.push(entry);
        result.proposed.push(entry);
      }
    }
    // A failed chunk leaves the document unrecorded, so the next run retries it.
    if (!docFailed) result.file.sources[doc] = hash;
  }
  return result;
}

export function statusReport(file: NeedEvidenceFile): string[] {
  const groups = new Map<string, Record<string, number>>();
  for (const e of file.entries) {
    const key = `${e.account} / ${e.need}`;
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
    for (const e of next) lines.push(`${e.id}  ${e.account} / ${e.need}  ${e.claim}  — "${e.quote}" (${e.source})`);
  }
  return lines;
}

export function legacyDocuments(names: string[]): string[] {
  return names
    .filter((n) => LEGACY_EXTENSIONS.some((ext) => n.toLowerCase().endsWith(ext)))
    .sort()
    .map((n) => `knowledge/${n}`);
}

export function parseExtractArgs(argv: string[]): ExtractArgs {
  const args: ExtractArgs = { dryRun: false, status: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--only") args.only = argv[++i];
    else if (flag === "--dry-run") args.dryRun = true;
    else if (flag === "--status") args.status = true;
    else throw new Error(`unknown option "${flag}"`);
  }
  return args;
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -- __tests__/need-evidence-extract.test.ts && npm run typecheck && npm run typecheck:tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/need-evidence-extract.ts __tests__/need-evidence-extract.test.ts
git commit -m "feat: resumable need-evidence extraction with checked proposals

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The CLI and the gitignore entry

**Files:**
- Create: `scripts/extract-need-evidence.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes (Tasks 1–2): `NEED_EVIDENCE_FILE`, `parseNeedEvidence`, `renderNeedEvidence`, `runExtraction`, `statusReport`, `legacyDocuments`, `parseExtractArgs`; `parseAccounts` (`graph-accounts.ts`); `parseFile` (`file-parser.ts`); `getLlmClient` (`llm-client.ts`).

The script is wiring only; its logic is tested in Tasks 1–2. It is exercised for real only in Task 6, after the user's yes.

- [ ] **Step 1: Write `scripts/extract-need-evidence.ts`**

```ts
// Propose need evidence from the legacy documents with the active stack's model.
//
// Usage:
//   npx tsx scripts/extract-need-evidence.ts [--only knowledge/<file>] [--dry-run]
//   npx tsx scripts/extract-need-evidence.ts --status      read-only review summary
//
// Writes only config/need-evidence.local.yaml (gitignored). Approve entries by
// changing their status; the next graph rebuild picks up approved ones.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFile } from "../src/services/file-parser.js";
import { parseAccounts } from "../src/services/graph-accounts.js";
import { getLlmClient } from "../src/services/llm-client.js";
import { NEED_EVIDENCE_FILE, parseNeedEvidence, renderNeedEvidence } from "../src/services/need-evidence.js";
import { legacyDocuments, parseExtractArgs, runExtraction, statusReport } from "../src/services/need-evidence-extract.js";

const root = process.cwd();
const args = parseExtractArgs(process.argv.slice(2));
const filePath = join(root, NEED_EVIDENCE_FILE);
const file = existsSync(filePath) ? parseNeedEvidence(readFileSync(filePath, "utf8")) : { sources: {}, entries: [] };

if (args.status) {
  for (const line of statusReport(file)) console.log(line);
  process.exit(0);
}

const accountsPath = join(root, "config", "accounts.local.yaml");
if (!existsSync(accountsPath)) {
  console.error("declare accounts first: copy config/accounts.example.yaml to config/accounts.local.yaml");
  process.exit(1);
}
const accounts = parseAccounts(readFileSync(accountsPath, "utf8"));

const llm = getLlmClient();
if (!(await llm.isReachable())) {
  console.error(`the active stack (${llm.stack.name}) is not reachable: start it before extracting`);
  process.exit(1);
}

const result = await runExtraction(file, accounts, {
  documents: () => legacyDocuments(readdirSync(join(root, "knowledge"))),
  read: (path) => parseFile(join(root, path)),
  complete: (prompt) => llm.chat([{ role: "user", content: prompt }], { temperature: 0.1 }),
  today: () => new Date().toISOString().slice(0, 10),
  log: (line) => console.log(line),
}, { only: args.only });

for (const e of result.proposed) console.log(`+ ${e.id}  ${e.account} / ${e.need}  ${e.claim}  — "${e.quote}" (${e.source})`);
const dropped = Object.entries(result.dropped).filter(([, n]) => n > 0).map(([reason, n]) => `${n} ${reason}`);
console.log(
  `\n${result.proposed.length} proposed, ${result.skippedDocs} unchanged documents skipped, ` +
    `${result.failedChunks} chunks failed${dropped.length > 0 ? `, dropped: ${dropped.join(", ")}` : ""}`,
);

if (args.dryRun) {
  console.log("DRY RUN: nothing written");
} else {
  writeFileSync(filePath, renderNeedEvidence(result.file));
  console.log(`written: ${NEED_EVIDENCE_FILE} (approve entries by changing their status)`);
}
```


- [ ] **Step 2: Gitignore the file**

In `.gitignore`, add below `config/accounts.local.yaml`:

```
config/need-evidence.local.yaml
```

- [ ] **Step 3: Typecheck and a no-model smoke run**

Run: `npm run typecheck && npx tsx scripts/extract-need-evidence.ts --status && npx tsx scripts/extract-need-evidence.ts --nope; echo "exit $?"`
Expected: typecheck clean; `--status` prints nothing (no file yet in the worktree) and exits 0; `--nope` exits non-zero with `unknown option "--nope"`. These make no model call.

- [ ] **Step 4: Commit**

```bash
git add scripts/extract-need-evidence.ts .gitignore
git commit -m "feat: extract-need-evidence CLI; proposals file gitignored

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The rebuild reads approved entries; watchlist evidence gets a kind

**Files:**
- Modify: `src/services/vendor-graph-rebuild.ts` (`collectVendorGraphFacts`)
- Modify: `src/services/graph-evidence.ts` (Evidence properties)
- Test: `__tests__/vendor-graph-rebuild.test.ts`, `__tests__/graph-evidence.test.ts`

**Interfaces:**
- Consumes (Task 1): `parseNeedEvidence`, `checkAgainstAccounts`, `needEvidenceToGraphFacts`.
- Produces: rebuild batch includes reference Evidence; report line from Task 1 or `need-evidence.local.yaml     -> skipped (no such file)`; watchlist Evidence property `kind: "watchlist"`.

- [ ] **Step 1: Write the failing tests**

In `__tests__/graph-evidence.test.ts`, in the expected Evidence `properties` of "writes one Evidence node and one SUPPORTS edge per graph entity", add `kind: "watchlist",` as the first property.

Append to `__tests__/vendor-graph-rebuild.test.ts`:

```ts
describe("collectVendorGraphFacts — need evidence", () => {
  const NEED_EVIDENCE = `entries:
  - id: ne-000001
    status: approved
    account: roche
    need: cyber-resilience
    claim: Ransomware halted a peer for weeks
    quote: Operations were disrupted for weeks.
    source: knowledge/a.md
    extracted: 2026-10-02
  - id: ne-000002
    status: proposed
    account: roche
    need: cyber-resilience
    claim: Another
    quote: Another quote.
    source: knowledge/a.md
    extracted: 2026-10-02
`;

  it("writes approved entries as reference Evidence and reports the file", () => {
    const { batch, lines } = collectVendorGraphFacts(files({ ...ALL, "/repo/config/need-evidence.local.yaml": NEED_EVIDENCE }));
    const ids = batch.flatMap((f) => f.nodes.filter((n) => n.label === "Evidence").map((n) => n.id));
    expect(ids).toEqual(["ne-000001"]);
    expect(lines).toContain("need-evidence.local.yaml     -> 1 approved (roche 1), 1 proposed, 0 rejected");
  });

  it("skips and reports a missing file", () => {
    expect(collectVendorGraphFacts(files(ALL)).lines).toContain("need-evidence.local.yaml     -> skipped (no such file)");
  });

  it("fails before the wipe on an approved entry for a need the account does not declare", async () => {
    const rec = recordingTransaction();
    const stale = NEED_EVIDENCE.replace("need: cyber-resilience", "need: data-sovereignty");
    await expect(
      rebuildVendorGraph(files({ ...ALL, "/repo/config/need-evidence.local.yaml": stale }), rec.tx),
    ).rejects.toThrow("need-evidence.local.yaml: roche no longer declares data-sovereignty: reject or re-approve ne-000001");
    expect(rec.calls).toBe(0);
  });

  it("fails before the wipe on a file that is not valid YAML, naming it", async () => {
    const rec = recordingTransaction();
    await expect(
      rebuildVendorGraph(files({ ...ALL, "/repo/config/need-evidence.local.yaml": "entries: [\n  - id: x" }), rec.tx),
    ).rejects.toThrow(/^need-evidence\.local\.yaml: /);
    expect(rec.calls).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- __tests__/vendor-graph-rebuild.test.ts __tests__/graph-evidence.test.ts`
Expected: FAIL (no `kind`; no need-evidence source).

- [ ] **Step 3: Implement**

In `src/services/graph-evidence.ts`, add as the first entry of the Evidence node's `properties`:

```ts
        // Tells news apart from reference evidence (need-evidence.ts) on the same label.
        kind: "watchlist",
```

In `src/services/vendor-graph-rebuild.ts`, add the import:

```ts
import { checkAgainstAccounts, needEvidenceToGraphFacts, parseNeedEvidence } from "./need-evidence.js";
```

and change `import { accountToGraphFacts, needsMapToGraphFacts, parseAccounts, parseNeedsMap } from "./graph-accounts.js";` to also import `type Account`. In `collectVendorGraphFacts`, capture the parsed accounts: change the accounts source's callback from `parseAccounts(text).map((account) => {` to:

```ts
      (accounts = parseAccounts(text)).map((account) => {
```

declaring `let accounts: Account[] = [];` just before that `batch.push(`. Then, after that `batch.push(…)` for the accounts and before `if (sources.evidence !== undefined) {`, add:

```ts
  batch.push(
    ...optionalSource(
      "need-evidence.local.yaml",
      join(sources.root, "config", "need-evidence.local.yaml"),
      readFile,
      lines,
      (text) => {
        // Approved entries only; a decision that no longer matches the accounts
        // file fails here, before the wipe, rather than being dropped.
        const file = parseNeedEvidence(text);
        checkAgainstAccounts(file, accounts);
        const { facts, line } = needEvidenceToGraphFacts(file);
        lines.push(line);
        return [facts];
      },
    ),
  );
```

Update the header's source list to name `config/need-evidence.local.yaml` (approved need evidence) as the fifth source.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -- __tests__/vendor-graph-rebuild.test.ts __tests__/graph-evidence.test.ts __tests__/watchlist-cli.test.ts && npm run typecheck && npm run typecheck:tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/vendor-graph-rebuild.ts src/services/graph-evidence.ts __tests__/vendor-graph-rebuild.test.ts __tests__/graph-evidence.test.ts
git commit -m "feat: graph rebuild writes approved need evidence; watchlist evidence gets a kind

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The answer shows `needEvidence` and keeps it out of news

**Files:**
- Modify: `src/services/competitive-graph.ts`
- Test: `__tests__/competitive-graph.test.ts`, `__tests__/graph-routes.test.ts`, `__tests__/chat-graph-context.test.ts` (fakes and fixture)

**Interfaces:**
- Consumes (Task 4): reference Evidence with `kind`, `claim`, `quote`, `source`, `order`; `SUPPORTS.need`.
- Produces: `NEED_EVIDENCE_CYPHER` (params `{accounts: string[]}`, rows `{account, need, claim, quote, source}` ordered by `order`); `NEED_EVIDENCE_PER_NEED = 3`; `interface NeedEvidenceItem { claim: string; quote: string; source: string }`; `AnswerAccount.needEvidence: Record<string, NeedEvidenceItem[]>`; trim steps "need-evidence quotes" and "need evidence" after "claim details".

- [ ] **Step 1: Update fakes and write the failing tests**

In `__tests__/competitive-graph.test.ts`:
- import `NEED_EVIDENCE_CYPHER`, `NEED_EVIDENCE_PER_NEED`, `ACCOUNT_EVIDENCE_CYPHER` and `VENDOR_EVIDENCE_CYPHER` (the last two are already imported);
- add `needEvidence?: Array<Record<string, unknown>>;` to `Rows` and, in `fakeCypher`, before the throw: `if (query === NEED_EVIDENCE_CYPHER) return rows.needEvidence ?? [];`
- add in `describe("competitivePosition", …)`:

```ts
  function needRow(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
    return { account: "roche", need: "cyber-resilience", claim: `Claim ${n}`, quote: `Quote ${n}.`, source: "knowledge/a.md", ...over };
  }

  it("shows up to three approved reasons per declared need, in file order", async () => {
    const rows: Rows = { ...ROWS, needEvidence: [1, 2, 3, 4].map((n) => needRow(n)) };
    const result = await competitivePosition(deps({ runCypher: fakeCypher(rows) }), { account: "roche" });
    if (!result.ok) throw new Error(result.error);
    expect(result.answer.accounts[0].needEvidence).toEqual({
      "cyber-resilience": [1, 2, 3].map((n) => ({ claim: `Claim ${n}`, quote: `Quote ${n}.`, source: "knowledge/a.md" })),
    });
    expect(NEED_EVIDENCE_PER_NEED).toBe(3);
  });

  it("leaves out a need without approved reasons, and a need the account does not declare, with no note", async () => {
    const rows: Rows = { ...ROWS, needEvidence: [needRow(1, { need: "sustainability" })] };
    const result = await competitivePosition(deps({ runCypher: fakeCypher(rows) }), { account: "roche" });
    if (!result.ok) throw new Error(result.error);
    expect(result.answer.accounts[0].needEvidence).toEqual({});
    expect(result.answer.notes.some((n) => n.includes("need evidence"))).toBe(false);
  });

  it("reads only watchlist evidence as news, also on a graph built before kind existed", () => {
    for (const query of [ACCOUNT_EVIDENCE_CYPHER, VENDOR_EVIDENCE_CYPHER]) {
      expect(query).toContain('coalesce(e.kind, "watchlist") = "watchlist"');
    }
    expect(NEED_EVIDENCE_CYPHER).toContain('kind: "reference"');
  });
```

- in `describe("competitivePosition — size budget", …)` add:

```ts
  it("drops need-evidence quotes, then need evidence, before claims", async () => {
    const rows: Rows = {
      ...ROWS,
      needEvidence: [1, 2, 3].map((n) => ({
        account: "roche",
        need: "cyber-resilience",
        claim: `Claim ${n}`,
        quote: "Q".repeat(400),
        source: "knowledge/a.md",
      })),
    };
    const result = await competitivePosition(deps({ runCypher: fakeCypher(rows) }), { account: "roche" });
    if (!result.ok) throw new Error(result.error);
    const answer = result.answer;
    fitBudget(answer, JSON.stringify(answer).length - 10);
    const reasons = answer.accounts[0].needEvidence["cyber-resilience"];
    expect(reasons.map((r) => r.quote)).toEqual(["", "", ""]);
    expect(reasons.map((r) => r.claim)).toEqual(["Claim 1", "Claim 2", "Claim 3"]);
    expect(answer.notes.some((n) => n.includes("need-evidence quotes"))).toBe(true);
  });
```

In `__tests__/graph-routes.test.ts` and `__tests__/chat-graph-context.test.ts`, import `NEED_EVIDENCE_CYPHER` and extend the existing evidence line in each fake to `if (query === ACCOUNT_EVIDENCE_CYPHER || query === VENDOR_EVIDENCE_CYPHER || query === NEED_EVIDENCE_CYPHER) return [];`. In `chat-graph-context.test.ts`'s `answer()` fixture, add `needEvidence: {},` after `general: [],`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- __tests__/competitive-graph.test.ts`
Expected: FAIL (`NEED_EVIDENCE_CYPHER` not exported).

- [ ] **Step 3: Implement in `src/services/competitive-graph.ts`**

Change the two news queries:

```ts
export const ACCOUNT_EVIDENCE_CYPHER = `
  MATCH (e:Evidence)-[s:SUPPORTS]->(a:Account)
  WHERE a.id IN $accounts AND coalesce(e.kind, "watchlist") = "watchlist"
  RETURN a.id AS account, s.segments AS segments, e.title AS title, e.url AS url,
         e.publishedAt AS publishedAt, e.signal AS signal
  ORDER BY publishedAt DESC, url
`;

export const VENDOR_EVIDENCE_CYPHER = `
  MATCH (e:Evidence)-[s:SUPPORTS]->(v:Vendor {id: $vendor})
  WHERE coalesce(e.kind, "watchlist") = "watchlist" AND any(segment IN s.segments WHERE segment IN $segments)
  RETURN e.title AS title, e.url AS url, e.publishedAt AS publishedAt, e.signal AS signal
  ORDER BY publishedAt DESC, url
`;

/** Approved reasons why an account has a need (need-evidence.ts), in the file's order. */
export const NEED_EVIDENCE_CYPHER = `
  MATCH (e:Evidence {kind: "reference"})-[s:SUPPORTS]->(a:Account)
  WHERE a.id IN $accounts
  RETURN a.id AS account, s.need AS need, e.claim AS claim, e.quote AS quote, e.source AS source
  ORDER BY e.order
`;
```

Add next to `GENERAL_PER_ACCOUNT`:

```ts
export const NEED_EVIDENCE_PER_NEED = 3;
```

Add after `AnswerSegment`:

```ts
export interface NeedEvidenceItem {
  claim: string;
  quote: string;
  source: string;
}
```

and add to `AnswerAccount` after `general`:

```ts
  /** The user's approved reasons why the account has each need; needs without one are absent. */
  needEvidence: Record<string, NeedEvidenceItem[]>;
```

Add below `readAccountEvidence`:

```ts
async function readNeedEvidence(runCypher: RunCypher, accounts: string[]): Promise<Map<string, Map<string, NeedEvidenceItem[]>>> {
  const byAccount = new Map<string, Map<string, NeedEvidenceItem[]>>();
  if (accounts.length === 0) return byAccount;
  for (const row of await runCypher(NEED_EVIDENCE_CYPHER, { accounts })) {
    const account = str(row.account, "account");
    const need = str(row.need, "need");
    const needs = byAccount.get(account) ?? new Map<string, NeedEvidenceItem[]>();
    needs.set(need, [
      ...(needs.get(need) ?? []),
      { claim: str(row.claim, "claim"), quote: str(row.quote, "quote"), source: str(row.source, "source") },
    ]);
    byAccount.set(account, needs);
  }
  return byAccount;
}
```

In `TRIM_STEPS`, insert after the "claim details" step:

```ts
  {
    drops: "need-evidence quotes",
    applies: (a) => a.accounts.some((acc) => Object.values(acc.needEvidence).some((list) => list.some((e) => e.quote !== ""))),
    apply: (a) => {
      for (const acc of a.accounts) for (const list of Object.values(acc.needEvidence)) for (const e of list) e.quote = "";
    },
  },
  {
    drops: "need evidence",
    applies: (a) => a.accounts.some((acc) => Object.keys(acc.needEvidence).length > 0),
    apply: (a) => {
      for (const acc of a.accounts) acc.needEvidence = {};
    },
  },
```

In `competitivePositionFrom`, after `const events = await readAccountEvidence(…);`, add:

```ts
  const reasons = await readNeedEvidence(
    deps.runCypher,
    r.accounts.map((a) => a.account),
  );
```

and in the `accounts` map, add after the `general:` property:

```ts
      needEvidence: Object.fromEntries(
        account.needs
          .map((need): [string, NeedEvidenceItem[]] => [need, (reasons.get(account.account)?.get(need) ?? []).slice(0, NEED_EVIDENCE_PER_NEED)])
          .filter(([, list]) => list.length > 0),
      ),
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -- __tests__/competitive-graph.test.ts __tests__/competitive-position.test.ts __tests__/graph-routes.test.ts __tests__/chat-graph-context.test.ts && npm run typecheck && npm run typecheck:tests`
Expected: PASS, including the existing `fitBudget` order and full-graph budget tests (the new steps are skipped when there is no need evidence).

- [ ] **Step 5: Commit**

```bash
git add src/services/competitive-graph.ts __tests__/competitive-graph.test.ts __tests__/graph-routes.test.ts __tests__/chat-graph-context.test.ts
git commit -m "feat: competitive_position shows approved need evidence, kept apart from news

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Chat line, MCP, docs and verification

**Files:**
- Modify: `src/services/chat-graph-context.ts` (`renderLines`)
- Modify: `mcp/src/tools/graph.ts`, `CLAUDE.md`
- Test: `__tests__/chat-graph-context.test.ts`

- [ ] **Step 1: Write the failing test**

Add inside `describe("renderCompetitiveContext", …)`:

```ts
  it("gives each justified need a why line under the account, without the quote", () => {
    const base = answer();
    base.accounts[0].needEvidence = {
      "cyber-resilience": [{ claim: "Ransomware halted a peer for weeks", quote: "Long quote.", source: "knowledge/cyber-pharma-major-attacks.md" }],
    };
    const text = renderCompetitiveContext(base);
    expect(text).toContain(
      "Roche (roche), needs: cyber-resilience\n  why cyber-resilience: Ransomware halted a peer for weeks (cyber-pharma-major-attacks.md)",
    );
    expect(text).not.toContain("Long quote.");
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- __tests__/chat-graph-context.test.ts -t "why line"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/services/chat-graph-context.ts`, add `import { basename } from "node:path";` and, right after the line pushing `${account.name} (${account.account}), needs: …`, add:

```ts
    for (const [need, reasons] of Object.entries(account.needEvidence)) {
      for (const e of reasons) lines.push(`  why ${need}: ${e.claim} (${basename(e.source)})`);
    }
```

In `mcp/src/tools/graph.ts`, add to the `competitive_position` description, before `"Rank vendors only as` (keep the string concatenation style):

```ts
        "`needEvidence` holds the user's approved reasons why each account has a need, with the quote and source " +
        "document. " +
```

In `CLAUDE.md`, in the Retrieval bullet after the ranking sentence, add:

```
  Approved need evidence (`need-evidence.ts`, proposed by `scripts/extract-need-evidence.ts` with the 27B into the
  gitignored `config/need-evidence.local.yaml`, approved by editing `status`) is the rebuild's fifth source:
  `Evidence {kind: "reference"}`, shown as `needEvidence`; news queries read only `kind: "watchlist"`.
```

and add the command to the Commands block:

```
npx tsx scripts/extract-need-evidence.ts [--only knowledge/<f>] [--dry-run] | --status   # 27B proposes need evidence; approve in config/need-evidence.local.yaml
```

- [ ] **Step 4: Full verification**

Run: `npm run typecheck && npm run typecheck:tests && npm test && npm --prefix mcp test && npm --prefix mcp run typecheck`
Expected: all pass. Record the totals. Then, read-only from the main checkout: `npx tsx .worktrees/need-evidence/scripts/rebuild-vendor-graph.ts` shows `need-evidence.local.yaml -> skipped (no such file)` and writes nothing.

- [ ] **Step 5: Commit**

```bash
git add src/services/chat-graph-context.ts __tests__/chat-graph-context.test.ts mcp/src/tools/graph.ts CLAUDE.md
git commit -m "feat: chat shows why each account has a need; MCP and docs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Ask before the first real model call**

Ask: "Run a one-document extraction dry run (`--dry-run --only knowledge/cyber-pharma-major-attacks.md`, 1–2 calls on the active stack, nothing written)?" Only on a yes, run it from the main checkout (`cd /Users/seb/claude/PharmaLLM && npx tsx .worktrees/need-evidence/scripts/extract-need-evidence.ts --dry-run --only knowledge/cyber-pharma-major-attacks.md`) and show the proposals. Then ask separately before the full extraction (~40 calls, ~30 min, writes only `config/need-evidence.local.yaml`). No live rebuild in this plan: that waits until the user has approved entries.

- [ ] **Step 7: Push and PR**

```bash
git push -u origin feature/need-evidence
gh pr create --base feature/vendor-ranking --title "feat: need evidence from the legacy documents" --body-file /tmp/claude-rank/pr-need.md
```

Write the PR body first: What (extraction script, proposals file and approval, fifth rebuild source, `needEvidence`, `kind` separation), test totals, dry-run results, rulings, final line `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Retarget to `main` after #64–#66 merge.
