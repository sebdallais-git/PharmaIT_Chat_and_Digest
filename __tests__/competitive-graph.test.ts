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
    recentItems: () => [{ title: "Dell ships PowerMax 9", url: "https://example.test/n", publishedAt: "2026-09-28" }],
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

  it("reads an account from a graph built before declaredSegments existed as declaring nothing", async () => {
    // Until the operator rebuilds, every incumbent-less segment reads unknown:
    // the honest default, never greenfield.
    const legacy = { ...ROWS.accounts[0] };
    delete legacy.declaredSegments;
    const snap = await readGraphSnapshot(fakeCypher({ ...ROWS, accounts: [legacy] }), {});
    expect(snap.accounts[0].declared).toEqual([]);
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
