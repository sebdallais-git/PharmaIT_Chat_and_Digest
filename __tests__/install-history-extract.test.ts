import { describe, expect, it } from "@jest/globals";
import {
  candidates,
  checkChange,
  historyStatusReport,
  mentioned,
  historyVendorNames,
  parseHistoryReply,
  runHistoryExtraction,
  type NewsItem,
} from "../src/services/install-history-extract.js";
import type { InstallHistoryFile } from "../src/services/install-history.js";

const accounts = [{ id: "novartis", names: ["novartis", "Novartis", "Sandoz"] }];
const vendors = [
  { id: "hds", names: ["hds", "Hitachi Vantara"] },
  { id: "dell", names: ["dell", "Dell Technologies"] },
];
const ITEM: NewsItem = {
  key: "https://news.test/a",
  source: "https://news.test/a",
  date: "2026-03-12",
  text: "Novartis has replaced its Dell arrays with Hitachi Vantara storage across its EU manufacturing sites.",
};
const GOOD = {
  account: "novartis",
  segment: "storage-block",
  vendor: "hds",
  change: "replaced",
  replaced_vendor: "dell",
  quote: "Novartis has replaced its Dell arrays with Hitachi Vantara storage",
};
const empty = (): InstallHistoryFile => ({ sources: {}, entries: [] });

describe("prefilter", () => {
  it("finds account and vendor names as whole words, aliases included", () => {
    expect(mentioned(ITEM.text, vendors).sort()).toEqual(["dell", "hds"]);
    expect(mentioned("Dellwood news", vendors)).toEqual([]);
  });

  it("keeps only items naming both an account and a vendor", () => {
    const other: NewsItem = { key: "x", source: "x", date: "2026-01-01", text: "Novartis opens a new site in Basel." };
    expect(candidates([ITEM, other], accounts, vendors).map((c) => c.item.source)).toEqual(["https://news.test/a"]);
  });
});

describe("reply and checks", () => {
  it("reads one change, none, or nothing usable", () => {
    expect(parseHistoryReply(`ok: ${JSON.stringify(GOOD)}`)).toEqual(GOOD);
    expect(parseHistoryReply('{"none": true}')).toBe("none");
    expect(parseHistoryReply("no json")).toBeNull();
  });

  it("drops unknown names, the replaced_vendor rule, short quotes and invented quotes", () => {
    const a = ["novartis"];
    const v = ["hds", "dell"];
    expect(checkChange({ ...GOOD, account: "roche" }, ITEM, a, v)).toBe("unknown account");
    expect(checkChange({ ...GOOD, segment: "mainframe" }, ITEM, a, v)).toBe("unknown segment");
    expect(checkChange({ ...GOOD, vendor: "pure" }, ITEM, a, v)).toBe("unknown vendor");
    expect(checkChange({ ...GOOD, replaced_vendor: undefined }, ITEM, a, v)).toBe("replaced_vendor rule");
    expect(checkChange({ ...GOOD, quote: "Novartis replaced Dell" }, ITEM, a, v)).toBe("quote too short");
    expect(checkChange({ ...GOOD, quote: "Novartis moved every workload to Hitachi Vantara last year" }, ITEM, a, v)).toBe("quote not in source");
    expect(checkChange(GOOD, ITEM, a, v)).toBeNull();
  });
});

describe("runHistoryExtraction", () => {
  const cands = candidates([ITEM], accounts, vendors);

  it("proposes a checked change dated by the item, never by the model", async () => {
    const result = await runHistoryExtraction(empty(), cands, {
      complete: async () => JSON.stringify({ ...GOOD, date: "1999-01-01" }),
      today: () => "2026-10-03",
      log: () => {},
    });
    expect(result.proposed).toHaveLength(1);
    expect(result.file.entries[0]).toMatchObject({ status: "proposed", date: "2026-03-12", source: "https://news.test/a", change: "replaced", replaced_vendor: "dell" });
    expect(result.file.sources).toEqual({ "https://news.test/a": "done" });
  });

  it("skips processed items, retries failed ones, and saves after each item", async () => {
    const saved: number[] = [];
    const failed = await runHistoryExtraction(empty(), cands, {
      complete: async () => {
        throw new Error("stack down");
      },
      today: () => "2026-10-03",
      log: () => {},
    });
    expect(failed.failed).toBe(1);
    expect(failed.file.sources).toEqual({});
    const done = await runHistoryExtraction(
      { sources: { "https://news.test/a": "done" }, entries: [] },
      cands,
      { complete: async () => JSON.stringify(GOOD), today: () => "2026-10-03", log: () => {} },
      { onItem: (f) => saved.push(f.entries.length) },
    );
    expect(done.skipped).toBe(1);
    expect(saved).toEqual([]);
  });

  it("reports counts and the next proposals", () => {
    const lines = historyStatusReport({
      sources: {},
      entries: [
        { id: "ih-1", status: "proposed", account: "novartis", segment: "storage-block", vendor: "hds", change: "installed", date: "2026-03-12", quote: "q", source: "s", extracted: "" },
      ],
    });
    expect(lines).toContain("novartis / storage-block: 0 approved, 1 proposed, 0 rejected");
    expect(lines).toContain('ih-1  novartis / storage-block  installed hds  2026-03-12  — "q" (s)');
  });
});

describe("review fixes", () => {
  it("resumes per document, not per source: archive news shares one source per day", async () => {
    const day = (key: string, text: string): NewsItem => ({ key, source: "news-2026-06-23", date: "2026-06-23", text });
    const items = [
      day("news-a.json", ITEM.text),
      day("news-b.json", "Novartis has removed its Dell arrays from every manufacturing site this quarter."),
    ];
    const prompts: string[] = [];
    const result = await runHistoryExtraction(empty(), candidates(items, accounts, vendors), {
      complete: async (p) => {
        prompts.push(p);
        return '{"none": true}';
      },
      today: () => "2026-10-03",
      log: () => {},
    });
    expect(prompts).toHaveLength(2);
    expect(Object.keys(result.file.sources).sort()).toEqual(["news-a.json", "news-b.json"]);
  });

  it("names graph vendors by their own ids, plus the watchlist names of the same entity", () => {
    expect(
      historyVendorNames(["hds", "dell", "hp"], [
        { id: "dell", name: "Dell Technologies", aliases: ["Dell EMC"] },
        { id: "hp-inc", name: "HP Inc", aliases: [] },
      ]),
    ).toEqual([
      { id: "hds", names: ["hds"] },
      { id: "dell", names: ["dell", "Dell Technologies", "Dell EMC"] },
      { id: "hp", names: ["hp"] },
    ]);
  });
});
