import { describe, expect, it } from "@jest/globals";
import {
  collectVendorGraphFacts,
  rebuildVendorGraph,
  type CypherRunner,
  type WriteTransaction,
} from "../src/services/vendor-graph-rebuild.js";
import type { EvidenceSource, EvidenceSourceItem } from "../src/services/graph-evidence.js";

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

describe("collectVendorGraphFacts — watchlist evidence", () => {
  const NOW = new Date("2026-10-02T03:00:00.000Z");

  function evidenceItem(over: Partial<EvidenceSourceItem> & { id: number }): EvidenceSourceItem {
    return {
      id: over.id,
      urlCanonical: `https://example.test/${over.id}`,
      title: `Item ${over.id}`,
      signal: "it_move",
      publishedAt: over.publishedAt ?? "2026-09-20T08:00:00.000Z",
      sourceName: "Blocks & Files",
      entities: over.entities ?? ["dell"],
      domains: over.domains ?? ["storage"],
    };
  }

  function recordingSource(items: EvidenceSourceItem[]): { source: EvidenceSource; calls: Array<[string[], string]> } {
    const calls: Array<[string[], string]> = [];
    return {
      calls,
      source: (ids, since) => {
        calls.push([ids, since]);
        return items;
      },
    };
  }

  it("asks for the graph's vendors and accounts over the evidence window", () => {
    const rec = recordingSource([]);
    collectVendorGraphFacts({ ...files(ALL), evidence: rec.source, now: () => NOW });
    expect(rec.calls).toEqual([[["dell", "roche"], "2026-04-05T03:00:00.000Z"]]);
  });

  it("adds Evidence facts and a report line", () => {
    const rec = recordingSource([
      evidenceItem({ id: 1, entities: ["dell", "roche"] }),
      evidenceItem({ id: 2, publishedAt: "2026-11-03T00:00:00.000Z" }),
    ]);
    const { batch, lines } = collectVendorGraphFacts({ ...files(ALL), evidence: rec.source, now: () => NOW });
    const evidence = batch[batch.length - 1];
    expect(evidence.nodes.map((n) => n.id)).toEqual(["watchlist:1"]);
    expect(evidence.relationships.map((r) => r.to)).toEqual(["dell", "roche"]);
    expect(lines).toContain("watchlist.db                 -> 1 evidence for 2 vendors/accounts, 1 future-dated skipped");
  });

  it("skips and reports a missing watchlist.db", () => {
    const { batch, lines } = collectVendorGraphFacts({ ...files(ALL), evidence: () => null, now: () => NOW });
    expect(batch).toHaveLength(3);
    expect(lines).toContain("watchlist.db                 -> skipped (no such file)");
  });

  it("writes evidence through the rebuild, after the wipe", async () => {
    const rec = recordingTransaction();
    await rebuildVendorGraph(
      { ...files(ALL), evidence: recordingSource([evidenceItem({ id: 1 })]).source, now: () => NOW },
      rec.tx,
    );
    expect(rec.queries[0]).toBe("MATCH (n) DETACH DELETE n");
    expect(rec.queries.some((q) => q.startsWith("MERGE (n:Evidence {id: $id})"))).toBe(true);
    expect(rec.queries.some((q) => q.includes("MERGE (a)-[r:SUPPORTS {url: $id_url}]->(b)"))).toBe(true);
  });

  it("never opens a transaction when watchlist.db cannot be read", async () => {
    const rec = recordingTransaction();
    const unreadable: EvidenceSource = () => {
      throw new Error("SQLITE_CORRUPT: database disk image is malformed");
    };
    await expect(rebuildVendorGraph({ ...files(ALL), evidence: unreadable, now: () => NOW }, rec.tx)).rejects.toThrow(
      "watchlist.db: SQLITE_CORRUPT: database disk image is malformed",
    );
    expect(rec.calls).toBe(0);
  });
});
