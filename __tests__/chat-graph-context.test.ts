import { describe, expect, it } from "@jest/globals";
import {
  CHAT_CONTEXT_CHARS,
  chatGraphContext,
  matchCompetitiveQuery,
  renderCompetitiveContext,
  type ChatGraphDeps,
} from "../src/services/chat-graph-context.js";
import {
  ACCOUNT_EVIDENCE_CYPHER,
  ACCOUNTS_CYPHER,
  NEED_SEGMENTS_CYPHER,
  POSITIONS_CYPHER,
  VENDOR_EVIDENCE_CYPHER,
  VENDORS_CYPHER,
  type CompetitiveAnswer,
  type CompetitiveDeps,
  type RunCypher,
} from "../src/services/competitive-graph.js";
import type { GraphSnapshot } from "../src/services/competitive-position.js";

const SNAPSHOT: GraphSnapshot = {
  accounts: [
    { id: "roche", name: "Roche", aliases: ["Genentech", "Roche Diagnostics"], needs: [], declared: [], uses: [] },
    { id: "novartis", name: "Novartis", aliases: ["Sandoz"], needs: [], declared: [], uses: [] },
  ],
  needSegments: {},
  // snowflake is in the graph only as an incumbent: no brief places it anywhere.
  positions: [
    { vendor: "dell", segment: "storage-block", position: "leader", confidence: "high", rationale: "", asOf: "2026-09-21" },
    { vendor: "hpe", segment: "storage-block", position: "strong", confidence: "high", rationale: "", asOf: "2026-09-21" },
    { vendor: "everpure", segment: "storage-block", position: "strong", confidence: "high", rationale: "", asOf: "2026-09-21" },
  ],
  vendors: ["dell", "hpe", "everpure", "snowflake"],
  // Watchlist aliases cover every entity, customers included; only those that
  // point at a graph vendor may count as a vendor mention.
  vendorAliases: { "dell-technologies": "dell", "pure-storage": "everpure", roche: "roche" },
};

describe("matchCompetitiveQuery", () => {
  it("finds a vendor by id and an account by alias", () => {
    expect(matchCompetitiveQuery("How is Dell placed at Genentech?", SNAPSHOT)).toEqual({ vendor: "dell", account: "roche" });
  });

  it("finds a multi-word vendor alias across punctuation and case", () => {
    expect(matchCompetitiveQuery("what about pure storage's roadmap?", SNAPSHOT)).toEqual({ vendor: "everpure" });
  });

  it("matches whole words only", () => {
    expect(matchCompetitiveQuery("Dellwood and Rochester news", SNAPSHOT)).toBeNull();
  });

  it("does not read a customer alias as a vendor", () => {
    expect(matchCompetitiveQuery("Roche news this week", SNAPSHOT)).toEqual({ account: "roche" });
  });

  it("counts two names of one account as one account", () => {
    expect(matchCompetitiveQuery("Roche and Roche Diagnostics storage", SNAPSHOT)).toEqual({ account: "roche" });
  });

  it("leaves out a dimension the message names twice, keeping the other", () => {
    // "Dell vs HPE at Roche" asks for Roche across vendors, which compares them.
    expect(matchCompetitiveQuery("Dell vs HPE at Roche", SNAPSHOT)).toEqual({ account: "roche" });
  });

  it("ignores a vendor no brief positions, which would read 'displace, unknown' in every segment", () => {
    expect(matchCompetitiveQuery("Snowflake pricing", SNAPSHOT)).toBeNull();
    expect(matchCompetitiveQuery("Snowflake at Roche", SNAPSHOT)).toEqual({ account: "roche" });
  });

  it("still counts a brief-less vendor as a second name", () => {
    expect(matchCompetitiveQuery("Dell vs Snowflake at Roche", SNAPSHOT)).toEqual({ account: "roche" });
    expect(matchCompetitiveQuery("Dell vs Snowflake", SNAPSHOT)).toBeNull();
  });

  it("returns null when nothing is pinned to one vendor or one account", () => {
    expect(matchCompetitiveQuery("Dell vs HPE", SNAPSHOT)).toBeNull();
    expect(matchCompetitiveQuery("What is ransomware?", SNAPSHOT)).toBeNull();
  });
});

function answer(overrides: Partial<CompetitiveAnswer> = {}): CompetitiveAnswer {
  return {
    query: { vendor: "dell", account: "roche", segment: null },
    modes: { defend: "the vendor is installed: defend and expand", greenfield: "declared: nobody is installed" },
    market: [],
    accounts: [
      {
        account: "roche",
        name: "Roche",
        needs: ["cyber-resilience"],
        general: [],
        segments: [
          {
            segment: "storage-block",
            via: ["cyber-resilience"],
            incumbents: ["dell"],
            vendors: [{ vendor: "dell", mode: "defend", position: "leader" }],
            events: [],
          },
          { segment: "storage-object", via: [], incumbents: [], vendors: [{ vendor: "dell", mode: "greenfield", position: null }], events: [] },
        ],
      },
    ],
    standings: {
      "dell/storage-block": {
        position: "leader",
        confidence: "high",
        rationale: "PowerMax installed base.",
        asOf: "2026-09-21",
        curated: true,
        strong: [{ claim: "Cyber vault.", detail: "long detail" }],
        weak: [{ claim: "Price.", detail: "" }],
        sources: ["https://example.test/s"],
      },
    },
    evidence: { dell: [{ title: "Dell ships PowerMax 9", url: "https://example.test/n", publishedAt: "2026-09-28", signal: "it_move" }] },
    notes: ["no curated evidence for dell in storage-object: the position rests on the graph alone"],
    ...overrides,
  };
}

describe("renderCompetitiveContext", () => {
  it("renders modes, installs, standings, news and notes as prompt text", () => {
    const text = renderCompetitiveContext(answer());
    expect(text).toContain("[Graph Context: competitive position, vendor dell, account roche]");
    expect(text).toContain("- defend: the vendor is installed: defend and expand");
    expect(text).toContain("Roche (roche), needs: cyber-resilience");
    expect(text).toContain("storage-block (via cyber-resilience), installed: dell");
    expect(text).toContain("storage-object, installed: nobody");
    expect(text).toContain("dell: defend, position leader");
    expect(text).toContain("dell: greenfield, position unknown");
    expect(text).toContain("dell/storage-block: leader (high confidence, as of 2026-09-21). PowerMax installed base.");
    expect(text).toContain("strong: Cyber vault.");
    expect(text).toContain("weak: Price.");
    expect(text).toContain("- dell: Dell ships PowerMax 9 (2026-09-28) https://example.test/n");
    expect(text).toContain("- no curated evidence for dell in storage-object");
  });

  it("shows each segment's events under its installs, and account-wide news as general", () => {
    const base = answer();
    const roche = base.accounts[0];
    roche.general = [{ title: "Roche reorganises IT", url: "https://example.test/g", publishedAt: "2026-09-02", signal: null }];
    roche.segments[0].events = [
      { title: "Roche consolidates EU data centres", url: "https://example.test/e", publishedAt: "2026-09-14", signal: "it_move" },
    ];
    const text = renderCompetitiveContext(base);
    expect(text).toContain("  general:\n    ↳ 2026-09-02 [untagged] Roche reorganises IT");
    expect(text).toContain(
      "  storage-block (via cyber-resilience), installed: dell\n    ↳ 2026-09-14 [it_move] Roche consolidates EU data centres",
    );
  });

  it("stays within the chat budget, saying it was cut", () => {
    const many = Object.fromEntries(
      Array.from({ length: 80 }, (_, i) => [
        `dell/seg-${i}`,
        { ...answer().standings["dell/storage-block"], rationale: "r".repeat(300) },
      ]),
    );
    const text = renderCompetitiveContext(answer({ standings: many }));
    expect(text.length).toBeLessThanOrEqual(CHAT_CONTEXT_CHARS);
    expect(text).toMatch(/trimmed to fit|cut to fit/);
  });

  it("cuts at a line boundary when structure alone overflows, saying so", () => {
    // fitBudget never drops accounts, so only the text cut can bring this under.
    const accounts = Array.from({ length: 200 }, (_, i) => ({ ...answer().accounts[0], account: `acct-${i}`, name: `Account ${i}` }));
    const text = renderCompetitiveContext(answer({ accounts }));
    expect(text.length).toBeLessThanOrEqual(CHAT_CONTEXT_CHARS);
    expect(text.endsWith("for the rest)")).toBe(true);
    expect(text.split("\n").slice(-2, -1)[0]).toMatch(/^\s*(\S.*)$/);
  });
});

const ROWS = {
  accounts: [
    {
      id: "roche",
      name: "Roche",
      aliases: "Genentech",
      declaredSegments: "storage-block",
      needs: [],
      uses: [{ segment: "storage-block", vendor: "dell" }],
    },
  ],
  needs: [],
  positions: [
    { vendor: "dell", segment: "storage-block", position: "leader", confidence: "high", rationale: "PowerMax.", asOf: "2026-09-21" },
  ],
  vendors: [{ id: "dell" }, { id: "hpe" }],
};

function fakeCypher(calls: string[] = []): RunCypher {
  return async (query) => {
    calls.push(query);
    if (query === ACCOUNTS_CYPHER) return ROWS.accounts;
    if (query === NEED_SEGMENTS_CYPHER) return ROWS.needs;
    if (query === POSITIONS_CYPHER) return ROWS.positions;
    if (query === VENDORS_CYPHER) return ROWS.vendors;
    if (query === ACCOUNT_EVIDENCE_CYPHER || query === VENDOR_EVIDENCE_CYPHER) return [];
    throw new Error(`unexpected query: ${query}`);
  };
}

function competitive(overrides: Partial<CompetitiveDeps> = {}): CompetitiveDeps {
  return {
    runCypher: fakeCypher(),
    briefs: () => ({ excerpts: new Map(), errors: [] }),
    vendorAliases: () => ({}),
    ...overrides,
  };
}

function deps(overrides: Partial<ChatGraphDeps> = {}): ChatGraphDeps & { keywordCalls: string[][] } {
  const keywordCalls: string[][] = [];
  return {
    competitive: competitive(),
    keywordLookup: async (keywords) => {
      keywordCalls.push(keywords);
      return "[Graph Context]\n- keyword hit";
    },
    log: () => {},
    keywordCalls,
    ...overrides,
  };
}

describe("chatGraphContext", () => {
  it("answers a message naming a vendor and an account with the competitive position", async () => {
    const d = deps();
    const result = await chatGraphContext("Dell at Genentech?", ["Dell", "Genentech"], d);
    expect(result.source).toBe("competitive");
    expect(result.label).toBe("dell @ roche");
    expect(result.text).toContain("dell: defend, position leader");
    expect(d.keywordCalls).toEqual([]);
  });

  it("reads the graph once, for matching and answering alike", async () => {
    const calls: string[] = [];
    await chatGraphContext("Dell at Roche?", [], deps({ competitive: competitive({ runCypher: fakeCypher(calls) }) }));
    expect(calls.filter((q) => q === ACCOUNTS_CYPHER)).toHaveLength(1);
  });

  it("falls back to the keyword lookup when nothing is matched", async () => {
    const d = deps();
    const result = await chatGraphContext("Tell me about Snowflake", ["Snowflake"], d);
    expect(result).toEqual({ source: "keyword", label: null, text: "[Graph Context]\n- keyword hit" });
    expect(d.keywordCalls).toEqual([["Snowflake"]]);
  });

  it("falls back to the keyword lookup when the graph read fails, and logs why", async () => {
    const logs: string[] = [];
    const failing = competitive({ runCypher: async () => { throw new Error("neo4j down"); } });
    const result = await chatGraphContext("Dell at Roche?", ["Dell"], deps({ competitive: failing, log: (m) => logs.push(m) }));
    expect(result.source).toBe("keyword");
    expect(logs.join("\n")).toContain("neo4j down");
  });

  it("falls back to the keyword lookup when the competitive path is too slow", async () => {
    const slow = competitive({ runCypher: () => new Promise(() => {}) });
    const result = await chatGraphContext("Dell at Roche?", ["Dell"], deps({ competitive: slow, timeoutMs: 10 }));
    expect(result.source).toBe("keyword");
  });

  it("reports none when neither path has anything", async () => {
    const result = await chatGraphContext("hello", [], deps({ keywordLookup: async () => "" }));
    expect(result).toEqual({ source: "none", label: null, text: "" });
  });
});
