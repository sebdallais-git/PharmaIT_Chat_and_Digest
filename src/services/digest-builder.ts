// The digest agent: turns a period's watchlist items into a role-driven digest.
//
// Selection is deterministic (sections, ranking, caps are code over the item
// store); the local model only writes about the items it is handed, and every
// bullet it writes must cite item numbers that exist ([3]), or it is dropped.
// Several short calls rather than one long one: single answers hit the output
// cap too often (watchlist design spec, "Digests").
//
// Order of sections: headline, your accounts, the infrastructure scene, the
// pharma industry, cyber, AI & cloud, R&D and manufacturing IT, then action
// items that translate the news into sales activity for each portfolio line the
// active role sells. Rendered within a character budget: Telegram cuts a
// message at 4096, and Hermes cuts scheduled-job output at 4000.

import { THEATERS, type Domain, type Entity, type Theater, type Watchlist } from "./watchlist-config.js";
import type { StoredItem } from "./watchlist-store.js";
import type { DigestRequest } from "./digest-request.js";
import { PORTFOLIO_LINES, portfolioText, roleLabel, type PortfolioLine, type Role } from "./role-store.js";

export type SectionKey = "accounts" | "infrastructure" | "industry" | "cyber" | "aiCloud" | "rdMfg";

export const SECTION_TITLES: Record<SectionKey, string> = {
  accounts: "Your accounts",
  infrastructure: "Infrastructure scene",
  industry: "Pharma industry",
  cyber: "Cyber",
  aiCloud: "AI, cloud & data",
  rdMfg: "R&D and manufacturing IT",
};

const SECTION_ORDER: SectionKey[] = ["accounts", "infrastructure", "industry", "cyber", "aiCloud", "rdMfg"];
const SECTION_CAPS: Record<SectionKey, number> = { accounts: 8, infrastructure: 8, industry: 5, cyber: 5, aiCloud: 5, rdMfg: 4 };
const INFRA_DOMAINS: Domain[] = ["infrastructure", "storage", "backup", "networking", "euc"];
const AI_CLOUD_DOMAINS: Domain[] = ["ai", "cloud", "data", "sap"];
const RD_MFG_DOMAINS: Domain[] = ["rnd_it", "mfg_it"];

export interface NumberedItem {
  n: number;
  item: StoredItem;
  section: SectionKey;
}

// "Your accounts" split by headquarters theater. One group with a null theater
// when the accounts all sit in one theater (or none has a theater).
export interface AccountGroup {
  theater: Theater | null;
  entries: NumberedItem[];
}

export interface DigestSelection {
  sections: Record<SectionKey, NumberedItem[]>;
  // The accounts section again, grouped; its entries are the same objects
  accountGroups: AccountGroup[];
  numbered: NumberedItem[];
  accountIds: string[];
  // Role accounts the watchlist does not follow, so the digest cannot cover them
  unmatchedAccounts: string[];
  itemsInPeriod: number;
}

function findEntity(watchlist: Watchlist, name: string): Entity | null {
  const wanted = name.trim().toLowerCase();
  for (const entity of watchlist.entities.values()) {
    if (entity.id === wanted || entity.name.toLowerCase() === wanted || entity.aliases.some((a) => a.toLowerCase() === wanted)) {
      return entity;
    }
  }
  return null;
}

/** The role's accounts as watchlist entity ids; with no role, the watchlist's customers. */
export function resolveAccounts(watchlist: Watchlist, role: Role | null): { ids: string[]; unmatched: string[] } {
  if (!role) {
    return { ids: [...watchlist.entities.values()].filter((e) => e.kind === "customer").map((e) => e.id), unmatched: [] };
  }
  const ids: string[] = [];
  const unmatched: string[] = [];
  for (const account of role.accounts) {
    const entity = findEntity(watchlist, account);
    if (entity) ids.push(entity.id);
    else unmatched.push(account);
  }
  return { ids, unmatched };
}

function overlaps<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.some((x) => b.includes(x));
}

function sectionFor(item: StoredItem, accountIds: string[], watchlist: Watchlist): SectionKey | null {
  if (overlaps(item.entities, accountIds)) return "accounts";
  if (overlaps(item.domains, INFRA_DOMAINS)) return "infrastructure";
  const pharma = item.entities.some((id) => {
    const kind = watchlist.entities.get(id)?.kind;
    return kind === "customer" || kind === "peer";
  });
  if (pharma && item.domains.length === 0) return "industry";
  if (item.domains.includes("cyber")) return "cyber";
  if (overlaps(item.domains, AI_CLOUD_DOMAINS)) return "aiCloud";
  if (overlaps(item.domains, RD_MFG_DOMAINS)) return "rdMfg";
  return pharma ? "industry" : null;
}

function matchesFocus(item: StoredItem, request: DigestRequest, accountIds: string[], watchlist: Watchlist): boolean {
  if (request.accountsOnly) {
    const peers = new Set(accountIds.flatMap((id) => watchlist.entities.get(id)?.peers ?? []));
    if (!item.entities.some((id) => accountIds.includes(id) || peers.has(id))) return false;
  }
  if (request.theater) {
    // "digest EMEA": another theater's customer news stays out of every section,
    // unless the item also names a customer headquartered in the theater asked for
    const theaters = item.entities.map((id) => watchlist.entities.get(id)).filter((e) => e?.kind === "customer" && e.theater).map((e) => e?.theater);
    if (theaters.length > 0 && !theaters.includes(request.theater)) return false;
  }
  if (request.focusEntities.length > 0 && !overlaps(item.entities, request.focusEntities)) return false;
  if (request.focusDomains.length > 0 && !overlaps(item.domains, request.focusDomains)) return false;
  return true;
}

function byImportance(a: StoredItem, b: StoredItem): number {
  return (b.importance ?? 0) - (a.importance ?? 0) || b.publishedAt.localeCompare(a.publishedAt);
}

// Every account gets its turn: its best item, then the next account's, and so
// on. Live on 2026-09-30, ranking alone gave all eight slots to Roche (25 items)
// over Novartis (3) and Sandoz (2).
function roundRobin(items: StoredItem[], accountIds: string[]): StoredItem[] {
  const queues = accountIds.map((id) => items.filter((item) => item.entities.includes(id)).sort(byImportance));
  const out: StoredItem[] = [];
  const seen = new Set<number>();
  for (let round = 0; queues.some((q) => q.length > round); round++) {
    for (const queue of queues) {
      const next = queue[round];
      if (next && !seen.has(next.id)) {
        seen.add(next.id);
        out.push(next);
      }
    }
  }
  return out;
}

// Per theater when grouped: three theaters at 4 items each stay close to the
// ungrouped 8 while every theater gets a voice
const THEATER_CAP = 4;

const sizeRank = (watchlist: Watchlist, id: string): number => watchlist.entities.get(id)?.size?.rank ?? Number.MAX_SAFE_INTEGER;

/** Accounts per theater in Americas, EMEA, APAC order; one null group unless they span two or more. */
export function groupAccounts(accountIds: string[], watchlist: Watchlist): { theater: Theater | null; ids: string[] }[] {
  const byTheater = new Map<Theater, string[]>();
  const without: string[] = [];
  for (const id of accountIds) {
    const theater = watchlist.entities.get(id)?.theater;
    if (theater) byTheater.set(theater, [...(byTheater.get(theater) ?? []), id]);
    else without.push(id);
  }
  if (byTheater.size < 2) return [{ theater: null, ids: accountIds }];
  const groups: { theater: Theater | null; ids: string[] }[] = THEATERS.filter((t) => byTheater.has(t)).map((t) => ({ theater: t, ids: byTheater.get(t) ?? [] }));
  // Role accounts the watchlist has no theater for still get covered, last
  if (without.length) groups.push({ theater: null, ids: without });
  return groups;
}

export function selectDigestItems(
  items: StoredItem[],
  request: DigestRequest,
  watchlist: Watchlist,
  role: Role | null,
): DigestSelection {
  const resolved = resolveAccounts(watchlist, role);
  const unmatched = resolved.unmatched;
  // Size rank first (the biggest account leads each round); unranked keep their order
  const accountIds = resolved.ids
    .filter((id) => !request.theater || watchlist.entities.get(id)?.theater === request.theater)
    .map((id, i) => ({ id, i }))
    .sort((a, b) => sizeRank(watchlist, a.id) - sizeRank(watchlist, b.id) || a.i - b.i)
    .map(({ id }) => id);
  const focused = request.focusEntities.length > 0 || request.focusDomains.length > 0 || request.accountsOnly;
  const buckets: Record<SectionKey, StoredItem[]> = { accounts: [], infrastructure: [], industry: [], cyber: [], aiCloud: [], rdMfg: [] };
  for (const item of items) {
    if (!matchesFocus(item, request, accountIds, watchlist)) continue;
    const section = sectionFor(item, accountIds, watchlist);
    if (!section) continue;
    // Low-importance items only make it into a focused digest or an account's own section
    if (!focused && section !== "accounts" && (item.importance ?? 0) < 2) continue;
    buckets[section].push(item);
  }
  const sections = {} as Record<SectionKey, NumberedItem[]>;
  const numbered: NumberedItem[] = [];
  const number = (item: StoredItem, key: SectionKey): NumberedItem => {
    const entry = { n: numbered.length + 1, item, section: key };
    numbered.push(entry);
    return entry;
  };
  const groups = groupAccounts(accountIds, watchlist);
  const grouped = groups.length > 1;
  // An item about accounts in two theaters is told once, in the first
  const told = new Set<number>();
  const accountGroups: AccountGroup[] = groups
    .map(({ theater, ids }) => {
      const picked = roundRobin(buckets.accounts.filter((item) => !told.has(item.id)), ids).slice(0, grouped ? THEATER_CAP : SECTION_CAPS.accounts);
      for (const item of picked) told.add(item.id);
      return { theater, entries: picked.map((item) => number(item, "accounts")) };
    })
    .filter((group) => group.entries.length > 0);
  sections.accounts = accountGroups.flatMap((group) => group.entries);
  for (const key of SECTION_ORDER) {
    if (key === "accounts") continue;
    sections[key] = buckets[key].sort(byImportance).slice(0, SECTION_CAPS[key]).map((item) => number(item, key));
  }
  return { sections, accountGroups, numbered, accountIds, unmatchedAccounts: unmatched, itemsInPeriod: items.length };
}

// ---- Model-written parts --------------------------------------------------

export type CompleteFn = (prompt: string, maxTokens: number) => Promise<string>;

function itemLines(entries: NumberedItem[], watchlist: Watchlist): string {
  return entries
    .map(({ n, item }) => {
      const who = item.entities.map((id) => watchlist.entities.get(id)?.name ?? id).join(", ");
      const summary = item.summary.replace(/\s+/g, " ").slice(0, 280);
      return `[${n}] ${item.title} (${item.sourceName}, ${item.publishedAt.slice(0, 10)}${who ? `; ${who}` : ""})${summary ? `: ${summary}` : ""}`;
    })
    .join("\n");
}

function sellerLine(role: Role | null): string {
  return role
    ? `The reader is ${roleLabel(role)}, covering ${role.accounts.join(", ")}, selling ${portfolioText(role.portfolio)}.${role.focus ? ` Current focus: ${role.focus}.` : ""}`
    : `The reader sells infrastructure (${portfolioText(PORTFOLIO_LINES)}) to pharmaceutical companies.`;
}

const bulletRules = (words: number) =>
  `Write only bullets, one per line, each starting with "- ", at most ${words} words each. End every bullet with the numbers of the items it rests on, like [3] or [2][5]. Use only facts from the items. No introduction, no closing line.`;

export function headlinePrompt(entries: NumberedItem[], role: Role | null, watchlist: Watchlist, period: string): string {
  return `${sellerLine(role)}
News items from ${period}:
${itemLines(entries, watchlist)}

Write 3 or 4 bullets: the developments that matter most to this reader, most important first. ${bulletRules(25)}`;
}

export function accountsPrompt(entries: NumberedItem[], role: Role | null, watchlist: Watchlist): string {
  return `${sellerLine(role)}
News about their accounts:
${itemLines(entries, watchlist)}

Write at most one bullet per account, combining that account's items: name the account, what happened, and what it means for this seller there. ${bulletRules(30)}`;
}

export function infrastructurePrompt(entries: NumberedItem[], role: Role | null, watchlist: Watchlist): string {
  return `${sellerLine(role)}
Infrastructure market and vendor news:
${itemLines(entries, watchlist)}

Write up to 4 bullets on what moved in the infrastructure market and why it matters when selling to pharma: competitor moves, product launches, pricing or supply signals. ${bulletRules(30)}`;
}

const LINE_NAMES: Record<PortfolioLine, string> = {
  storage: "Storage",
  servers: "Servers",
  networking: "Networking",
  backup: "Backup",
  euc: "End-user computing",
  security: "Security",
};

export function actionsPrompt(entries: NumberedItem[], role: Role | null, watchlist: Watchlist): string {
  const lines = role?.portfolio.length ? role.portfolio : [...PORTFOLIO_LINES];
  const company = role?.company ?? "the seller's company";
  return `${sellerLine(role)}
This period's news:
${itemLines(entries, watchlist)}

Turn this news into sales action items for the reader. One bullet per line of business, in this order: ${lines.map((l) => LINE_NAMES[l]).join(", ")}.
Each bullet: "- **<line>** · <account>: <one concrete next step>", e.g. who to contact, what to propose from ${company}'s portfolio, which event or pain to use as the opening. Tie it to a named account where the news allows. Name ${company} product families, never model numbers. Skip a line only when no item gives any reason to act on it.
${bulletRules(35)}`;
}

// A bullet that says there is nothing to say. Live on 2026-09-30 the model wrote
// six "No action; item is unrelated" action items for one mis-tagged story.
const EMPTY_BULLET = /\b(no action|no relevant|not relevant|unrelated|nothing to (report|do)|no (news|update)s?\b)/i;

/** Keeps bullets that cite at least one known item; strips references to unknown ones. */
export function parseBullets(reply: string, known: Set<number>, max: number): string[] {
  const bullets: string[] = [];
  for (const raw of reply.split("\n")) {
    const line = raw.trim();
    if (!/^[-*•]\s+/.test(line)) continue;
    let cited = false;
    const text = line
      .replace(/^[-*•]\s+/, "")
      .replace(/\[(\d{1,3})\]/g, (ref, n: string) => {
        if (known.has(Number(n))) {
          cited = true;
          return ref;
        }
        return "";
      })
      .trim();
    if (cited && text.length > 0 && !EMPTY_BULLET.test(text)) bullets.push(text);
    if (bullets.length >= max) break;
  }
  return bullets;
}

export interface DigestProse {
  headline: string[];
  accounts: string[];
  // Grouped selections: the account bullets per theater, written in one call each
  byTheater?: Partial<Record<Theater, string[]>>;
  infrastructure: string[];
  actions: string[];
}

async function write(complete: CompleteFn, prompt: string, known: Set<number>, max: number, maxTokens: number): Promise<string[]> {
  try {
    return parseBullets(await complete(prompt, maxTokens), known, max);
  } catch {
    // A failed call leaves that part to the deterministic item list
    return [];
  }
}

export async function writeProse(
  selection: DigestSelection,
  role: Role | null,
  watchlist: Watchlist,
  period: string,
  complete: CompleteFn,
  briefing = false,
): Promise<DigestProse> {
  const { sections, numbered } = selection;
  const known = (entries: NumberedItem[]) => new Set(entries.map((e) => e.n));
  // Grouped: one short call per theater (3 bullets weekly, 2 in the briefing);
  // otherwise one call for all accounts, as before
  const writeAccounts = async (): Promise<Pick<DigestProse, "accounts" | "byTheater">> => {
    if (sections.accounts.length === 0) return { accounts: [] };
    const theaters = selection.accountGroups.filter((g): g is AccountGroup & { theater: Theater } => g.theater !== null);
    if (theaters.length === 0) return { accounts: await write(complete, accountsPrompt(sections.accounts, role, watchlist), known(sections.accounts), 5, 450) };
    const byTheater: Partial<Record<Theater, string[]>> = {};
    for (const group of theaters) {
      byTheater[group.theater] = await write(complete, accountsPrompt(group.entries, role, watchlist), known(group.entries), briefing ? 2 : 3, 300);
    }
    // Accounts without a theater (a role's, never the watchlist's customers) keep the plain call
    const rest = selection.accountGroups.find((g) => g.theater === null);
    const accounts = rest ? await write(complete, accountsPrompt(rest.entries, role, watchlist), known(rest.entries), briefing ? 2 : 3, 300) : [];
    return { accounts, byTheater };
  };
  if (briefing) {
    // Accounts and what to do about them
    const written = await writeAccounts();
    const actions = await write(complete, actionsPrompt(sections.accounts, role, watchlist), known(sections.accounts), 6, 500);
    return { headline: [], ...written, infrastructure: [], actions };
  }
  const top = [...numbered].sort((a, b) => byImportance(a.item, b.item)).slice(0, 10);
  const forActions = [...sections.accounts, ...sections.infrastructure, ...sections.cyber, ...sections.rdMfg].slice(0, 18);
  const headline = top.length ? await write(complete, headlinePrompt(top, role, watchlist, period), known(top), 4, 300) : [];
  const written = await writeAccounts();
  const infrastructure = sections.infrastructure.length
    ? await write(complete, infrastructurePrompt(sections.infrastructure, role, watchlist), known(sections.infrastructure), 4, 400)
    : [];
  const actions = forActions.length ? await write(complete, actionsPrompt(forActions, role, watchlist), known(forActions), 6, 500) : [];
  return { headline, ...written, infrastructure, actions };
}

// ---- Rendering -------------------------------------------------------------

export interface DigestFooter {
  failingFeeds: { feedId: string; failures: number }[];
}

export interface RenderOptions {
  budget: number;
  period: string;
  role: Role | null;
  now: Date;
  // The weekday briefing: accounts and action items only, no footer
  briefing?: boolean;
}

interface Variant {
  links: boolean;
  // Items kept per deterministic list section; 0 leaves those sections out
  listCap: number;
  headline: number;
  infrastructure: number;
  accounts: number;
}

function day(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function renderRefs(text: string, byNumber: Map<number, StoredItem>, links: boolean): string {
  return text.replace(/\[(\d{1,3})\]/g, (_ref, n: string) => {
    const url = byNumber.get(Number(n))?.urls[0] ?? byNumber.get(Number(n))?.urlCanonical;
    return links && url ? `[[${n}]](${url})` : "";
  }).replace(/\s+([.,;])/g, "$1").trim();
}

function renderList(entries: NumberedItem[], links: boolean): string[] {
  return entries.map(({ item }) => {
    const url = item.urls[0] ?? item.urlCanonical;
    const title = links && url ? `[${item.title}](${url})` : item.title;
    return `- ${title} · ${item.sourceName}, ${day(item.publishedAt)}`;
  });
}

// Bullets per theater for a variant's account allowance: 3 while there is
// room, then 2, and never fewer than 1, so no theater drops out of the digest
function theaterCap(accounts: number): number {
  return accounts >= 4 ? 3 : accounts >= 3 ? 2 : 1;
}

function renderTheaters(selection: DigestSelection, prose: DigestProse, variant: Variant, refs: (text: string) => string): string[] {
  const out: string[] = [];
  for (const group of selection.accountGroups) {
    const written = group.theater ? prose.byTheater?.[group.theater] ?? [] : prose.accounts;
    const lines = written.length
      ? written.slice(0, theaterCap(variant.accounts)).map((b) => `- ${refs(b)}`)
      : renderList(group.entries.slice(0, Math.max(1, variant.listCap)), variant.links);
    out.push("", `**${SECTION_TITLES.accounts}${group.theater ? ` · ${group.theater}` : ""}**`, ...lines);
  }
  return out;
}

function renderVariant(selection: DigestSelection, prose: DigestProse, footer: DigestFooter, options: RenderOptions, variant: Variant): string {
  const byNumber = new Map(selection.numbered.map((e) => [e.n, e.item]));
  const refs = (text: string) => renderRefs(text, byNumber, variant.links);
  const who = options.role ? ` for ${roleLabel(options.role)}` : "";
  const out: string[] = [`**${options.briefing ? "Briefing" : "Digest"} · ${options.period}**${who}`];
  if (!options.role) out.push('_No role set: tell me who you are ("I am the Dell GAM for Roche, Novartis and Sandoz") for targeted action items._');

  if (selection.numbered.length === 0) {
    out.push("", "Nothing in the watchlist matches this period and focus.");
  } else {
    const headline = prose.headline.slice(0, variant.headline);
    if (headline.length) out.push("", ...headline.map((b) => `- ${refs(b)}`));
    for (const key of SECTION_ORDER) {
      const entries = selection.sections[key];
      if (entries.length === 0) continue;
      if (key === "accounts" && selection.accountGroups.some((g) => g.theater !== null)) {
        out.push(...renderTheaters(selection, prose, variant, refs));
        continue;
      }
      const written =
        key === "accounts" ? prose.accounts.slice(0, variant.accounts) : key === "infrastructure" ? prose.infrastructure.slice(0, variant.infrastructure) : [];
      const hasProse = key === "accounts" ? prose.accounts.length > 0 : key === "infrastructure" ? prose.infrastructure.length > 0 : false;
      const lines = hasProse ? written.map((b) => `- ${refs(b)}`) : renderList(entries.slice(0, variant.listCap), variant.links);
      if (lines.length) out.push("", `**${SECTION_TITLES[key]}**`, ...lines);
    }
    if (prose.actions.length) out.push("", "**Action items**", ...prose.actions.map((b) => `- ${refs(b)}`));
  }

  // The weekly digest reports coverage and failing feeds; repeating them every morning is noise
  if (options.briefing) return out.join("\n");
  const notes: string[] = [`${selection.itemsInPeriod} items in the period`];
  if (selection.unmatchedAccounts.length) notes.push(`not in the watchlist: ${selection.unmatchedAccounts.join(", ")}`);
  const failing = footer.failingFeeds.slice(0, 3).map((f) => `${f.feedId.split(":")[0]} (${f.failures}×)`);
  if (failing.length) notes.push(`failing feeds: ${failing.join(", ")}`);
  out.push("", `_${notes.join(" · ")}_`);
  return out.join("\n");
}

/**
 * Renders the digest within `budget` characters. Gives way in this order: links,
 * the plain item lists, then the headline, infrastructure and account bullets.
 * The action items are never shortened: they are the point of the digest.
 */
export function renderDigest(selection: DigestSelection, prose: DigestProse, footer: DigestFooter, options: RenderOptions): string {
  const variants: Variant[] = [
    { links: true, listCap: 5, headline: 4, infrastructure: 4, accounts: 5 },
    { links: false, listCap: 5, headline: 4, infrastructure: 4, accounts: 5 },
    { links: false, listCap: 3, headline: 4, infrastructure: 4, accounts: 5 },
    { links: false, listCap: 1, headline: 4, infrastructure: 4, accounts: 5 },
    { links: false, listCap: 0, headline: 3, infrastructure: 3, accounts: 5 },
    { links: false, listCap: 0, headline: 2, infrastructure: 2, accounts: 4 },
    { links: false, listCap: 0, headline: 1, infrastructure: 1, accounts: 3 },
    { links: false, listCap: 0, headline: 0, infrastructure: 0, accounts: 2 },
    { links: false, listCap: 0, headline: 0, infrastructure: 0, accounts: 0 },
  ];
  let last = "";
  for (const variant of variants) {
    last = renderVariant(selection, prose, footer, options, variant);
    if (last.length <= options.budget) return last;
  }
  return last;
}

// ---- Orchestration -----------------------------------------------------------

export interface DigestDeps {
  itemsInPeriod(from: string, to: string): StoredItem[];
  failingFeeds(): DigestFooter["failingFeeds"];
  watchlist: Watchlist;
  role: Role | null;
  complete: CompleteFn;
  now(): Date;
}

export interface DigestResult {
  markdown: string;
  period: string;
  items: number;
  // The same digest rendered within options.fullBudget (the email's copy)
  fullMarkdown?: string;
}

export interface DigestOptions {
  // Yesterday's account news and action items only; empty when there is none
  briefing?: boolean;
  // Also render the same prose within this budget: no extra model call
  fullBudget?: number;
}

export async function buildDigest(request: DigestRequest, deps: DigestDeps, budget: number, options: DigestOptions = {}): Promise<DigestResult> {
  const items = deps.itemsInPeriod(request.from.toISOString(), request.to.toISOString());
  let selection = selectDigestItems(items, request, deps.watchlist, deps.role);
  if (options.briefing) {
    const quiet = { markdown: "", period: request.label, items: 0 };
    // Importance 1 is the tagger's "barely relevant", where mis-tagged stories sit.
    // An empty result is how the Hermes job stays silent on a quiet day.
    const worth = (e: NumberedItem) => (e.item.importance ?? 0) >= 2;
    const accountGroups = selection.accountGroups
      .map((group) => ({ ...group, entries: group.entries.filter(worth) }))
      .filter((group) => group.entries.length > 0);
    const accounts = accountGroups.flatMap((group) => group.entries);
    if (accounts.length === 0) return quiet;
    const empty = { accounts, infrastructure: [], industry: [], cyber: [], aiCloud: [], rdMfg: [] };
    selection = { ...selection, sections: empty, accountGroups, numbered: accounts };
  }
  const prose = await writeProse(selection, deps.role, deps.watchlist, request.label, deps.complete, options.briefing === true);
  // A briefing exists to prompt action: with none left, say nothing
  if (options.briefing && prose.actions.length === 0) return { markdown: "", period: request.label, items: 0 };
  const footer = { failingFeeds: deps.failingFeeds() };
  const render = (limit: number) =>
    renderDigest(selection, prose, footer, { budget: limit, period: request.label, role: deps.role, now: deps.now(), briefing: options.briefing === true });
  const markdown = render(budget);
  return {
    markdown,
    period: request.label,
    items: selection.numbered.length,
    ...(options.fullBudget !== undefined ? { fullMarkdown: render(options.fullBudget) } : {}),
  };
}
