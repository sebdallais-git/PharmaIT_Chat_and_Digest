import { describe, expect, it } from "@jest/globals";
import { appendProposals, proposalsDocument } from "../src/services/proposals-file.js";

// The two gitignored proposals files (need evidence, install history) are the
// user's to edit: they approve by changing `status` and may leave notes. The
// review of #67 found a malformed file read as zero entries without a word,
// an entry with no id accepted, and every run dropping the user's comments.

const HEADER = "# proposals\n";

describe("proposalsDocument", () => {
  it("reads sources and entries, and an empty file as none", () => {
    expect(proposalsDocument("sources:\n  a.md: h1\nentries:\n  - id: x-1\n")).toEqual({ sources: { "a.md": "h1" }, entries: [{ id: "x-1" }] });
    expect(proposalsDocument("")).toEqual({ sources: {}, entries: [] });
  });

  it("refuses a file that is not a mapping, entries that are not a list, an entry that is not a mapping or has no id", () => {
    expect(() => proposalsDocument("- id: x-1\n")).toThrow("the file must be a mapping with sources and entries");
    expect(() => proposalsDocument("entries:\n  x-1: {status: approved}\n")).toThrow("entries must be a list");
    expect(() => proposalsDocument("entries:\n  - just text\n")).toThrow("entry 1 must be a mapping");
    expect(() => proposalsDocument("entries:\n  - id: x-1\n  - status: approved\n")).toThrow("entry 2 has no id");
    expect(() => proposalsDocument("entries:\n  - id: x-1\n  - id: x-1\n")).toThrow("duplicate id x-1");
  });
});

describe("appendProposals", () => {
  it("adds new entries and sources and keeps the user's comments and fields", () => {
    const onDisk = `${HEADER}sources:
  a.md: h1
entries:
  # checked with the account team on 2026-10-02
  - id: x-1
    status: approved # Roche confirmed
    note: keep
`;
    const out = appendProposals(onDisk, HEADER, { "a.md": "h1", "b.md": "h2" }, [{ id: "x-2", status: "proposed" }]);
    expect(out).toContain("# checked with the account team on 2026-10-02");
    expect(out).toContain("status: approved # Roche confirmed");
    expect(out).toContain("note: keep");
    expect(proposalsDocument(out)).toEqual({
      sources: { "a.md": "h1", "b.md": "h2" },
      entries: [{ id: "x-1", status: "approved", note: "keep" }, { id: "x-2", status: "proposed" }],
    });
  });

  // Review of this branch: a first save with nothing to add wrote `entries: []`,
  // and every later entry was appended inside that one-line flow list
  it("writes entries one per block even after a save that added none", () => {
    const empty = appendProposals("", HEADER, { "a.md": "h1" }, []);
    const out = appendProposals(empty, HEADER, { "a.md": "h1" }, [{ id: "x-1", status: "proposed" }]);
    expect(out).toContain("entries:\n  - id: x-1\n    status: proposed\n");
    expect(proposalsDocument(out).entries).toEqual([{ id: "x-1", status: "proposed" }]);
  });

  it("keeps a file that holds only comments, and its comments", () => {
    const onlyComments = `${HEADER}# cleared on 2026-10-03\n`;
    const out = appendProposals(onlyComments, HEADER, { "a.md": "h1" }, [{ id: "x-1", status: "proposed" }]);
    expect(out).toContain("# cleared on 2026-10-03");
    expect(proposalsDocument(out)).toEqual({ sources: { "a.md": "h1" }, entries: [{ id: "x-1", status: "proposed" }] });
  });

  it("writes a fresh file with the header when there is none", () => {
    const out = appendProposals("", HEADER, { "a.md": "h1" }, [{ id: "x-1", status: "proposed" }]);
    expect(out.startsWith(HEADER)).toBe(true);
    expect(proposalsDocument(out).entries).toEqual([{ id: "x-1", status: "proposed" }]);
  });
});
