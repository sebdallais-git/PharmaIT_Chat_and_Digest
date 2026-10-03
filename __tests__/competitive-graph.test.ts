import { describe, expect, it } from "@jest/globals";
import {
  ACCOUNT_EVIDENCE_CYPHER,
  ACCOUNTS_CYPHER,
  NEED_EVIDENCE_CYPHER,
  NEED_EVIDENCE_PER_NEED,
  EVENTS_PER_SEGMENT,
  MAX_ANSWER_CHARS,
  NEED_SEGMENTS_CYPHER,
  POSITIONS_CYPHER,
  VENDOR_EVIDENCE_CYPHER,
  EVIDENCE_PER_VENDOR,
  VENDORS_CYPHER,
  competitivePosition,
  fitBudget,
  readGraphSnapshot,
  type CompetitiveAnswer,
  type CompetitiveDeps,
  type RunCypher,
} from "../src/services/competitive-graph.js";
import { REGIME_GUIDANCE } from "../src/services/competitive-position.js";
import { SEGMENTS } from "../src/services/graph-schema.js";
import type { BriefExcerpt } from "../src/services/vendor-brief-excerpts.js";

interface Rows {
  accounts: Array<Record<string, unknown>>;
  needs: Array<Record<string, unknown>>;
  positions: Array<Record<string, unknown>>;
  vendors: Array<Record<string, unknown>>;
  /** Rows for ACCOUNT_EVIDENCE_CYPHER; absent = a graph with no Evidence yet. */
  accountEvidence?: Array<Record<string, unknown>>;
  /** Rows for VENDOR_EVIDENCE_CYPHER, by vendor id. */
  vendorEvidence?: Record<string, Array<Record<string, unknown>>>;
  needEvidence?: Array<Record<string, unknown>>;
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
    if (query === NEED_EVIDENCE_CYPHER) return rows.needEvidence ?? [];
    throw new Error(`unexpected query: ${query}`);
  };
}

const ROWS: Rows = {
  accounts: [
    {
      id: "roche",
      name: "Roche",
      aliases: "Genentech,Chugai",
      declaredSegments: "storage-block",
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
    briefs: () => ({ excerpts: new Map([["dell/storage-block", excerpt("dell", "storage-block")]]), errors: [] }),
    vendorAliases: () => ({ "dell-technologies": "dell" }),
    ...overrides,
  };
}

describe("readGraphSnapshot", () => {
  it("turns rows into a snapshot, splitting the comma-joined aliases and declared segments", async () => {
    const snap = await readGraphSnapshot(fakeCypher(ROWS), { x: "dell" });
    expect(snap).toEqual({
      accounts: [
        {
          id: "roche",
          name: "Roche",
          aliases: ["Genentech", "Chugai"],
          declared: ["storage-block"],
          needs: ["cyber-resilience"],
          uses: [{ segment: "storage-block", vendor: "dell", since: "", until: "", source: "declared" }],
          triggers: {},
          historyConflicts: [],
        },
      ],
      needSegments: { "cyber-resilience": ["data-protection", "storage-block"] },
      positions: [
        { vendor: "dell", segment: "storage-block", position: "leader", confidence: "high", rationale: "PowerMax.", asOf: "2026-09-21" },
      ],
      vendors: ["dell", "hpe"],
      vendorAliases: { x: "dell" },
      notes: [],
    });
  });

  it("reads an account from a graph built before declaredSegments existed as declaring nothing", async () => {
    // Until the operator rebuilds, every incumbent-less segment reads unknown:
    // the honest default, never greenfield.
    const legacy = { ...ROWS.accounts[0] };
    delete legacy.declaredSegments;
    const snap = await readGraphSnapshot(fakeCypher({ ...ROWS, accounts: [legacy] }), {});
    expect(snap.accounts[0].declared).toEqual([]);
  });

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
    expect(Object.keys(result.answer.modes).sort()).toEqual(["defend", "unknown"]);
    expect(result.answer.modes.unknown).toBe(
      "who is installed here is not recorded: find out before choosing defend, displace or greenfield",
    );
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

  // Review of #65: the read had no LIMIT, inside the chat's 2.5 s graph budget
  it("bounds the vendor news read in the query itself", () => {
    expect(VENDOR_EVIDENCE_CYPHER).toMatch(new RegExp(`ORDER BY publishedAt DESC, url\\s+LIMIT ${EVIDENCE_PER_VENDOR}\\s*$`));
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

  it("explains the regimes its segments use", async () => {
    const result = await competitivePosition(deps(), { account: "roche" });
    if (!result.ok) throw new Error(result.error);
    expect(result.answer.regimes).toEqual({ unknown: REGIME_GUIDANCE.unknown, defend: REGIME_GUIDANCE.defend });
  });

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

  it("passes the resolver's error through", async () => {
    expect(await competitivePosition(deps(), {})).toEqual({
      ok: false,
      error: "give at least one of vendor, account or segment",
    });
  });
});

describe("competitivePosition — size budget", () => {
  // Eight vendors briefed in every segment, three accounts with every need and
  // two brief-less incumbents in every segment, real-length source URLs: far
  // bigger than today's graph, the shape it grows into.
  const vendors = ["dell", "hpe", "everpure", "netapp", "ibm", "huawei", "vast-data", "nutanix"];
  const unbriefed = ["cisco", "lenovo"];
  const sources = Array.from({ length: 4 }, (_, i) => `https://www.example-analyst.test/research/2026/09/storage-market-report-${i}.html`);
  function bigRows(accountCount: number): Rows {
    return {
      accounts: Array.from({ length: accountCount }, (_, i) => ["roche", "novartis", "sandoz"][i] ?? `account-${i}`).map((id) => ({
        id,
        name: id,
        aliases: "",
        declaredSegments: SEGMENTS.join(","),
        needs: ["n"],
        uses: SEGMENTS.flatMap((segment) => unbriefed.map((vendor) => ({ segment, vendor }))),
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
      vendors: [...vendors, ...unbriefed].map((id) => ({ id })),
    };
  }
  const bigBriefs = new Map(
    vendors.flatMap((v) =>
      SEGMENTS.map((s) => [`${v}/${s}`, { ...excerpt(v, s, 4, "d".repeat(240)), sources }] as const),
    ),
  );
  const bigDeps = (accountCount = 3): CompetitiveDeps =>
    deps({
      runCypher: fakeCypher(bigRows(accountCount)),
      briefs: () => ({ excerpts: bigBriefs, errors: [] }),
    });

  it.each([
    ["vendor", { vendor: "dell" }],
    ["account", { account: "roche" }],
    ["segment", { segment: "storage-block" }],
  ])("keeps a full-graph %s-only answer under the budget, and says it trimmed", async (_label, query) => {
    const result = await competitivePosition(bigDeps(), query);
    if (!result.ok) throw new Error(result.error);
    expect(JSON.stringify(result.answer).length).toBeLessThanOrEqual(MAX_ANSWER_CHARS);
    expect(result.answer.notes.some((n) => n.startsWith("trimmed to fit the answer budget"))).toBe(true);
    expect(result.answer.notes.some((n) => n.startsWith("the answer is still over budget"))).toBe(false);
    // Rankings are structure: present on every segment, never trimmed.
    expect(result.answer.accounts.every((a) => a.segments.every((s) => s.ranking !== undefined && s.ranked >= 0))).toBe(true);
  });

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

  // Review of #70: the step kept the current stint (sorted first) rather than the
  // newest change, and left olderChanges counting only the window
  it("keeps the newest change when trimming history, and counts what it dropped as older", async () => {
    const rows: Rows = {
      ...ROWS,
      accounts: [
        {
          ...ROWS.accounts[0],
          uses: [
            { segment: "storage-block", vendor: "hpe", since: "2019", until: "", source: "declared" },
            { segment: "storage-block", vendor: "dell", since: "2020", until: "2026-03", source: "declared" },
            ...[1, 2].map((n) => ({ segment: "storage-block", vendor: `v${n}${"x".repeat(200)}`, since: "2015", until: "2018", source: "declared" })),
          ],
        },
      ],
    };
    const result = await competitivePosition(deps({ runCypher: fakeCypher(rows) }), { account: "roche", history: "full" });
    if (!result.ok) throw new Error(result.error);
    const answer = result.answer;
    fitBudget(answer, JSON.stringify(answer).length - 10);
    const block = answer.accounts[0].segments.find((s) => s.segment === "storage-block");
    expect(block?.history?.map((h) => h.vendor)).toEqual(["dell"]);
    expect(block?.olderChanges).toBe(3);
  });

  it("drops claim details before it drops claims", async () => {
    // One account: rankings on all 33 segments of a vendor-only question take
    // ~6k, so that answer needs more than the first step; this one needs it alone.
    const result = await competitivePosition(bigDeps(), { vendor: "dell", account: "roche" });
    if (!result.ok) throw new Error(result.error);
    const standing = result.answer.standings["dell/storage-block"];
    expect(standing.strong.length).toBeGreaterThan(0);
    expect(standing.strong.every((c) => c.detail === "")).toBe(true);
  });

  it("keeps positions, confidence and dates even at the last step", async () => {
    const result = await competitivePosition(bigDeps(), { account: "roche" });
    if (!result.ok) throw new Error(result.error);
    expect(result.answer.standings["dell/storage-block"]).toEqual({
      position: "strong",
      confidence: "medium",
      asOf: "2026-09-21",
      curated: true,
      strong: [],
      weak: [],
      sources: [],
    });
    expect(result.answer.accounts[0].segments).toHaveLength(SEGMENTS.length);
  });

  it("says the answer is still over budget when even the last step cannot fit it", async () => {
    // Forty accounts on one segment: the per-account structure alone is over budget.
    const result = await competitivePosition(bigDeps(40), { segment: "storage-block" });
    if (!result.ok) throw new Error(result.error);
    expect(JSON.stringify(result.answer).length).toBeGreaterThan(MAX_ANSWER_CHARS);
    expect(result.answer.notes).toContain("the answer is still over budget: narrow the question by vendor or account");
  });

  it("leaves a small answer untouched", async () => {
    const result = await competitivePosition(deps(), { vendor: "dell" });
    if (!result.ok) throw new Error(result.error);
    expect(result.answer.standings["dell/storage-block"].strong[0].detail).toBe("detail");
    expect(result.answer.notes.some((n) => n.startsWith("trimmed"))).toBe(false);
  });
});

describe("fitBudget", () => {
  const STEPS = [
    "claim details",
    "claims",
    "rationale beyond 200 characters",
    "rationale, and sources beyond 2 per standing",
    "sources",
  ];
  const RATIONALE = "r".repeat(545);

  function answer(query: Partial<CompetitiveAnswer["query"]> = { vendor: "dell" }): CompetitiveAnswer {
    const claims = () => Array.from({ length: 4 }, (_, i) => ({ claim: `Claim ${i}.`, detail: "d".repeat(240) }));
    const standing = () => ({
      position: "strong",
      confidence: "medium",
      rationale: RATIONALE,
      asOf: "2026-09-21",
      curated: true,
      strong: claims(),
      weak: claims(),
      sources: ["https://example.test/a", "https://example.test/b", "https://example.test/c", "https://example.test/d"],
    });
    return {
      query: { vendor: null, account: null, segment: null, history: "recent" as const, ...query },
      modes: {},
      regimes: {},
      market: [],
      accounts: [],
      standings: { "dell/storage-block": standing(), "dell/storage-file": standing() },
      evidence: {},
      notes: [],
    };
  }

  /** How many steps the standing's state shows were applied. */
  function stepsApplied(a: CompetitiveAnswer): number {
    const s = a.standings["dell/storage-block"];
    if (s.sources.length === 0) return 5;
    if (s.rationale === undefined) return 4;
    if (s.rationale.length < RATIONALE.length) return 3;
    if (s.strong.length === 0) return 2;
    if (s.strong.every((c) => c.detail === "")) return 1;
    return 0;
  }

  it("drops claim details, then claims, then rationale length, then rationale and extra sources, then sources", () => {
    const seen = new Set<number>();
    const full = JSON.stringify(answer()).length;
    for (let budget = full + 50; budget >= 0; budget -= 20) {
      const a = answer();
      fitBudget(a, budget);
      const n = stepsApplied(a);
      seen.add(n);
      const s = a.standings["dell/storage-block"];

      // Each step implies all the earlier ones, and the note names exactly those.
      if (n >= 1) expect([...s.strong, ...s.weak].every((c) => c.detail === "")).toBe(true);
      if (n === 3) expect(s.rationale?.length).toBeLessThanOrEqual(201);
      if (n === 4) expect(s.sources).toHaveLength(2);
      expect(a.notes.filter((note) => note.startsWith("trimmed"))).toEqual(
        n === 0 ? [] : [`trimmed to fit the answer budget, left out: ${STEPS.slice(0, n).join("; ")}. Narrow by account or segment for the full detail`],
      );
      const over = JSON.stringify(a).length > budget;
      expect(a.notes.includes("the answer is still over budget: narrow the question by account or segment")).toBe(over);
      if (over) expect(n).toBe(5);
    }
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it.each([
    [{ vendor: "dell" }, "account or segment"],
    [{ account: "roche" }, "vendor or segment"],
    [{ segment: "storage-block" }, "vendor or account"],
    [{ vendor: "dell", account: "roche" }, "segment"],
  ])("words its advice from what the query leaves open: %j -> %s", (query, advice) => {
    const trimmed = answer(query);
    fitBudget(trimmed, JSON.stringify(trimmed).length - 1);
    expect(trimmed.notes).toEqual([`trimmed to fit the answer budget, left out: claim details. Narrow by ${advice} for the full detail`]);

    const over = answer(query);
    fitBudget(over, 0);
    expect(over.notes).toContain(`the answer is still over budget: narrow the question by ${advice}`);
  });

  it("gives no narrowing advice when vendor, account and segment are all set", () => {
    const query = { vendor: "dell", account: "roche", segment: "storage-block" };
    const trimmed = answer(query);
    fitBudget(trimmed, JSON.stringify(trimmed).length - 1);
    expect(trimmed.notes).toEqual(["trimmed to fit the answer budget, left out: claim details"]);

    const over = answer(query);
    fitBudget(over, 0);
    expect(over.notes).toEqual([
      `trimmed to fit the answer budget, left out: ${STEPS.join("; ")}`,
      "the answer is still over budget even for one vendor, account and segment",
    ]);
  });
});
