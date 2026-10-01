import { describe, expect, it } from "@jest/globals";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_CLAIMS,
  MAX_DETAIL_CHARS,
  excerptBrief,
  loadBriefExcerpts,
} from "../src/services/vendor-brief-excerpts.js";

const FRONTMATTER = [
  "---",
  "vendor: dell",
  "segment: storage-block",
  "position: leader",
  "confidence: high",
  "as_of: 2026-09-21",
  "products: [PowerMax]",
  "rationale: >",
  "  Strong block portfolio.",
  "sources:",
  "  - https://example.test/a",
  "  - https://example.test/b",
  "---",
].join("\n");

function brief(body: string): string {
  return `${FRONTMATTER}\n\n${body}`;
}

const BODY = [
  "## Portfolio — what Dell sells",
  "",
  "PowerMax for mission-critical block.",
  "",
  "## Where Dell is strong — with evidence",
  "",
  "**Largest installed base.** Dell ships more external block arrays than anyone ([Blocks & Files](https://example.test/x)).",
  "",
  "**Cyber vault.** PowerProtect Cyber Recovery is bundled.",
  "",
  "## Where Dell is weak — mandatory",
  "",
  "- **Storage lags.** Storage shrank 1% while AI servers grew.",
  "- Follows Everpure on commercial terms.",
  "",
  "## Pharma relevance",
  "",
  "GxP validation packs.",
].join("\n");

describe("excerptBrief", () => {
  it("takes the bold lead of each paragraph as the claim and the rest as detail", () => {
    const { excerpt, problems } = excerptBrief("dell-storage-block.md", brief(BODY));
    expect(problems).toEqual([]);
    expect(excerpt.vendor).toBe("dell");
    expect(excerpt.segment).toBe("storage-block");
    expect(excerpt.strong).toEqual([
      { claim: "Largest installed base.", detail: "Dell ships more external block arrays than anyone (Blocks & Files)." },
      { claim: "Cyber vault.", detail: "PowerProtect Cyber Recovery is bundled." },
    ]);
  });

  it("reads list items as separate claims, with or without a bold lead", () => {
    const { excerpt } = excerptBrief("dell-storage-block.md", brief(BODY));
    expect(excerpt.weak).toEqual([
      { claim: "Storage lags.", detail: "Storage shrank 1% while AI servers grew." },
      { claim: "Follows Everpure on commercial terms.", detail: "" },
    ]);
  });

  it("keeps the brief's sources", () => {
    expect(excerptBrief("f.md", brief(BODY)).excerpt.sources).toEqual(["https://example.test/a", "https://example.test/b"]);
  });

  it("caps the number of claims and clips long details at a word boundary", () => {
    const paragraphs = Array.from({ length: 6 }, (_, i) => `**Claim ${i}.** ${"word ".repeat(100)}`).join("\n\n");
    const { excerpt } = excerptBrief("f.md", brief(`## Where Dell is strong\n\n${paragraphs}\n\n## Where Dell is weak\n\n**W.** w`));
    expect(excerpt.strong).toHaveLength(MAX_CLAIMS);
    for (const claim of excerpt.strong) {
      expect(claim.detail.length).toBeLessThanOrEqual(MAX_DETAIL_CHARS + 1);
      expect(claim.detail.endsWith("word…")).toBe(true);
    }
  });

  it("reports a brief with no weak section instead of hiding it", () => {
    const { excerpt, problems } = excerptBrief("f.md", brief("## Where Dell is strong\n\n**S.** s"));
    expect(excerpt.weak).toEqual([]);
    expect(problems).toEqual(['f.md: no "Where … is weak" section (the spec makes it mandatory)']);
  });
});

describe("loadBriefExcerpts", () => {
  it("keys excerpts by vendor/segment and reports, not throws, on a bad brief", () => {
    const files: Record<string, string> = {
      "dell-storage-block.md": brief(BODY),
      "broken.md": "no frontmatter here",
      "notes.txt": "ignored",
    };
    const result = loadBriefExcerpts("/briefs", {
      readDir: () => Object.keys(files),
      readFile: (path) => files[path.replace("/briefs/", "")],
    });
    expect([...result.excerpts.keys()]).toEqual(["dell/storage-block"]);
    expect(result.errors).toEqual(["broken.md: vendor brief has no frontmatter block"]);
  });

  it("reports an unreadable directory", () => {
    const result = loadBriefExcerpts("/missing", {
      readDir: () => {
        throw new Error("ENOENT");
      },
      readFile: () => "",
    });
    expect(result.excerpts.size).toBe(0);
    expect(result.errors).toEqual(["cannot read /missing: ENOENT"]);
  });

  // Read-only check against the committed briefs (files in the repo, not a live service):
  // every brief must yield at least one strong and one weak claim, or the tool would
  // silently answer with empty excerpts.
  it("finds strong and weak claims in every committed brief", () => {
    const dir = join(process.cwd(), "knowledge", "vendors");
    const result = loadBriefExcerpts(dir, { readDir: (d) => readdirSync(d), readFile: (p) => readFileSync(p, "utf8") });
    expect(result.errors).toEqual([]);
    expect(result.excerpts.size).toBeGreaterThan(0);
    for (const excerpt of result.excerpts.values()) {
      expect(excerpt.strong.length).toBeGreaterThan(0);
      expect(excerpt.weak.length).toBeGreaterThan(0);
    }
  });
});
