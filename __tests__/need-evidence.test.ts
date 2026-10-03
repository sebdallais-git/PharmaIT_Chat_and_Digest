import { describe, expect, it } from "@jest/globals";
import type { Account } from "../src/services/graph-accounts.js";
import {
  checkAgainstAccounts,
  mergeNeedEvidence,
  mergeNeedEvidenceText,
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
  history: {},
  triggers: {},
  notes: "",
};

describe("entryId", () => {
  it("is stable, prefixed, and ignores whitespace differences in the quote", () => {
    const id = entryId("roche", "cyber-resilience", "Merck's operations were\n  disrupted.");
    expect(id).toMatch(/^ne-[0-9a-f]{10}$/);
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

describe("mergeNeedEvidence", () => {
  it("keeps the user's edits made during a run and appends only new entries", () => {
    // Read at the start of a run, then approved by the user while it ran.
    const onDisk = file([entry({ id: "ne-000001", status: "approved" })], { "knowledge/a.md": "h1" });
    const fromRun = file(
      [entry({ id: "ne-000001", status: "proposed" }), entry({ id: "ne-000002", status: "proposed", need: "gxp-compliance" })],
      { "knowledge/a.md": "h1", "knowledge/b.md": "h2" },
    );
    expect(mergeNeedEvidence(onDisk, fromRun)).toEqual(
      file(
        [entry({ id: "ne-000001", status: "approved" }), entry({ id: "ne-000002", status: "proposed", need: "gxp-compliance" })],
        { "knowledge/a.md": "h1", "knowledge/b.md": "h2" },
      ),
    );
  });
});

// Review of #67: every run re-rendered the file and dropped the user's comments
describe("mergeNeedEvidenceText", () => {
  it("appends the run's new entries and keeps the user's comments on the existing ones", () => {
    const onDisk = renderNeedEvidence(file([entry({ id: "ne-000001", status: "approved" })], { "knowledge/a.md": "h1" })).replace(
      "status: approved",
      "status: approved # confirmed by the account team",
    );
    const out = mergeNeedEvidenceText(onDisk, file([entry({ id: "ne-000001", status: "proposed" }), entry({ id: "ne-000002", status: "proposed" })], { "knowledge/b.md": "h2" }));
    expect(out).toContain("status: approved # confirmed by the account team");
    const merged = parseNeedEvidence(out);
    expect(merged.entries.map((e) => [e.id, e.status])).toEqual([["ne-000001", "approved"], ["ne-000002", "proposed"]]);
    expect(merged.sources).toEqual({ "knowledge/a.md": "h1", "knowledge/b.md": "h2" });
  });
});
