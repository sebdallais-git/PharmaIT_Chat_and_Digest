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
