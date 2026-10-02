import { describe, expect, it } from "@jest/globals";
import {
  REGIME_GUIDANCE,
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
        // compute-standard is declared with nobody installed; data-protection is not declared at all.
        declared: ["compute-ai", "compute-standard", "storage-block", "storage-file"],
        uses: [
          { segment: "storage-block", vendor: "dell" },
          { segment: "storage-file", vendor: "netapp" },
          { segment: "compute-ai", vendor: "hpe" },
        ],
      },
      { id: "novartis", name: "Novartis", aliases: [], needs: ["ai-factory"], declared: [], uses: [] },
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

  it("resolves incumbency per segment into defend, displace, greenfield or unknown", () => {
    const roche = answer.accounts.find((a) => a.account === "roche");
    const modes = Object.fromEntries((roche?.segments ?? []).map((s) => [s.segment, s.vendors[0]]));
    expect(modes["storage-block"]).toEqual({ vendor: "dell", mode: "defend", position: "leader" });
    expect(modes["storage-file"]).toEqual({ vendor: "dell", mode: "displace", position: "strong" });
    expect(modes["compute-ai"]).toEqual({ vendor: "dell", mode: "displace", position: null });
    expect(modes["compute-standard"]).toEqual({ vendor: "dell", mode: "greenfield", position: null });
    expect(modes["data-protection"]).toEqual({ vendor: "dell", mode: "unknown", position: null });
  });

  it("records which needs put a segment in play, and who is installed there", () => {
    const roche = answer.accounts.find((a) => a.account === "roche");
    const file = roche?.segments.find((s) => s.segment === "storage-file");
    expect(file?.via).toEqual(["rnd-compute"]);
    expect(file?.incumbents).toEqual(["netapp"]);
  });

  it("treats an undeclared segment as unknown, never as greenfield", () => {
    // accounts.example.yaml says to omit a segment whose incumbent is not
    // known; reading that silence as "nobody installed" would be false confidence.
    const novartis = answer.accounts.find((a) => a.account === "novartis");
    expect(novartis?.segments.map((s) => s.vendors[0].mode)).toEqual(["unknown", "unknown", "unknown"]);
  });

  it("treats a segment declared with nobody installed as greenfield", () => {
    const snap = snapshot({
      accounts: [
        {
          id: "novartis",
          name: "Novartis",
          aliases: [],
          needs: ["ai-factory"],
          declared: ["compute-ai", "networking", "storage-file"],
          uses: [],
        },
      ],
    });
    const novartis = ok(resolveCompetitivePosition(snap, { vendor: "dell" })).accounts[0];
    expect(novartis.segments.map((s) => s.vendors[0].mode)).toEqual(["greenfield", "greenfield", "greenfield"]);
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
  it("never ranks by ordering: vendors and market stay alphabetical; only ranking orders, with reasons", () => {
    const snap = snapshot({
      positions: [
        { vendor: "hpe", segment: "storage-block", position: "leader", confidence: "high", rationale: "r", asOf: "" },
        { vendor: "dell", segment: "storage-block", position: "present", confidence: "low", rationale: "r", asOf: "" },
      ],
    });
    const answer = ok(resolveCompetitivePosition(snap, { account: "roche", segment: "storage-block" }));
    expect(answer.accounts[0].segments[0].vendors.map((v) => v.vendor)).toEqual(["dell", "hpe"]);
    expect(answer.market.map((m) => m.vendor)).toEqual(["dell", "hpe"]);
    const ranking = answer.accounts[0].segments[0].ranking;
    expect(ranking?.map((r) => r.vendor)).toEqual(["dell", "hpe"]);
    expect(ranking?.every((r) => r.reasons.length === 2)).toBe(true);
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
      accounts: [
        {
          id: "sandoz",
          name: "Sandoz",
          aliases: [],
          needs: [],
          declared: ["storage-block"],
          uses: [{ segment: "storage-block", vendor: "dell" }],
        },
      ],
    });
    const answer = ok(resolveCompetitivePosition(snap, { vendor: "dell" }));
    expect(answer.accounts[0].segments).toMatchObject([
      { segment: "storage-block", via: [], incumbents: ["dell"], vendors: [{ vendor: "dell", mode: "defend", position: "leader" }] },
    ]);
  });

  it("says so when an account declares no needs and no vendor pins a segment", () => {
    const snap = snapshot({ accounts: [{ id: "sandoz", name: "Sandoz", aliases: [], needs: [], declared: [], uses: [] }] });
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
