// Proposes install-base changes from news with the local 27B (spec
// 2026-10-03-install-history-design.md). Items are pre-filtered without the
// model (they must name an account and a vendor); the model may only answer
// one change from the closed sets, with a verbatim quote; the date is always
// the item's own. Every side effect is injected.
import { SEGMENTS } from "./graph-schema.js";
import { historyEntryId, type HistoryEntry, type InstallHistoryFile } from "./install-history.js";
import { MIN_QUOTE_WORDS } from "./need-evidence-extract.js";
import { normaliseSpace } from "./need-evidence.js";

export interface NewsItem {
  source: string;
  /** YYYY-MM-DD: the item's own date. */
  date: string;
  text: string;
}

export interface NameList {
  id: string;
  names: string[];
}

export interface ProposedChange {
  account: string;
  segment: string;
  vendor: string;
  change: string;
  replaced_vendor?: string;
  quote: string;
}

export type HistoryDrop =
  | "unknown account"
  | "unknown segment"
  | "unknown vendor"
  | "replaced_vendor rule"
  | "quote too short"
  | "quote not in source";

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Ids whose names appear in the text as whole words. */
export function mentioned(text: string, lists: NameList[]): string[] {
  const padded = `-${slug(text)}-`;
  return lists.filter((l) => l.names.some((n) => slug(n) !== "" && padded.includes(`-${slug(n)}-`))).map((l) => l.id);
}

export function candidates(items: NewsItem[], accounts: NameList[], vendors: NameList[]) {
  return items
    .map((item) => ({ item, accounts: mentioned(item.text, accounts), vendors: mentioned(item.text, vendors) }))
    .filter((c) => c.accounts.length > 0 && c.vendors.length > 0);
}

export function historyPrompt(item: NewsItem, accounts: string[], vendors: string[]): string {
  return `Does this news item report that one of these accounts installed, replaced or removed an IT vendor in one segment?

Accounts: ${accounts.join(", ")}
Vendors: ${vendors.join(", ")}
Segments: ${SEGMENTS.join(", ")}

Answer with JSON only:
- a change: {"account": "...", "segment": "...", "vendor": "...", "change": "installed" | "replaced" | "removed", "replaced_vendor": "..." (only for replaced), "quote": "..."}
- or {"none": true} when the item reports no such change.
"quote" is one sentence copied word for word from the item. Use only the names listed above.

Item:
"""
${item.text}
"""`;
}

export function parseHistoryReply(reply: string): ProposedChange | "none" | null {
  const match = reply.match(/\{[\s\S]*\}/);
  if (match === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (p.none === true) return "none";
  const s = (k: string) => (typeof p[k] === "string" ? (p[k] as string).trim() : "");
  if (["account", "segment", "vendor", "change", "quote"].some((k) => s(k) === "")) return null;
  return {
    account: s("account"),
    segment: s("segment"),
    vendor: s("vendor"),
    change: s("change"),
    ...(s("replaced_vendor") !== "" ? { replaced_vendor: s("replaced_vendor") } : {}),
    quote: s("quote"),
  };
}

export function checkChange(p: ProposedChange, item: NewsItem, accounts: string[], vendors: string[]): HistoryDrop | null {
  if (!accounts.includes(p.account)) return "unknown account";
  if (!(SEGMENTS as readonly string[]).includes(p.segment)) return "unknown segment";
  if (!vendors.includes(p.vendor)) return "unknown vendor";
  const replaced = p.change === "replaced";
  if (!["installed", "replaced", "removed"].includes(p.change)) return "replaced_vendor rule";
  if (replaced !== (p.replaced_vendor !== undefined) || (replaced && !vendors.includes(p.replaced_vendor ?? ""))) {
    return "replaced_vendor rule";
  }
  if (normaliseSpace(p.quote).split(" ").length < MIN_QUOTE_WORDS) return "quote too short";
  if (!normaliseSpace(item.text).includes(normaliseSpace(p.quote))) return "quote not in source";
  return null;
}

export async function runHistoryExtraction(
  file: InstallHistoryFile,
  cands: Array<{ item: NewsItem; accounts: string[]; vendors: string[] }>,
  deps: { complete(prompt: string): Promise<string>; today(): string; log(line: string): void },
  options: { onItem?: (file: InstallHistoryFile) => void } = {},
) {
  const result = {
    file: { sources: { ...file.sources }, entries: file.entries.map((e) => ({ ...e })) },
    proposed: [] as HistoryEntry[],
    dropped: {
      "unknown account": 0,
      "unknown segment": 0,
      "unknown vendor": 0,
      "replaced_vendor rule": 0,
      "quote too short": 0,
      "quote not in source": 0,
    } as Record<HistoryDrop, number>,
    skipped: 0,
    failed: 0,
  };
  const known = new Set(result.file.entries.map((e) => e.id));

  for (const c of cands) {
    if (result.file.sources[c.item.source] === "done") {
      result.skipped++;
      continue;
    }
    let reply: ProposedChange | "none" | null;
    try {
      reply = parseHistoryReply(await deps.complete(historyPrompt(c.item, c.accounts, c.vendors)));
    } catch (err) {
      deps.log(`${c.item.source}: model call failed: ${err instanceof Error ? err.message : String(err)}`);
      reply = null;
    }
    if (reply === null) {
      result.failed++;
      continue; // unrecorded: retried next run
    }
    if (reply !== "none") {
      const reason = checkChange(reply, c.item, c.accounts, c.vendors);
      if (reason !== null) result.dropped[reason]++;
      else {
        const id = historyEntryId(reply.account, reply.segment, reply.vendor, reply.change, reply.quote);
        if (!known.has(id)) {
          known.add(id);
          const entry: HistoryEntry = {
            id,
            status: "proposed",
            account: reply.account,
            segment: reply.segment,
            vendor: reply.vendor,
            change: reply.change as HistoryEntry["change"],
            ...(reply.replaced_vendor !== undefined ? { replaced_vendor: reply.replaced_vendor } : {}),
            date: c.item.date,
            quote: reply.quote,
            source: c.item.source,
            extracted: deps.today(),
          };
          result.file.entries.push(entry);
          result.proposed.push(entry);
        }
      }
    }
    result.file.sources[c.item.source] = "done";
    options.onItem?.(result.file);
  }
  return result;
}

export function historyStatusReport(file: InstallHistoryFile): string[] {
  const groups = new Map<string, Record<string, number>>();
  for (const e of file.entries) {
    const key = `${e.account} / ${e.segment}`;
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
    for (const e of next) {
      const what = e.change === "replaced" ? `replaced ${e.replaced_vendor} by ${e.vendor}` : `${e.change} ${e.vendor}`;
      lines.push(`${e.id}  ${e.account} / ${e.segment}  ${what}  ${e.date}  — "${e.quote}" (${e.source})`);
    }
  }
  return lines;
}
