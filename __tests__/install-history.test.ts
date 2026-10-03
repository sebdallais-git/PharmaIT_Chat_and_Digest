import { describe, expect, it } from "@jest/globals";
import type { Account } from "../src/services/graph-accounts.js";
import {
  applyHistory,
  checkHistoryAgainstAccounts,
  historyEntryId,
  mergeInstallHistory,
  mergeInstallHistoryText,
  parseInstallHistory,
  renderInstallHistory,
  type HistoryEntry,
  type InstallHistoryFile,
} from "../src/services/install-history.js";

function entry(over: Partial<HistoryEntry> & { id: string }): HistoryEntry {
  return {
    status: "approved",
    account: "novartis",
    segment: "storage-block",
    vendor: "hds",
    change: "installed",
    date: "2026-03-12",
    quote: "Novartis has deployed Hitachi Vantara storage across its EU sites.",
    source: "https://news.test/a",
    extracted: "2026-10-03",
    ...over,
  };
}

const file = (entries: HistoryEntry[]): InstallHistoryFile => ({ sources: {}, entries });

function account(stints: Account["history"]): Account {
  const incumbents: Account["incumbents"] = {};
  for (const [segment, list] of Object.entries(stints)) {
    incumbents[segment as keyof Account["incumbents"]] = (list ?? []).filter((s) => s.until === "").map((s) => s.vendor);
  }
  return { id: "novartis", name: "Novartis", aliases: [], needs: [], incumbents, history: stints, triggers: {}, notes: "" };
}

const declared = (vendor: string, since = "", until = "") => ({ vendor, since, until, source: "declared" });

describe("historyEntryId / file", () => {
  it("is stable and whitespace-insensitive", () => {
    const id = historyEntryId("novartis", "storage-block", "hds", "installed", "Novartis has\n deployed it.");
    expect(id).toMatch(/^ih-[0-9a-f]{10}$/);
    expect(historyEntryId("novartis", "storage-block", "hds", "installed", "Novartis has deployed it.")).toBe(id);
  });

  it("round-trips, and refuses a bad change, a bad segment, a bad date or a missing replaced_vendor", () => {
    const f = file([entry({ id: "ih-1" }), entry({ id: "ih-2", change: "replaced", replaced_vendor: "dell" })]);
    expect(parseInstallHistory(renderInstallHistory(f))).toEqual(f);
    const bad = (e: HistoryEntry) => () => parseInstallHistory(renderInstallHistory(file([e])));
    expect(bad(entry({ id: "ih-3", change: "moved" as HistoryEntry["change"] }))).toThrow("ih-3: change must be installed, replaced or removed");
    expect(bad(entry({ id: "ih-4", segment: "mainframe" }))).toThrow('ih-4: invalid segment "mainframe"');
    expect(bad(entry({ id: "ih-5", date: "March" }))).toThrow("ih-5: date must be YYYY-MM-DD");
    expect(bad(entry({ id: "ih-6", change: "replaced" }))).toThrow("ih-6: replaced_vendor is required exactly when change is replaced");
  });

  it("merges a run into the file on disk, keeping the user's decisions", () => {
    const onDisk = file([entry({ id: "ih-1", status: "approved" })]);
    const fromRun: InstallHistoryFile = { sources: { "https://news.test/b": "done" }, entries: [entry({ id: "ih-1", status: "proposed" }), entry({ id: "ih-2", status: "proposed" })] };
    const merged = mergeInstallHistory(onDisk, fromRun);
    expect(merged.entries.map((e) => [e.id, e.status])).toEqual([["ih-1", "approved"], ["ih-2", "proposed"]]);
    expect(merged.sources).toEqual({ "https://news.test/b": "done" });
  });
});

describe("checkHistoryAgainstAccounts", () => {
  it("refuses an approved entry for an unknown account, ignores pending ones", () => {
    expect(() => checkHistoryAgainstAccounts(file([entry({ id: "ih-1", account: "acme" })]), [account({})])).toThrow(
      'ih-1 names unknown account "acme"',
    );
    expect(() => checkHistoryAgainstAccounts(file([entry({ id: "ih-2", account: "acme", status: "proposed" })]), [account({})])).not.toThrow();
  });
});

describe("applyHistory", () => {
  it("fills a missing since on a current incumbent", () => {
    const merged = applyHistory(account({ "storage-block": [declared("hds")] }), [entry({ id: "ih-1" })]);
    expect(merged.history["storage-block"]).toEqual([declared("hds", "2026-03-12")]);
    expect(merged.conflicts).toEqual([]);
  });

  it("adds a past stint, end unknown, for a vendor installed in the news but not current in the file", () => {
    const merged = applyHistory(account({ "storage-block": [declared("dell")] }), [entry({ id: "ih-1", vendor: "pure" })]);
    expect(merged.history["storage-block"]).toContainEqual({ vendor: "pure", since: "2026-03-12", until: "?", source: "news:https://news.test/a" });
    expect(merged.incumbents["storage-block"]).toEqual(["dell"]);
  });

  it("records the replaced vendor's end and the new vendor's start", () => {
    const merged = applyHistory(account({ "storage-block": [declared("hds")] }), [
      entry({ id: "ih-1", change: "replaced", replaced_vendor: "dell" }),
    ]);
    expect(merged.history["storage-block"]).toEqual([
      declared("hds", "2026-03-12"),
      { vendor: "dell", since: "", until: "2026-03-12", source: "news:https://news.test/a" },
    ]);
  });

  // Review of #70: a declared "dell 2019–2026-03" got a second "dell ?–2026-03-12"
  // row because the news date is more precise than the declared one
  it("does not duplicate a declared past stint the news dates more precisely", () => {
    const merged = applyHistory(account({ "storage-block": [declared("hds", "2026-03"), declared("dell", "2019", "2026-03")] }), [
      entry({ id: "ih-1", change: "replaced", replaced_vendor: "dell" }),
      entry({ id: "ih-2", vendor: "dell", date: "2021-06-01" }),
    ]);
    expect(merged.history["storage-block"]).toEqual([declared("hds", "2026-03"), declared("dell", "2019", "2026-03")]);
  });

  it("never overrides the file: news saying a current vendor left becomes a conflict", () => {
    const merged = applyHistory(account({ "storage-block": [declared("dell")] }), [
      entry({ id: "ih-1", change: "removed", vendor: "dell" }),
    ]);
    expect(merged.incumbents["storage-block"]).toEqual(["dell"]);
    expect(merged.history["storage-block"]).toEqual([declared("dell")]);
    expect(merged.conflicts).toEqual([
      "approved news says dell left storage-block on 2026-03-12; accounts.local.yaml still lists it as current",
    ]);
  });

  it("ignores pending entries and other accounts", () => {
    const base = account({ "storage-block": [declared("hds")] });
    const merged = applyHistory(base, [entry({ id: "ih-1", status: "proposed" }), entry({ id: "ih-2", account: "roche" })]);
    expect(merged.history).toEqual(base.history);
  });
});

describe("review fixes — vendors", () => {
  it("refuses an approved entry whose vendor or replaced vendor the graph does not know", () => {
    const known = new Set(["hds", "dell"]);
    expect(() => checkHistoryAgainstAccounts(file([entry({ id: "ih-1", vendor: "hp-inc" })]), [account({})], known)).toThrow(
      'ih-1 names unknown vendor "hp-inc"',
    );
    expect(() =>
      checkHistoryAgainstAccounts(file([entry({ id: "ih-2", change: "replaced", replaced_vendor: "emc" })]), [account({})], known),
    ).toThrow('ih-2 names unknown vendor "emc"');
    expect(() => checkHistoryAgainstAccounts(file([entry({ id: "ih-3" })]), [account({})], known)).not.toThrow();
  });
});

// Review of #70: every run re-rendered the file and dropped the user's comments
describe("mergeInstallHistoryText", () => {
  it("appends the run's new entries and keeps the user's comments on the existing ones", () => {
    const onDisk = renderInstallHistory(file([entry({ id: "ih-1" })])).replace("status: approved", "status: approved # seen in the QBR deck");
    const out = mergeInstallHistoryText(onDisk, file([entry({ id: "ih-1", status: "proposed" }), entry({ id: "ih-2", status: "proposed", date: "2026-04-01" })]));
    expect(out).toContain("status: approved # seen in the QBR deck");
    expect(parseInstallHistory(out).entries.map((e) => [e.id, e.status])).toEqual([["ih-1", "approved"], ["ih-2", "proposed"]]);
  });
});
