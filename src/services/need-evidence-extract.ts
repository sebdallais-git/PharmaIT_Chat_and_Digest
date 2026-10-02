// One-off extraction of need evidence from the legacy documents with the local
// 27B (spec 2026-10-02-need-evidence-design.md). Every side effect is
// injected: scripts/extract-need-evidence.ts binds files and the active stack.
//
// The model only proposes; checks drop what cannot be right (an account or
// need outside the user's, an over-long claim, a quote not in the text), and
// the user approves the rest in the proposals file.
import { createHash } from "node:crypto";
import type { Account } from "./graph-accounts.js";
import {
  MAX_CLAIM_CHARS,
  entryId,
  normaliseSpace,
  type NeedEvidenceEntry,
  type NeedEvidenceFile,
} from "./need-evidence.js";

export const CHUNK_WORDS = 2500;
export const MAX_PER_CHUNK = 5;
/** A quote shorter than this anchors nothing: "Roche" is in every Roche document. */
export const MIN_QUOTE_WORDS = 6;
export const LEGACY_EXTENSIONS = [".md", ".pdf", ".docx"];

export interface ProposedEntry {
  account: string;
  need: string;
  claim: string;
  quote: string;
}

export type DropReason = "unknown account" | "undeclared need" | "claim too long" | "quote too short" | "quote not in source";

export interface ExtractDeps {
  documents(): string[];
  read(path: string): Promise<string>;
  complete(prompt: string): Promise<string>;
  today(): string;
  log(line: string): void;
}

export interface ExtractResult {
  file: NeedEvidenceFile;
  /** Entries appended by this run. */
  proposed: NeedEvidenceEntry[];
  dropped: Record<DropReason, number>;
  skippedDocs: number;
  failedChunks: number;
  /** Documents that could not be read (a broken PDF): left unrecorded, retried next run. */
  failedDocs: number;
}

export interface ExtractArgs {
  only?: string;
  dryRun: boolean;
  status: boolean;
}

const words = (text: string): string[] => text.split(/\s+/).filter((w) => w.length > 0);

/** ~maxWords per chunk, at paragraph boundaries; a paragraph longer than that is split by words. */
export function chunkText(text: string, maxWords = CHUNK_WORDS): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let count = 0;
  const flush = () => {
    if (current.length > 0) chunks.push(current.join("\n\n"));
    current = [];
    count = 0;
  };
  for (const paragraph of text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0)) {
    const w = words(paragraph);
    if (w.length > maxWords) {
      flush();
      for (let i = 0; i < w.length; i += maxWords) chunks.push(w.slice(i, i + maxWords).join(" "));
      continue;
    }
    if (count + w.length > maxWords) flush();
    current.push(paragraph);
    count += w.length;
  }
  flush();
  return chunks;
}

export function extractionPrompt(chunk: string, accounts: Account[]): string {
  const list = accounts.map((a) => `- ${a.id} (${a.name}): ${a.needs.join(", ")}`).join("\n");
  return `You read an excerpt of a document and find facts that explain why one of these accounts has one of its needs.

Accounts and their needs:
${list}

Rules:
- Use only the accounts and needs listed above.
- "claim": one line, under ${MAX_CLAIM_CHARS} characters, saying why that account has that need.
- "quote": one sentence copied word for word from the excerpt that supports the claim.
- A fact about the whole sector may be given for several accounts, one entry each.
- At most ${MAX_PER_CHUNK} entries. If nothing in the excerpt applies, answer [].

Answer with a JSON array only: [{"account": "...", "need": "...", "claim": "...", "quote": "..."}]

Excerpt:
"""
${chunk}
"""`;
}

export function parseReply(reply: string): ProposedEntry[] | null {
  const match = reply.match(/\[[\s\S]*\]/);
  if (match === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed
    .filter((p): p is Record<string, unknown> => p !== null && typeof p === "object")
    .filter((p) => ["account", "need", "claim", "quote"].every((k) => typeof p[k] === "string" && (p[k] as string).trim() !== ""))
    .map((p) => ({ account: String(p.account), need: String(p.need), claim: String(p.claim).trim(), quote: String(p.quote).trim() }))
    .slice(0, MAX_PER_CHUNK);
}

export function checkProposal(p: ProposedEntry, chunk: string, accounts: Account[]): DropReason | null {
  const account = accounts.find((a) => a.id === p.account);
  if (account === undefined) return "unknown account";
  if (!(account.needs as readonly string[]).includes(p.need)) return "undeclared need";
  if (p.claim.length > MAX_CLAIM_CHARS) return "claim too long";
  if (words(p.quote).length < MIN_QUOTE_WORDS) return "quote too short";
  // A guard against invented quotes, not a trust signal: whitespace and line
  // wraps are forgiven, wording is not.
  if (!normaliseSpace(chunk).includes(normaliseSpace(p.quote))) return "quote not in source";
  return null;
}

export async function runExtraction(
  file: NeedEvidenceFile,
  accounts: Account[],
  deps: ExtractDeps,
  // onDocument receives the file after each document, so the caller can save
  // progress: a crash or Ctrl-C then loses at most the document in hand.
  options: { only?: string; onDocument?: (file: NeedEvidenceFile) => void } = {},
): Promise<ExtractResult> {
  const result: ExtractResult = {
    file: { sources: { ...file.sources }, entries: file.entries.map((e) => ({ ...e })) },
    proposed: [],
    dropped: { "unknown account": 0, "undeclared need": 0, "claim too long": 0, "quote too short": 0, "quote not in source": 0 },
    skippedDocs: 0,
    failedChunks: 0,
    failedDocs: 0,
  };
  const known = new Set(result.file.entries.map((e) => e.id));

  for (const doc of deps.documents().filter((d) => options.only === undefined || d === options.only)) {
    let text: string;
    try {
      text = await deps.read(doc);
    } catch (err) {
      deps.log(`${doc}: cannot be read, skipped: ${err instanceof Error ? err.message : String(err)}`);
      result.failedDocs++;
      continue;
    }
    const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
    if (result.file.sources[doc] === hash) {
      result.skippedDocs++;
      continue;
    }

    let docFailed = false;
    for (const [i, chunk] of chunkText(text).entries()) {
      let entries: ProposedEntry[] | null;
      try {
        entries = parseReply(await deps.complete(extractionPrompt(chunk, accounts)));
      } catch (err) {
        deps.log(`${doc} chunk ${i + 1}: model call failed: ${err instanceof Error ? err.message : String(err)}`);
        entries = null;
      }
      if (entries === null) {
        deps.log(`${doc} chunk ${i + 1}: skipped (no usable reply)`);
        result.failedChunks++;
        docFailed = true;
        continue;
      }
      for (const p of entries) {
        const reason = checkProposal(p, chunk, accounts);
        if (reason !== null) {
          result.dropped[reason]++;
          continue;
        }
        const id = entryId(p.account, p.need, p.quote);
        if (known.has(id)) continue; // the user's decision on it stays
        known.add(id);
        const entry: NeedEvidenceEntry = { id, status: "proposed", ...p, source: doc, extracted: deps.today() };
        result.file.entries.push(entry);
        result.proposed.push(entry);
      }
    }
    // A failed chunk leaves the document unrecorded, so the next run retries it.
    if (!docFailed) result.file.sources[doc] = hash;
    options.onDocument?.(result.file);
  }
  return result;
}

export function statusReport(file: NeedEvidenceFile): string[] {
  const groups = new Map<string, Record<string, number>>();
  for (const e of file.entries) {
    const key = `${e.account} / ${e.need}`;
    const counts = groups.get(key) ?? { approved: 0, proposed: 0, rejected: 0 };
    counts[e.status]++;
    groups.set(key, counts);
  }
  const lines = [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, c]) => `${key}: ${c.approved} approved, ${c.proposed} proposed, ${c.rejected} rejected`);
  const next = file.entries.filter((e) => e.status === "proposed").slice(0, 10);
  if (next.length > 0) {
    lines.push("", "Next to review:");
    for (const e of next) lines.push(`${e.id}  ${e.account} / ${e.need}  ${e.claim}  — "${e.quote}" (${e.source})`);
  }
  return lines;
}

/**
 * Vendor material is authoritative for what products exist, never evidence of
 * why an account has a need (2026-09-21 spec, source policy): extracted, it
 * turns a pitch into "Roche requires ransomware-proof architecture".
 * vendor-*.md are left out by name; other vendor documents by the list in
 * config/need-evidence.exclude.
 */
export function legacyDocuments(names: string[], excluded: string[] = []): string[] {
  return names
    .filter((n) => LEGACY_EXTENSIONS.some((ext) => n.toLowerCase().endsWith(ext)))
    .filter((n) => !n.startsWith("vendor-") && !excluded.includes(n))
    .sort()
    .map((n) => `knowledge/${n}`);
}

/** One file name per line; "#" starts a comment. */
export function parseExcludeList(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter((line) => line.length > 0);
}

export function parseExtractArgs(argv: string[]): ExtractArgs {
  const args: ExtractArgs = { dryRun: false, status: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--only") args.only = argv[++i];
    else if (flag === "--dry-run") args.dryRun = true;
    else if (flag === "--status") args.status = true;
    else throw new Error(`unknown option "${flag}"`);
  }
  return args;
}
