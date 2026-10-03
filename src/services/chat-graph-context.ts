// Graph context for a chat turn: the incumbency-first competitive position when
// the message names one vendor or one account, the keyword lookup otherwise.
//
// The competitive path can only add to what the chat gets: any failure, a slow
// graph included, falls back to the keyword lookup. Everything live is
// injected, so no test reaches Neo4j; src/api/chat.ts binds the real services.
import { basename } from "node:path";
import {
  competitivePositionFrom,
  TEXT_TRIM_STEPS,
  fitBudget,
  readGraphSnapshot,
  type CompetitiveAnswer,
  type AnswerSegment,
  type CompetitiveDeps,
  type EvidenceItem,
} from "./competitive-graph.js";
import type { CompetitiveQuery, GraphSnapshot } from "./competitive-position.js";

/** ~1.5k tokens: the graph block shares the chat prompt with retrieval and live news. */
export const CHAT_CONTEXT_CHARS = 6_000;
export const COMPETITIVE_TIMEOUT_MS = 2_500;

export interface ChatGraphDeps {
  competitive: CompetitiveDeps;
  keywordLookup(keywords: string[]): Promise<string>;
  log?: (message: string) => void;
  timeoutMs?: number;
}

export interface ChatGraphContext {
  source: "competitive" | "keyword" | "none";
  /** "dell @ roche" for the reasoning stream; null outside the competitive path. */
  label: string | null;
  text: string;
}

// Names compared as dash-padded slugs give whole-word matching across case,
// punctuation and possessives: "-pure-storage-s-roadmap-" contains "-pure-storage-".
function slug(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function mentioned(names: Map<string, string>, padded: string): string[] {
  const ids = new Set<string>();
  for (const [name, id] of names) {
    if (name.length > 0 && padded.includes(`-${name}-`)) ids.add(id);
  }
  return [...ids];
}

/**
 * The query a message pins down, or null. A dimension the message names more
 * than once is left out ("Dell vs HPE at Roche" asks about Roche across
 * vendors), so a match never guesses between two names.
 */
export function matchCompetitiveQuery(message: string, snap: GraphSnapshot): CompetitiveQuery | null {
  const padded = `-${slug(message)}-`;

  const vendorNames = new Map<string, string>(snap.vendors.map((v) => [slug(v), v]));
  for (const [alias, vendor] of Object.entries(snap.vendorAliases)) {
    // Watchlist aliases name customers too; only a graph vendor is a vendor.
    if (snap.vendors.includes(vendor)) vendorNames.set(slug(alias), vendor);
  }
  const accountNames = new Map<string, string>();
  for (const a of snap.accounts) for (const name of [a.id, a.name, ...a.aliases]) accountNames.set(slug(name), a.id);

  const vendors = mentioned(vendorNames, padded);
  const accounts = mentioned(accountNames, padded);
  const query: CompetitiveQuery = {};
  // A vendor no brief positions (in the graph only as someone's incumbent)
  // would answer "displace, position unknown" in every segment: noise in a
  // prompt. It still counts above as a second name.
  if (vendors.length === 1 && snap.positions.some((p) => p.vendor === vendors[0])) query.vendor = vendors[0];
  if (accounts.length === 1) query.account = accounts[0];
  return query.vendor === undefined && query.account === undefined ? null : query;
}

function header(query: CompetitiveAnswer["query"]): string {
  const dims = (["vendor", "account", "segment"] as const)
    .filter((k) => query[k] !== null)
    .map((k) => `${k} ${query[k]}`);
  return `[Graph Context: competitive position, ${dims.join(", ")}]`;
}

function label(query: CompetitiveAnswer["query"]): string {
  if (query.vendor !== null && query.account !== null) return `${query.vendor} @ ${query.account}`;
  return query.vendor ?? query.account ?? query.segment ?? "all";
}

const CUT_NOTE = "… (cut to fit the chat context: ask about one vendor, account or segment for the rest)";

const HISTORY_WORDING = /\b(history|over time|previously|before|used to|since when|who had)\b/i;

/** The chat asks for the full install history only when the message is about the past. */
export function wantsFullHistory(message: string): boolean {
  return HISTORY_WORDING.test(message);
}

function stintText(s: { vendor: string; since: string; until: string; source: string }): string {
  return `${s.vendor} ${s.since || "?"}–${s.until === "" ? "now" : s.until} (${s.source})`;
}

function eventLine(e: EvidenceItem): string {
  return `    ↳ ${e.publishedAt} [${e.signal ?? "untagged"}] ${e.title}`;
}

/** The answer as prompt text, within the chat budget. */
export function renderCompetitiveContext(answer: CompetitiveAnswer, budget = CHAT_CONTEXT_CHARS): string {
  const a = structuredClone(answer);
  // Measured as text, not JSON: claim details and source URLs never reach the
  // prompt, and counting them would trim the account events away first. Text
  // order: events are short lines, so all of them go last.
  fitBudget(a, budget, (x) => renderLines(x).length, TEXT_TRIM_STEPS);
  let text = renderLines(a);
  // fitBudget never drops structure, so many accounts can still overflow:
  // cut at a line boundary and say so.
  if (text.length > budget) {
    const room = budget - CUT_NOTE.length - 1;
    text = `${text.slice(0, text.lastIndexOf("\n", room))}\n${CUT_NOTE}`;
  }
  return text;
}

function rankingLine(s: AnswerSegment): string {
  if (s.ranking === null) return "    ranking: none, find out who is installed";
  const ranking = s.ranking;
  const hidden = s.hidden ?? [];
  // How many share a rank: the listed ones plus those hidden at it. "2=" marks a
  // shared rank, or a shown vendor reads as uniquely placed when its peers are hidden.
  const tied = (rank: number): number =>
    ranking.filter((r) => r.rank === rank).length + (hidden.find((h) => h.rank === rank)?.count ?? 0);
  const shown = ranking.map((r) => {
    const n = tied(r.rank);
    return `${r.rank}${n > 1 ? "=" : ""} ${r.vendor} (${[...r.reasons, ...(n > 1 ? [`tied with ${n - 1}`] : [])].join(", ")})`;
  });
  for (const h of hidden) shown.push(`+${h.count} more tied at ${h.rank}`);
  if (s.unranked !== undefined) shown.push(`${s.unranked} (no brief, not ranked)`);
  return `    ranking (${s.regime}): ${shown.join(" · ") || "nobody ranked"}`;
}

function renderLines(a: CompetitiveAnswer): string {
  const lines = [header(a.query)];
  const modes = Object.entries(a.modes);
  if (modes.length > 0) {
    lines.push("Incumbency modes:");
    for (const [mode, guidance] of modes) lines.push(`- ${mode}: ${guidance}`);
  }
  for (const account of a.accounts) {
    lines.push(`${account.name} (${account.account}), needs: ${account.needs.join(", ") || "none recorded"}`);
    for (const [need, reasons] of Object.entries(account.needEvidence)) {
      for (const e of reasons) lines.push(`  why ${need}: ${e.claim} (${basename(e.source)})`);
    }
    if (account.general.length > 0) lines.push("  general:", ...account.general.map(eventLine));
    for (const s of account.segments) {
      const via = s.via.length > 0 ? ` (via ${s.via.join(", ")})` : "";
      lines.push(`  ${s.segment}${via}, installed: ${s.incumbents.join(", ") || "nobody"}`);
      if (s.history !== undefined && s.history.length > 0) {
        const label = a.query.history === "full" ? "history" : "changed";
        const older = s.olderChanges !== undefined ? ` · +${s.olderChanges} older` : "";
        lines.push(`    ${label}: ${s.history.map(stintText).join(" · ")}${older}`);
      }
      if (s.trigger !== null) lines.push(`    trigger: ${s.trigger}`);
      lines.push(rankingLine(s));
      lines.push(...s.events.map(eventLine));
      for (const v of s.vendors) lines.push(`    ${v.vendor}: ${v.mode}, position ${v.position ?? "unknown"}`);
    }
  }
  if (a.market.length > 0) {
    lines.push("Market positions:");
    for (const m of a.market) lines.push(`- ${m.vendor} in ${m.segment}: ${m.position}`);
  }
  const standings = Object.entries(a.standings);
  if (standings.length > 0) {
    lines.push("Standings:");
    for (const [key, s] of standings) {
      const rationale = s.rationale !== undefined ? ` ${s.rationale}` : "";
      lines.push(`- ${key}: ${s.position} (${s.confidence} confidence, as of ${s.asOf}).${rationale}`);
      if (s.strong.length > 0) lines.push(`  strong: ${s.strong.map((c) => c.claim).join(" ")}`);
      if (s.weak.length > 0) lines.push(`  weak: ${s.weak.map((c) => c.claim).join(" ")}`);
    }
  }
  const news = Object.entries(a.evidence).flatMap(([vendor, items]) =>
    items.map((i) => `- ${vendor}: ${i.title} (${i.publishedAt}) ${i.url}`),
  );
  if (news.length > 0) lines.push("Recent news:", ...news);
  if (a.notes.length > 0) lines.push("Notes:", ...a.notes.map((n) => `- ${n}`));

  return lines.join("\n");
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`competitive graph timed out after ${ms} ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

async function competitiveContext(message: string, deps: ChatGraphDeps): Promise<ChatGraphContext | null> {
  const snapshot = await readGraphSnapshot(deps.competitive.runCypher, deps.competitive.vendorAliases());
  const query = matchCompetitiveQuery(message, snapshot);
  if (query === null) return null;
  if (wantsFullHistory(message)) query.history = "full";
  const result = await competitivePositionFrom(deps.competitive, snapshot, query);
  if (!result.ok) throw new Error(result.error);
  return { source: "competitive", label: label(result.answer.query), text: renderCompetitiveContext(result.answer) };
}

export async function chatGraphContext(message: string, keywords: string[], deps: ChatGraphDeps): Promise<ChatGraphContext> {
  const log = deps.log ?? ((m: string) => console.error(m));
  try {
    const competitive = await withTimeout(competitiveContext(message, deps), deps.timeoutMs ?? COMPETITIVE_TIMEOUT_MS);
    if (competitive !== null) return competitive;
  } catch (err) {
    log(`[Graph] competitive context unavailable, using keyword lookup: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = keywords.length > 0 ? await deps.keywordLookup(keywords) : "";
  return text.length > 0 ? { source: "keyword", label: null, text } : { source: "none", label: null, text: "" };
}
