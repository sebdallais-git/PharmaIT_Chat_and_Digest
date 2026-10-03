import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@jest/globals";
import { loadWatchlist, parseWatchlist, WatchlistError } from "../src/services/watchlist-config.js";

const MINIMAL = {
  customers: {
    roche: { name: "Roche", aliases: ["Genentech"], peers: ["novartis"], feeds: { rss: ["https://r.example/f.xml"] } },
    novartis: { name: "Novartis", peers: ["roche"], feeds: { edgar: "0001114448" } },
  },
  vendors: { cloud: ["aws"], backup: ["veeam"] },
  topics: { cyber: ["pharma ransomware"] },
};

describe("parseWatchlist", () => {
  it("builds entities for customers, peers and vendors with their feeds", () => {
    const list = parseWatchlist(MINIMAL);

    expect(list.entities.get("roche")).toMatchObject({ name: "Roche", kind: "customer", aliases: ["Genentech"], peers: ["novartis"] });
    expect(list.entities.get("roche")?.feeds).toEqual([{ kind: "rss", url: "https://r.example/f.xml" }]);
    expect(list.entities.get("novartis")?.feeds).toEqual([{ kind: "edgar", cik: "0001114448" }]);
    expect(list.entities.get("aws")).toMatchObject({ kind: "vendor", domains: ["cloud"] });
    expect(list.topics).toEqual([{ query: "pharma ransomware", domains: ["cyber"] }]);
  });

  it("orders priority customers first, then peers, then vendors", () => {
    expect(parseWatchlist(MINIMAL).priority).toEqual(["roche", "novartis", "aws", "veeam"]);
  });

  it("reports every problem at once instead of the first", () => {
    // "ghost" is not itself invalid (a customer's peer with no separate
    // definition always auto-creates, per R3b) -- it is a valid config on
    // its own. This test only throws because "teleportation" is a real
    // domain violation; the "ghost" auto-create note rides along in the same
    // thrown message. See the "surfaces peer notes" tests below for what the
    // "ghost" note actually asserts.
    const broken = {
      customers: { roche: { name: "Roche", peers: ["ghost"] } },
      vendors: { teleportation: ["acme"] },
      topics: { cyber: ["ok"] },
    };

    try {
      parseWatchlist(broken);
      throw new Error("expected WatchlistError");
    } catch (err) {
      expect(err).toBeInstanceOf(WatchlistError);
      expect((err as Error).message).toContain('peer "ghost" referenced by "roche" has no separate definition');
      expect((err as Error).message).toContain("teleportation");
    }
  });

  it("refuses a duplicate id across sections", () => {
    const dup = { customers: { aws: { name: "AWS" } }, vendors: { cloud: ["aws"] }, topics: {} };
    expect(() => parseWatchlist(dup)).toThrow(/aws/);
  });

  it("rejects a non-object document", () => {
    expect(() => parseWatchlist("nope")).toThrow(WatchlistError);
  });

  it("accepts a topic group with no domain under the literal 'none' key (R1)", () => {
    const withNone = {
      customers: {},
      vendors: {},
      topics: { none: ["pharma FDA approval"], cyber: ["pharma ransomware breach"] },
    };

    const list = parseWatchlist(withNone);

    expect(list.topics).toEqual([
      { query: "pharma FDA approval", domains: [] },
      { query: "pharma ransomware breach", domains: ["cyber"] },
    ]);
  });

  it("succeeds on an undefined peer and surfaces a note naming it (R3b)", () => {
    const withOrphanPeer = {
      customers: { roche: { name: "Roche", peers: ["ghost"] } },
      vendors: {},
      topics: {},
    };

    const list = parseWatchlist(withOrphanPeer);

    expect(list.entities.get("ghost")).toMatchObject({ id: "ghost", kind: "peer" });
    expect(list.notes).toHaveLength(1);
    expect(list.notes[0]).toContain('peer "ghost" referenced by "roche" has no separate definition');
  });

  it("merges domains when a vendor id appears in two different groups", () => {
    const twoDomainVendor = {
      customers: {},
      vendors: { ai: ["databricks"], data: ["databricks"] },
      topics: {},
    };

    const list = parseWatchlist(twoDomainVendor);

    expect(list.entities.size).toBe(1);
    expect(list.entities.get("databricks")).toMatchObject({ kind: "vendor", domains: ["ai", "data"] });
    expect(list.priority).toEqual(["databricks"]);
  });

  it("refuses the same vendor id repeated within one group, but still merges it across two groups (R4)", () => {
    const repeatedWithinGroup = {
      customers: {},
      vendors: { cloud: ["aws", "aws"] },
      topics: {},
    };
    expect(() => parseWatchlist(repeatedWithinGroup)).toThrow(/duplicate id "aws" within vendor group "cloud"/);

    const acrossTwoGroups = {
      customers: {},
      vendors: { ai: ["nvidia"], cloud: ["nvidia"] },
      topics: {},
    };
    const list = parseWatchlist(acrossTwoGroups);
    expect(list.entities.get("nvidia")).toMatchObject({ kind: "vendor", domains: ["ai", "cloud"] });
  });

  // R8: a vendor entry may be either a bare id (unchanged) or a single-key
  // mapping { id: { name?, aliases?, feeds?, verifiedAt? } } -- needed for
  // the Everpure rename (pure-storage keeps its id, gains a display name and
  // an alias) and to attach researched feeds to any vendor.
  describe("vendor entries as a mapping (R8)", () => {
    it("still accepts a bare id with no extra data", () => {
      const list = parseWatchlist({ customers: {}, vendors: { cloud: ["aws"] }, topics: {} });
      expect(list.entities.get("aws")).toMatchObject({ kind: "vendor", name: "Aws", aliases: [], feeds: [] });
    });

    it("accepts a single-key mapping with name, aliases and feeds, stamping verifiedAt onto each feed", () => {
      const config = {
        customers: {},
        vendors: {
          storage: [
            {
              "pure-storage": {
                name: "Everpure",
                aliases: ["Pure Storage"],
                feeds: { rss: ["https://blog.everpuredata.com/feed/"], edgar: "0001474432" },
                verifiedAt: "2026-09-20",
              },
            },
          ],
        },
        topics: {},
      };

      const list = parseWatchlist(config);
      const entity = list.entities.get("pure-storage");

      expect(entity).toMatchObject({ id: "pure-storage", kind: "vendor", name: "Everpure", aliases: ["Pure Storage"] });
      expect(entity?.feeds).toEqual([
        { kind: "rss", url: "https://blog.everpuredata.com/feed/", verifiedAt: "2026-09-20" },
        { kind: "edgar", cik: "0001474432", verifiedAt: "2026-09-20" },
      ]);
    });

    it("merges domains when a mapping-form vendor also appears as a bare id in another group", () => {
      const config = {
        customers: {},
        vendors: {
          ai: [{ databricks: { feeds: { rss: ["https://www.databricks.com/feed"] }, verifiedAt: "2026-09-20" } }],
          data: ["databricks"],
        },
        topics: {},
      };

      const list = parseWatchlist(config);
      const entity = list.entities.get("databricks");

      expect(entity).toMatchObject({ kind: "vendor", domains: ["ai", "data"] });
      expect(entity?.feeds).toEqual([{ kind: "rss", url: "https://www.databricks.com/feed", verifiedAt: "2026-09-20" }]);
    });

    it("rejects a vendor mapping with more than one key", () => {
      const config = { customers: {}, vendors: { cloud: [{ aws: {}, oracle: {} }] }, topics: {} };
      expect(() => parseWatchlist(config)).toThrow(/exactly one key/);
    });
  });
});

describe("peers section (explicit feeds for auto-created peers)", () => {
  it("attaches feeds and verifiedAt to a peer referenced by a customer, instead of leaving it a bare stub", () => {
    const config = {
      customers: { roche: { name: "Roche", peers: ["pfizer"] } },
      peers: {
        pfizer: {
          feeds: { edgar: "0000078003", ir_page: "https://investors.pfizer.com/Investors/Financials/Quarterly-Results/default.aspx" },
          verifiedAt: "2026-09-20",
        },
      },
      vendors: {},
      topics: {},
    };

    const list = parseWatchlist(config);
    const pfizer = list.entities.get("pfizer");

    expect(pfizer).toMatchObject({ id: "pfizer", kind: "peer" });
    expect(pfizer?.feeds).toEqual([
      { kind: "edgar", cik: "0000078003", verifiedAt: "2026-09-20" },
      { kind: "ir_page", url: "https://investors.pfizer.com/Investors/Financials/Quarterly-Results/default.aspx", verifiedAt: "2026-09-20" },
    ]);
    // An explicitly-defined peer is not an inferred auto-create: no note.
    expect(list.notes).toHaveLength(0);
  });

  it("still auto-creates (with a note) a peer that has no entry under peers:", () => {
    const config = {
      customers: { roche: { name: "Roche", peers: ["ghost"] } },
      peers: {},
      vendors: {},
      topics: {},
    };

    const list = parseWatchlist(config);

    expect(list.entities.get("ghost")).toMatchObject({ kind: "peer", feeds: [] });
    expect(list.notes[0]).toContain('peer "ghost" referenced by "roche" has no separate definition');
  });

  it("refuses a peers: entry for an id no customer ever references", () => {
    const config = {
      customers: { roche: { name: "Roche", peers: ["pfizer"] } },
      peers: { pfizer: { feeds: {} }, orphan: { feeds: {} } },
      vendors: {},
      topics: {},
    };

    expect(() => parseWatchlist(config)).toThrow(/"orphan"/);
  });
});

describe("loadWatchlist", () => {
  it("loads and parses a YAML file from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "watchlist-config-test-"));
    const filePath = join(dir, "watchlist.yaml");
    try {
      writeFileSync(
        filePath,
        [
          "customers:",
          "  roche:",
          "    name: Roche",
          "    peers: [novartis]",
          "  novartis:",
          "    name: Novartis",
          "vendors:",
          "  cloud: [aws]",
          "topics:",
          "  cyber: [pharma ransomware]",
          "",
        ].join("\n"),
        "utf8",
      );

      const list = loadWatchlist(filePath);

      expect(list.entities.get("roche")).toMatchObject({ kind: "customer" });
      expect(list.entities.get("aws")).toMatchObject({ kind: "vendor", domains: ["cloud"] });
      expect(list.topics).toEqual([{ query: "pharma ransomware", domains: ["cyber"] }]);
      expect(list.priority).toEqual(["roche", "novartis", "aws"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("customers — theater and size", () => {
  const customer = (extra: Record<string, unknown>) => ({ customers: { roche: { name: "Roche", ...extra } } });

  it("reads a customer's theater and size", () => {
    const list = parseWatchlist(customer({ theater: "EMEA", size: { rank: 2, year: 2025, basis: "FY2024 healthcare revenue" } }));
    const roche = list.entities.get("roche");
    expect(roche?.theater).toBe("EMEA");
    expect(roche?.size).toEqual({ rank: 2, year: 2025, basis: "FY2024 healthcare revenue" });
  });

  it("leaves both absent when not given", () => {
    const roche = parseWatchlist(customer({})).entities.get("roche");
    expect(roche?.theater).toBeUndefined();
    expect(roche?.size).toBeUndefined();
  });

  it("refuses an unknown theater and a malformed size", () => {
    expect(() => parseWatchlist(customer({ theater: "Europe" }))).toThrow('customer "roche" theater must be one of Americas, EMEA, APAC');
    expect(() => parseWatchlist(customer({ size: { rank: 0, year: 2025, basis: "x" } }))).toThrow(
      'customer "roche" size must be {rank: positive integer, year: YYYY, basis: text}',
    );
    expect(() => parseWatchlist(customer({ size: { rank: 2, year: "last", basis: "x" } }))).toThrow(
      'customer "roche" size must be {rank: positive integer, year: YYYY, basis: text}',
    );
  });

  it("refuses two customers with the same size rank", () => {
    expect(() =>
      parseWatchlist({
        customers: {
          roche: { name: "Roche", size: { rank: 2, year: 2025, basis: "x" } },
          novartis: { name: "Novartis", size: { rank: 2, year: 2025, basis: "x" } },
        },
      }),
    ).toThrow('customers "roche" and "novartis" share size rank 2');
  });
});

describe("config/watchlist.yaml — the top 60", () => {
  const customers = [...loadWatchlist().entities.values()].filter((e) => e.kind === "customer");

  it("tracks 60 customers, each with a theater and a size rank", () => {
    expect(customers).toHaveLength(60);
    expect(customers.every((c) => c.theater !== undefined && c.size !== undefined)).toBe(true);
  });

  it("splits them 26 / 23 / 11 across Americas, EMEA and APAC, ranked 1 to 60 once each", () => {
    const by = (t: string) => customers.filter((c) => c.theater === t).length;
    expect([by("Americas"), by("EMEA"), by("APAC")]).toEqual([26, 23, 11]);
    expect(customers.map((c) => c.size?.rank).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
  });

  it("gives every customer an IT-news query", () => {
    const missing = customers.filter((c) => !c.feeds.some((f) => f.kind === "rss" && (f.url ?? "").includes("news.google.com") && (f.url ?? "").includes("IT+infrastructure")));
    expect(missing.map((c) => c.id)).toEqual([]);
  });
});
