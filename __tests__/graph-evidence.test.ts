import { describe, expect, it } from "@jest/globals";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVIDENCE_WINDOW_DAYS,
  evidenceSince,
  evidenceToGraphFacts,
  segmentsForDomains,
  storeEvidence,
  watchlistEvidence,
  type EvidenceSourceItem,
} from "../src/services/graph-evidence.js";
import type { Domain } from "../src/services/watchlist-config.js";

const NOW = new Date("2026-10-02T03:00:00.000Z");

function item(over: Partial<EvidenceSourceItem> & { id: number }): EvidenceSourceItem {
  return {
    id: over.id,
    urlCanonical: over.urlCanonical ?? `https://example.test/${over.id}`,
    title: over.title ?? `Item ${over.id}`,
    signal: over.signal === undefined ? "it_move" : over.signal,
    publishedAt: over.publishedAt ?? "2026-09-20T08:00:00.000Z",
    sourceName: over.sourceName ?? "Blocks & Files",
    entities: over.entities ?? ["dell"],
    domains: over.domains ?? ["storage"],
  };
}

describe("segmentsForDomains", () => {
  it("maps storage to the three storage segments, in segment order", () => {
    expect(segmentsForDomains(["storage"])).toEqual(["storage-block", "storage-file", "storage-object"]);
  });

  it("maps backup and cyber to data-protection once", () => {
    expect(segmentsForDomains(["backup", "cyber"])).toEqual(["data-protection"]);
  });

  it("maps infrastructure to every segment that reads it", () => {
    expect(segmentsForDomains(["infrastructure"])).toEqual(["compute-ai", "compute-standard", "hci"]);
  });

  it("returns no segment for a domain no segment reads", () => {
    expect(segmentsForDomains(["sap", "cloud"])).toEqual([]);
  });
});

describe("evidenceToGraphFacts", () => {
  const graph = new Set(["dell", "roche"]);

  it("writes one Evidence node and one SUPPORTS edge per graph entity", () => {
    const { facts, evidence, entities } = evidenceToGraphFacts(
      [item({ id: 7, entities: ["dell", "roche", "not-in-graph"], domains: ["storage"] })],
      graph,
      NOW,
    );
    expect(evidence).toBe(1);
    expect(entities).toBe(2);
    expect(facts.nodes).toEqual([
      {
        label: "Evidence",
        id: "watchlist:7",
        properties: {
          title: "Item 7",
          url: "https://example.test/7",
          publishedAt: "2026-09-20",
          signal: "it_move",
          domains: ["storage"],
          source: "Blocks & Files",
        },
      },
    ]);
    const segments = ["storage-block", "storage-file", "storage-object"];
    expect(facts.relationships).toEqual([
      { type: "SUPPORTS", from: "watchlist:7", to: "dell", properties: { url: "https://example.test/7", segments } },
      { type: "SUPPORTS", from: "watchlist:7", to: "roche", properties: { url: "https://example.test/7", segments } },
    ]);
  });

  it("gives an item whose domains map nowhere account- and vendor-wide edges (segments [])", () => {
    const { facts } = evidenceToGraphFacts([item({ id: 8, entities: ["dell", "roche"], domains: ["sap"] })], graph, NOW);
    expect(facts.relationships.map((r) => r.properties.segments)).toEqual([[], []]);
  });

  it("keeps a missing signal as null", () => {
    const { facts } = evidenceToGraphFacts([item({ id: 9, signal: null })], graph, NOW);
    expect(facts.nodes[0].properties.signal).toBeNull();
  });

  it("ignores items tagged only with entities outside the graph", () => {
    const result = evidenceToGraphFacts([item({ id: 10, entities: ["snowflake"] })], graph, NOW);
    expect(result.evidence).toBe(0);
    expect(result.facts).toEqual({ nodes: [], relationships: [] });
  });

  it("skips and counts items dated more than a day in the future", () => {
    const result = evidenceToGraphFacts(
      [
        item({ id: 11, publishedAt: "2026-11-03T23:00:00.000Z" }),
        item({ id: 12, publishedAt: "2026-10-02T23:00:00.000Z" }), // within a day: kept
      ],
      graph,
      NOW,
    );
    expect(result.futureSkipped).toBe(1);
    expect(result.facts.nodes.map((n) => n.id)).toEqual(["watchlist:12"]);
  });
});

describe("evidence sources", () => {
  it("starts the window EVIDENCE_WINDOW_DAYS before now", () => {
    expect(EVIDENCE_WINDOW_DAYS).toBe(180);
    expect(evidenceSince(NOW)).toBe("2026-04-05T03:00:00.000Z");
  });

  it("asks the store for the entities from the window start onwards", () => {
    const calls: Array<[string, string, { entities?: string[]; domains?: Domain[] } | undefined]> = [];
    const source = storeEvidence({
      itemsInPeriod: (from, to, options) => {
        calls.push([from, to, options]);
        return [];
      },
    });
    expect(source(["dell", "roche"], "2026-04-05T03:00:00.000Z")).toEqual([]);
    expect(calls).toEqual([["2026-04-05T03:00:00.000Z", "9999-12-31T23:59:59.999Z", { entities: ["dell", "roche"] }]]);
  });

  it("reports a missing watchlist.db as null without creating it", () => {
    const path = join(mkdtempSync(join(tmpdir(), "evidence-")), "watchlist.db");
    expect(watchlistEvidence(path)(["dell"], "2026-04-05T00:00:00.000Z")).toBeNull();
    expect(existsSync(path)).toBe(false);
  });
});
