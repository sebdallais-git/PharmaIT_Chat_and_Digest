import { describe, expect, it } from "@jest/globals";
import type { Account } from "../src/services/graph-accounts.js";
import { entryId, type NeedEvidenceFile } from "../src/services/need-evidence.js";
import {
  chunkText,
  checkProposal,
  extractionPrompt,
  legacyDocuments,
  parseExcludeList,
  parseExtractArgs,
  parseReply,
  runExtraction,
  statusReport,
  type ExtractDeps,
} from "../src/services/need-evidence-extract.js";

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

const DOC = "Intro paragraph.\n\nMerck's operations were\ndisrupted for weeks by NotPetya.\n\nLast paragraph.";

function reply(entries: Array<Record<string, string>>): string {
  return `Here you go:\n${JSON.stringify(entries)}`;
}

const GOOD = {
  account: "roche",
  need: "cyber-resilience",
  claim: "Ransomware on a pharma peer halted production for weeks",
  quote: "Merck's operations were disrupted for weeks by NotPetya.",
};

function deps(over: Partial<ExtractDeps> & { docs?: Record<string, string> } = {}): ExtractDeps & { prompts: string[] } {
  const docs = over.docs ?? { "knowledge/a.md": DOC };
  const prompts: string[] = [];
  return {
    documents: () => Object.keys(docs),
    read: async (path) => docs[path],
    complete: async (prompt) => {
      prompts.push(prompt);
      return reply([GOOD]);
    },
    today: () => "2026-10-02",
    log: () => {},
    prompts,
    ...over,
  };
}

const empty = (): NeedEvidenceFile => ({ sources: {}, entries: [] });

describe("chunkText", () => {
  it("splits at paragraph boundaries under the word limit", () => {
    expect(chunkText("a b c\n\nd e\n\nf g h i", 5)).toEqual(["a b c\n\nd e", "f g h i"]);
  });

  it("splits a paragraph longer than the limit by words", () => {
    expect(chunkText("a b c d e f g", 3)).toEqual(["a b c", "d e f", "g"]);
  });
});

describe("parseReply / checkProposal", () => {
  it("reads the JSON array in a reply, keeping at most five well-formed entries", () => {
    const many = Array.from({ length: 7 }, () => GOOD);
    expect(parseReply(reply([...many, { account: "roche" }]))).toHaveLength(5);
    expect(parseReply("no json here")).toBeNull();
  });

  it("drops an unknown account, an undeclared need, a long claim and a quote not in the chunk", () => {
    const chunk = DOC;
    expect(checkProposal({ ...GOOD, account: "acme" }, chunk, [roche])).toBe("unknown account");
    expect(checkProposal({ ...GOOD, need: "sustainability" }, chunk, [roche])).toBe("undeclared need");
    expect(checkProposal({ ...GOOD, claim: "x".repeat(201) }, chunk, [roche])).toBe("claim too long");
    expect(checkProposal({ ...GOOD, quote: "Merck lost several weeks of output to NotPetya." }, chunk, [roche])).toBe(
      "quote not in source",
    );
  });

  it("drops a quote too short to anchor a claim", () => {
    expect(checkProposal({ ...GOOD, quote: "Merck's operations" }, DOC, [roche])).toBe("quote too short");
  });

  it("matches a quote that wraps across lines in the source", () => {
    expect(checkProposal(GOOD, DOC, [roche])).toBeNull();
  });

  it("names each account with its needs in the prompt", () => {
    expect(extractionPrompt("chunk text", [roche])).toContain("roche (Roche): cyber-resilience, gxp-compliance");
  });
});

describe("runExtraction", () => {
  it("appends checked proposals with stable ids and records the document's hash", async () => {
    const result = await runExtraction(empty(), [roche], deps());
    expect(result.proposed).toHaveLength(1);
    expect(result.file.entries[0]).toEqual({
      id: entryId("roche", "cyber-resilience", GOOD.quote),
      status: "proposed",
      ...GOOD,
      source: "knowledge/a.md",
      extracted: "2026-10-02",
    });
    expect(Object.keys(result.file.sources)).toEqual(["knowledge/a.md"]);
  });

  it("keeps the user's decisions and skips unchanged documents on a re-run", async () => {
    const first = await runExtraction(empty(), [roche], deps());
    const decided: NeedEvidenceFile = {
      ...first.file,
      entries: first.file.entries.map((e) => ({ ...e, status: "approved" as const })),
    };
    const d = deps();
    const second = await runExtraction(decided, [roche], d);
    expect(second.skippedDocs).toBe(1);
    expect(d.prompts).toHaveLength(0);
    expect(second.file.entries).toEqual(decided.entries);
  });

  it("does not duplicate an entry met again in a changed document", async () => {
    const first = await runExtraction(empty(), [roche], deps());
    const approved: NeedEvidenceFile = { ...first.file, entries: [{ ...first.file.entries[0], status: "approved" }] };
    const second = await runExtraction(approved, [roche], deps({ docs: { "knowledge/a.md": `${DOC}\n\nAn added paragraph.` } }));
    expect(second.file.entries).toHaveLength(1);
    expect(second.file.entries[0].status).toBe("approved");
  });

  it("counts drops by reason", async () => {
    const result = await runExtraction(
      empty(),
      [roche],
      deps({ complete: async () => reply([{ ...GOOD, account: "acme" }, { ...GOOD, quote: "an invented sentence that appears nowhere at all" }]) }),
    );
    expect(result.dropped).toEqual({
      "unknown account": 1,
      "undeclared need": 0,
      "claim too long": 0,
      "quote too short": 0,
      "quote not in source": 1,
    });
    expect(result.file.entries).toEqual([]);
  });

  it("skips a chunk whose reply fails and retries the document next time", async () => {
    const result = await runExtraction(empty(), [roche], deps({ complete: async () => "not json" }));
    expect(result.failedChunks).toBe(1);
    expect(result.file.sources).toEqual({});
    const thrown = await runExtraction(
      empty(),
      [roche],
      deps({
        complete: async () => {
          throw new Error("stack down");
        },
      }),
    );
    expect(thrown.failedChunks).toBe(1);
    expect(thrown.file.sources).toEqual({});
  });

  it("skips a document it cannot read and carries on, retrying it next time", async () => {
    const d = deps({ docs: { "knowledge/a.md": DOC, "knowledge/b.pdf": DOC } });
    const result = await runExtraction(empty(), [roche], {
      ...d,
      read: async (path) => {
        if (path.endsWith(".pdf")) throw new Error("bad XRef entry");
        return DOC;
      },
    });
    expect(result.failedDocs).toBe(1);
    expect(Object.keys(result.file.sources)).toEqual(["knowledge/a.md"]);
    expect(result.proposed).toHaveLength(1);
  });

  it("hands the file over after every document so a crash loses at most one", async () => {
    const saved: number[] = [];
    await runExtraction(empty(), [roche], deps({ docs: { "knowledge/a.md": DOC, "knowledge/b.md": `${DOC} more` } }), {
      onDocument: (f) => saved.push(Object.keys(f.sources).length),
    });
    expect(saved).toEqual([1, 2]);
  });

  it("processes only the named document", async () => {
    const d = deps({ docs: { "knowledge/a.md": DOC, "knowledge/b.md": DOC } });
    await runExtraction(empty(), [roche], d, { only: "knowledge/b.md" });
    expect(d.prompts).toHaveLength(1);
  });
});

describe("statusReport", () => {
  it("counts statuses per account and need and lists the next proposals", () => {
    const base = { account: "roche", need: "cyber-resilience", claim: "c", source: "knowledge/a.md", extracted: "" };
    const lines = statusReport({
      sources: {},
      entries: [
        { ...base, id: "ne-1", status: "approved", quote: "q1" },
        { ...base, id: "ne-2", status: "proposed", quote: "q2" },
      ],
    });
    expect(lines).toContain("roche / cyber-resilience: 1 approved, 1 proposed, 0 rejected");
    expect(lines).toContain('ne-2  roche / cyber-resilience  c  — "q2" (knowledge/a.md)');
  });
});

describe("documents and arguments", () => {
  it("keeps top-level Markdown, PDF and Word documents only", () => {
    expect(legacyDocuments(["b.md", "vendors", "a.pdf", "c.docx", ".index.mlx.json", "d.txt"])).toEqual([
      "knowledge/a.pdf",
      "knowledge/b.md",
      "knowledge/c.docx",
    ]);
  });

  it("leaves out vendor-authored documents: vendor-*.md and the listed ones", () => {
    // Vendor material is authoritative for what products exist, never evidence
    // of why an account has a need (2026-09-21 spec, source policy).
    expect(
      legacyDocuments(["vendor-dell-cyber-recovery.md", "pharma-basics.md", "Vendor Pitch.pdf", "roche paper.docx"], [
        "Vendor Pitch.pdf",
      ]),
    ).toEqual(["knowledge/pharma-basics.md", "knowledge/roche paper.docx"]);
  });

  it("reads the exclusion list one name per line, ignoring comments and blanks", () => {
    expect(parseExcludeList("# vendor PDFs\nA.pdf\n\n  B.pdf  \n")).toEqual(["A.pdf", "B.pdf"]);
  });

  it("parses the flags and refuses unknown ones", () => {
    expect(parseExtractArgs(["--only", "knowledge/a.md", "--dry-run"])).toEqual({ only: "knowledge/a.md", dryRun: true, status: false });
    expect(parseExtractArgs(["--status"])).toEqual({ dryRun: false, status: true });
    expect(() => parseExtractArgs(["--force"])).toThrow('unknown option "--force"');
  });
});
