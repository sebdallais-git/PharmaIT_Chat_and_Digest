// Short, quotable excerpts from the curated vendor briefs (knowledge/vendors).
//
// The curated vector chunks are cut from these same files, so reading them
// directly gives the curated tier without an embedding call, a stack dependency
// or the index guard, and keeps the answer deterministic. Only headline claims
// are returned: a tool result that carried whole documents once put 48k tokens
// into a single call.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { standingKey } from "./competitive-position.js";
import { parseVendorBrief } from "./graph-schema.js";

export interface Claim {
  claim: string;
  detail: string;
}

export interface BriefExcerpt {
  vendor: string;
  segment: string;
  file: string;
  strong: Claim[];
  weak: Claim[];
  sources: string[];
}

export interface BriefExcerpts {
  /** Keyed by standingKey(vendor, segment). */
  excerpts: Map<string, BriefExcerpt>;
  errors: string[];
}

export const MAX_CLAIMS = 4;
export const MAX_DETAIL_CHARS = 240;
export const MAX_SOURCES = 5;

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// Links become their text: the URL is noise in an excerpt and the brief's
// sources list already carries the citations.
function plain(text: string): string {
  return text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim();
}

/** The text under the first `## ` heading matching `pattern`, or null when there is none. */
function section(body: string, pattern: RegExp): string | null {
  for (const part of body.split(/^## /m).slice(1)) {
    const newline = part.indexOf("\n");
    const heading = newline === -1 ? part : part.slice(0, newline);
    if (pattern.test(heading)) return newline === -1 ? "" : part.slice(newline + 1);
  }
  return null;
}

function claims(text: string): Claim[] {
  const blocks = text.split(/\n\s*\n/).flatMap((block) =>
    /^\s*[-*] /.test(block) ? block.split(/\n(?=\s*[-*] )/).map((item) => item.replace(/^\s*[-*] /, "")) : [block],
  );
  return blocks
    .map((block) => block.trim())
    .filter((block) => block.length > 0 && !block.startsWith("#"))
    .slice(0, MAX_CLAIMS)
    .map((block): Claim => {
      const lead = /^\*\*([\s\S]+?)\*\*\s*([\s\S]*)$/.exec(block);
      return lead
        ? { claim: plain(lead[1]), detail: clip(plain(lead[2]), MAX_DETAIL_CHARS) }
        : { claim: clip(plain(block), MAX_DETAIL_CHARS), detail: "" };
    });
}

/** Excerpt one brief. Throws only when the frontmatter is invalid (parseVendorBrief). */
export function excerptBrief(file: string, markdown: string): { excerpt: BriefExcerpt; problems: string[] } {
  const brief = parseVendorBrief(markdown);
  const strong = section(brief.body, /^Where .+ is strong/i);
  const weak = section(brief.body, /^Where .+ is weak/i);

  const problems: string[] = [];
  if (strong === null) problems.push(`${file}: no "Where … is strong" section`);
  if (weak === null) problems.push(`${file}: no "Where … is weak" section (the spec makes it mandatory)`);

  return {
    excerpt: {
      vendor: brief.vendor,
      segment: brief.segment,
      file,
      strong: claims(strong ?? ""),
      weak: claims(weak ?? ""),
      sources: brief.sources.slice(0, MAX_SOURCES),
    },
    problems,
  };
}

const realFs = {
  readDir: (dir: string): string[] => readdirSync(dir),
  readFile: (path: string): string => readFileSync(path, "utf8"),
};

/**
 * Excerpt every brief in `dir`. One bad brief is reported, not thrown: the
 * query tool should still answer for the vendors whose briefs are fine.
 * (The graph rebuild is the opposite -- it refuses a bad brief outright.)
 */
export function loadBriefExcerpts(dir: string, fs = realFs): BriefExcerpts {
  const excerpts = new Map<string, BriefExcerpt>();
  const errors: string[] = [];

  let files: string[];
  try {
    files = fs.readDir(dir).filter((f) => f.endsWith(".md")).sort();
  } catch (err) {
    return { excerpts, errors: [`cannot read ${dir}: ${(err as Error).message}`] };
  }

  for (const file of files) {
    try {
      const { excerpt, problems } = excerptBrief(file, fs.readFile(join(dir, file)));
      const key = standingKey(excerpt.vendor, excerpt.segment);
      const existing = excerpts.get(key);
      if (existing !== undefined) {
        errors.push(`${file}: duplicates ${existing.file} for ${key}; kept ${existing.file}`);
        continue;
      }
      excerpts.set(key, excerpt);
      errors.push(...problems);
    } catch (err) {
      errors.push(`${file}: ${(err as Error).message}`);
    }
  }

  return { excerpts, errors };
}
