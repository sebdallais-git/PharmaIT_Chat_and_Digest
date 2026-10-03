// Reads the vendor-intelligence graph for competitive_position, and turns the
// resolver's answer into the compact JSON the tool returns.
//
// Everything live is injected (Cypher runner, brief files), so no test reaches
// Neo4j; src/services/competitive-graph-live.ts binds the real ones.
import {
  MODE_GUIDANCE,
  REGIME_GUIDANCE,
  resolveCompetitivePosition,
  type AccountView,
  type CompetitiveQuery,
  type CompetitiveResolution,
  type GraphSnapshot,
  type IncumbencyMode,
  type SegmentView,
  type SnapshotAccount,
  type Standing,
} from "./competitive-position.js";
import type { Regime } from "./segment-ranking.js";
import type { BriefExcerpts, Claim } from "./vendor-brief-excerpts.js";

export type RunCypher = (query: string, params?: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;

export interface EvidenceItem {
  title: string;
  url: string;
  publishedAt: string;
  /** The watchlist signal (it_move, corporate, cyber, financial); null when the tagger gave none. */
  signal: string | null;
}

export interface CompetitiveDeps {
  runCypher: RunCypher;
  briefs(): BriefExcerpts;
  vendorAliases(): Record<string, string>;
}

export const ACCOUNTS_CYPHER = `
  MATCH (a:Account)
  OPTIONAL MATCH (a)-[:HAS_NEED]->(n:Need)
  WITH a, collect(DISTINCT n.id) AS needs
  OPTIONAL MATCH (a)-[u:USES]->(v:Vendor)
  RETURN a.id AS id, a.name AS name, a.aliases AS aliases, a.declaredSegments AS declaredSegments,
         a.triggers AS triggers, a.historyConflicts AS historyConflicts, needs,
         collect(CASE WHEN v IS NULL THEN null ELSE {segment: u.segment, vendor: v.id, since: u.since, until: u.until,
                                                      source: u.source} END) AS uses
  ORDER BY id
`;

export const NEED_SEGMENTS_CYPHER = `
  MATCH (n:Need)-[:ADDRESSED_BY]->(s:Segment)
  RETURN n.id AS need, collect(s.id) AS segments
  ORDER BY need
`;

export const POSITIONS_CYPHER = `
  MATCH (v:Vendor)-[c:COMPETES_IN]->(s:Segment)
  RETURN v.id AS vendor, s.id AS segment, c.position AS position, c.confidence AS confidence,
         c.rationale AS rationale, c.asOf AS asOf
  ORDER BY vendor, segment
`;

export const VENDORS_CYPHER = `MATCH (v:Vendor) RETURN v.id AS id ORDER BY id`;

export const ACCOUNT_EVIDENCE_CYPHER = `
  MATCH (e:Evidence)-[s:SUPPORTS]->(a:Account)
  WHERE a.id IN $accounts AND coalesce(e.kind, "watchlist") = "watchlist"
  RETURN a.id AS account, s.segments AS segments, e.title AS title, e.url AS url,
         e.publishedAt AS publishedAt, e.signal AS signal
  ORDER BY publishedAt DESC, url
`;

export const VENDOR_EVIDENCE_CYPHER = `
  MATCH (e:Evidence)-[s:SUPPORTS]->(v:Vendor {id: $vendor})
  WHERE coalesce(e.kind, "watchlist") = "watchlist" AND any(segment IN s.segments WHERE segment IN $segments)
  RETURN e.title AS title, e.url AS url, e.publishedAt AS publishedAt, e.signal AS signal
  ORDER BY publishedAt DESC, url
`;

/** Approved reasons why an account has a need (need-evidence.ts), in the file's order. */
export const NEED_EVIDENCE_CYPHER = `
  MATCH (e:Evidence {kind: "reference"})-[s:SUPPORTS]->(a:Account)
  WHERE a.id IN $accounts
  RETURN a.id AS account, s.need AS need, e.claim AS claim, e.quote AS quote, e.source AS source
  ORDER BY e.order
`;

export const EVIDENCE_PER_VENDOR = 3;
export const EVENTS_PER_SEGMENT = 3;
export const GENERAL_PER_ACCOUNT = 3;
export const NEED_EVIDENCE_PER_NEED = 3;
/** ~6k tokens: room in a 64K context for the question, the answer and the model's own reasoning. */
export const MAX_ANSWER_CHARS = 24_000;
export const TRIMMED_RATIONALE_CHARS = 200;
export const TRIMMED_SOURCES = 2;

export interface AnswerStanding extends Omit<Standing, "rationale"> {
  /** Absent only when the answer budget forced it out (a note says so). */
  rationale?: string;
  /** false when no brief file backs the graph's position. */
  curated: boolean;
  strong: Claim[];
  weak: Claim[];
  sources: string[];
}

export interface AnswerSegment extends SegmentView {
  /** Newest account news in this segment's domains: triggering events, lifecycle moves. */
  events: EvidenceItem[];
}

export interface NeedEvidenceItem {
  claim: string;
  quote: string;
  source: string;
}

export interface AnswerAccount extends Omit<AccountView, "segments"> {
  segments: AnswerSegment[];
  /** Newest account news that maps to no segment (reorganisations, results, sites). */
  general: EvidenceItem[];
  /** The user's approved reasons why the account has each need; needs without one are absent. */
  needEvidence: Record<string, NeedEvidenceItem[]>;
}

export interface CompetitiveAnswer {
  query: CompetitiveResolution["query"];
  /** What each incumbency mode in this answer means; only the modes that occur. */
  modes: Partial<Record<IncumbencyMode, string>>;
  /** What each ranking regime in this answer means; only the regimes that occur. */
  regimes: Partial<Record<Regime, string>>;
  market: CompetitiveResolution["market"];
  accounts: AnswerAccount[];
  standings: Record<string, AnswerStanding>;
  evidence: Record<string, EvidenceItem[]>;
  notes: string[];
}

export type CompetitiveResult = { ok: true; answer: CompetitiveAnswer } | { ok: false; error: string };

// A Neo4j row is Record<string, unknown>: a missing property must fail loudly
// rather than reach the model as the word "undefined" (same rule as
// export-wiring.ts).
function str(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`competitive-graph: row is missing required field "${field}"`);
  }
  return value;
}

function strList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`competitive-graph: row is missing required field "${field}"`);
  return value.map((entry, i) => str(entry, `${field}[${i}]`));
}

function uses(value: unknown): SnapshotAccount["uses"] {
  if (!Array.isArray(value)) throw new Error('competitive-graph: row is missing required field "uses"');
  return value.map((entry, i) => {
    const row = (entry ?? {}) as Record<string, unknown>;
    return {
      segment: str(row.segment, `uses[${i}].segment`),
      vendor: str(row.vendor, `uses[${i}].vendor`),
      // Absent on graphs built before history: read as current and declared.
      since: typeof row.since === "string" ? row.since : "",
      until: typeof row.until === "string" ? row.until : "",
      source: typeof row.source === "string" && row.source !== "" ? row.source : "declared",
    };
  });
}

// graph-accounts.ts stores lists comma-joined (Neo4j properties are scalars or lists of scalars).
function commaList(value: unknown): string[] {
  return (typeof value === "string" ? value : "")
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
}

// graph-accounts.ts stores triggers as JSON (Neo4j properties cannot be maps).
// A graph built before triggers existed has none; a bad value is reported and
// ignored, never thrown: one account's typo must not take every answer down.
function triggers(value: unknown, account: string, notes: string[]): Record<string, string> {
  if (value === undefined || value === null) return {};
  try {
    const parsed: unknown = typeof value === "string" ? JSON.parse(value) : null;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Object.values(parsed).every((v) => typeof v === "string")
    ) {
      return { ...(parsed as Record<string, string>) };
    }
  } catch {
    // Reported below.
  }
  notes.push(`account ${account}: unreadable triggers, ignored until the next rebuild`);
  return {};
}

function jsonStrings(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function evidenceItem(row: Record<string, unknown>): EvidenceItem {
  return {
    title: str(row.title, "title"),
    url: str(row.url, "url"),
    publishedAt: str(row.publishedAt, "publishedAt"),
    // Neo4j stores no null property, so an untagged item comes back without one.
    signal: typeof row.signal === "string" && row.signal.length > 0 ? row.signal : null,
  };
}

function newestFirst(a: EvidenceItem, b: EvidenceItem): number {
  return b.publishedAt.localeCompare(a.publishedAt) || a.url.localeCompare(b.url);
}

interface AccountEvidence {
  segments: string[];
  item: EvidenceItem;
}

async function readAccountEvidence(runCypher: RunCypher, accounts: string[]): Promise<Map<string, AccountEvidence[]>> {
  const byAccount = new Map<string, AccountEvidence[]>();
  if (accounts.length === 0) return byAccount;
  for (const row of await runCypher(ACCOUNT_EVIDENCE_CYPHER, { accounts })) {
    const account = str(row.account, "account");
    const list = byAccount.get(account) ?? [];
    list.push({ segments: Array.isArray(row.segments) ? row.segments.map(String) : [], item: evidenceItem(row) });
    byAccount.set(account, list);
  }
  for (const list of byAccount.values()) list.sort((a, b) => newestFirst(a.item, b.item));
  return byAccount;
}

async function readNeedEvidence(runCypher: RunCypher, accounts: string[]): Promise<Map<string, Map<string, NeedEvidenceItem[]>>> {
  const byAccount = new Map<string, Map<string, NeedEvidenceItem[]>>();
  if (accounts.length === 0) return byAccount;
  for (const row of await runCypher(NEED_EVIDENCE_CYPHER, { accounts })) {
    const account = str(row.account, "account");
    const need = str(row.need, "need");
    const needs = byAccount.get(account) ?? new Map<string, NeedEvidenceItem[]>();
    needs.set(need, [
      ...(needs.get(need) ?? []),
      { claim: str(row.claim, "claim"), quote: str(row.quote, "quote"), source: str(row.source, "source") },
    ]);
    byAccount.set(account, needs);
  }
  return byAccount;
}

export async function readGraphSnapshot(runCypher: RunCypher, vendorAliases: Record<string, string>): Promise<GraphSnapshot> {
  const [accountRows, needRows, positionRows, vendorRows] = await Promise.all([
    runCypher(ACCOUNTS_CYPHER),
    runCypher(NEED_SEGMENTS_CYPHER),
    runCypher(POSITIONS_CYPHER),
    runCypher(VENDORS_CYPHER),
  ]);

  const notes: string[] = [];
  return {
    accounts: accountRows.map((r) => ({
      id: str(r.id, "id"),
      name: typeof r.name === "string" && r.name.length > 0 ? r.name : str(r.id, "id"),
      aliases: commaList(r.aliases),
      // Missing on a graph built before declaredSegments existed: every
      // incumbent-less segment then reads unknown until the next rebuild.
      declared: commaList(r.declaredSegments),
      needs: strList(r.needs, "needs"),
      uses: uses(r.uses),
      triggers: triggers(r.triggers, str(r.id, "id"), notes),
      historyConflicts: jsonStrings(r.historyConflicts),
    })),
    needSegments: Object.fromEntries(needRows.map((r) => [str(r.need, "need"), strList(r.segments, "segments")])),
    positions: positionRows.map((r) => ({
      vendor: str(r.vendor, "vendor"),
      segment: str(r.segment, "segment"),
      position: str(r.position, "position"),
      confidence: str(r.confidence, "confidence"),
      rationale: str(r.rationale, "rationale"),
      asOf: typeof r.asOf === "string" ? r.asOf : "",
    })),
    vendors: vendorRows.map((r) => str(r.id, "id")),
    vendorAliases,
    notes,
  };
}

function size(answer: CompetitiveAnswer): number {
  return JSON.stringify(answer).length;
}

/** What the asker can still add to narrow the question: every dimension not already set. */
function narrowingAdvice(query: CompetitiveAnswer["query"]): string | null {
  const missing = (["vendor", "account", "segment"] as const).filter((k) => query[k] === null);
  return missing.length > 0 ? missing.join(" or ") : null;
}

export interface TrimStep {
  /** What the step leaves out, for the note. */
  drops: string;
  apply(answer: CompetitiveAnswer): void;
  /** False when the step has nothing to drop: it is skipped and not named in the note. */
  applies?(answer: CompetitiveAnswer): boolean;
}

const DROP_ALL_EVENTS: TrimStep = {
  drops: "account events",
  applies: (a) => a.accounts.some((acc) => acc.general.length > 0 || acc.segments.some((seg) => seg.events.length > 0)),
  apply: (a) => {
    for (const account of a.accounts) {
      account.general = [];
      for (const segment of account.segments) segment.events = [];
    }
  },
};

/**
 * In the order applied: cheapest information first; repetitive account events
 * go before claims. Structure (accounts, modes, positions, confidence, dates)
 * is never dropped -- it is what the question is about.
 */
export const TRIM_STEPS: TrimStep[] = [
  {
    drops: "claim details",
    apply: (a) => {
      for (const s of Object.values(a.standings)) for (const c of [...s.strong, ...s.weak]) c.detail = "";
    },
  },  {
    drops: "need-evidence quotes",
    applies: (a) => a.accounts.some((acc) => Object.values(acc.needEvidence).some((list) => list.some((e) => e.quote !== ""))),
    apply: (a) => {
      for (const acc of a.accounts) for (const list of Object.values(acc.needEvidence)) for (const e of list) e.quote = "";
    },
  },
  {
    drops: "need evidence",
    applies: (a) => a.accounts.some((acc) => Object.keys(acc.needEvidence).length > 0),
    apply: (a) => {
      for (const acc of a.accounts) acc.needEvidence = {};
    },
  },

  {
    drops: "account events beyond 1 per segment and account",
    applies: (a) => a.accounts.some((acc) => acc.general.length > 1 || acc.segments.some((seg) => seg.events.length > 1)),
    apply: (a) => {
      for (const account of a.accounts) {
        account.general = account.general.slice(0, 1);
        for (const segment of account.segments) segment.events = segment.events.slice(0, 1);
      }
    },
  },
  DROP_ALL_EVENTS,
  {
    drops: "claims",
    apply: (a) => {
      for (const s of Object.values(a.standings)) {
        s.strong = [];
        s.weak = [];
      }
    },
  },
  {
    drops: `rationale beyond ${TRIMMED_RATIONALE_CHARS} characters`,
    apply: (a) => {
      for (const s of Object.values(a.standings)) {
        if (s.rationale !== undefined && s.rationale.length > TRIMMED_RATIONALE_CHARS) {
          s.rationale = `${s.rationale.slice(0, TRIMMED_RATIONALE_CHARS).trimEnd()}…`;
        }
      }
    },
  },
  {
    drops: `rationale, and sources beyond ${TRIMMED_SOURCES} per standing`,
    apply: (a) => {
      for (const s of Object.values(a.standings)) {
        delete s.rationale;
        s.sources = s.sources.slice(0, TRIMMED_SOURCES);
      }
    },
  },
  {
    drops: "sources",
    apply: (a) => {
      for (const s of Object.values(a.standings)) s.sources = [];
    },
  },
];

/**
 * For text renderings (the chat), where an event is one short line and claims
 * and rationale are the bulk: extra events still go early, every event last.
 */
export const TEXT_TRIM_STEPS: TrimStep[] = [...TRIM_STEPS.filter((step) => step !== DROP_ALL_EVENTS), DROP_ALL_EVENTS];

/**
 * Shrink an over-budget answer step by step until it fits, then say what was
 * left out and how to ask for it. Exported with a budget parameter so the trim
 * order can be tested without building answers of exactly the right size.
 */
export function fitBudget(
  answer: CompetitiveAnswer,
  budget = MAX_ANSWER_CHARS,
  // The tool returns JSON; the chat measures its rendered text instead.
  measure: (answer: CompetitiveAnswer) => number = size,
  steps: TrimStep[] = TRIM_STEPS,
): void {
  if (measure(answer) <= budget) return;
  const advice = narrowingAdvice(answer.query);
  const dropped: string[] = [];
  // Measured with the note in place, so adding it cannot push the answer back over.
  const note = (): string =>
    `trimmed to fit the answer budget, left out: ${dropped.join("; ")}` +
    (advice !== null ? `. Narrow by ${advice} for the full detail` : "");
  answer.notes.push("");
  const noteAt = answer.notes.length - 1;

  for (const step of steps) {
    if (step.applies !== undefined && !step.applies(answer)) continue;
    step.apply(answer);
    dropped.push(step.drops);
    answer.notes[noteAt] = note();
    if (measure(answer) <= budget) return;
  }
  answer.notes.push(
    advice !== null
      ? `the answer is still over budget: narrow the question by ${advice}`
      : "the answer is still over budget even for one vendor, account and segment",
  );
}

export async function competitivePosition(deps: CompetitiveDeps, query: CompetitiveQuery): Promise<CompetitiveResult> {
  return competitivePositionFrom(deps, await readGraphSnapshot(deps.runCypher, deps.vendorAliases()), query);
}

/** The same answer from a snapshot already read, so a caller that inspected it does not read the graph twice. */
export async function competitivePositionFrom(
  deps: Pick<CompetitiveDeps, "runCypher" | "briefs">,
  snapshot: GraphSnapshot,
  query: CompetitiveQuery,
  now: Date = new Date(),
): Promise<CompetitiveResult> {
  const resolved = resolveCompetitivePosition(snapshot, query, now);
  if (!resolved.ok) return resolved;
  const r = resolved.value;

  const { excerpts, errors } = deps.briefs();
  const notes = [...r.notes, ...errors.map((e) => `brief problem: ${e}`)];

  const standings: Record<string, AnswerStanding> = {};
  for (const [key, standing] of Object.entries(r.standings)) {
    const excerpt = excerpts.get(key);
    if (excerpt === undefined) {
      const [vendor, segment] = key.split("/");
      notes.push(`no curated evidence for ${vendor} in ${segment}: the position rests on the graph alone`);
    }
    standings[key] = {
      ...standing,
      curated: excerpt !== undefined,
      strong: excerpt?.strong.map((c) => ({ ...c })) ?? [],
      weak: excerpt?.weak.map((c) => ({ ...c })) ?? [],
      sources: excerpt?.sources ?? [],
    };
  }

  const modes: Partial<Record<IncumbencyMode, string>> = {};
  for (const account of r.accounts) {
    for (const segment of account.segments) for (const v of segment.vendors) modes[v.mode] = MODE_GUIDANCE[v.mode];
  }
  const regimes: Partial<Record<Regime, string>> = {};
  for (const account of r.accounts) {
    for (const segment of account.segments) regimes[segment.regime] = REGIME_GUIDANCE[segment.regime];
  }

  const events = await readAccountEvidence(
    deps.runCypher,
    r.accounts.map((a) => a.account),
  );
  const reasons = await readNeedEvidence(
    deps.runCypher,
    r.accounts.map((a) => a.account),
  );
  const accounts: AnswerAccount[] = r.accounts.map((account) => {
    const rows = events.get(account.account) ?? [];
    return {
      ...account,
      segments: account.segments.map((segment) => ({
        ...segment,
        events: rows
          .filter((e) => e.segments.includes(segment.segment))
          .slice(0, EVENTS_PER_SEGMENT)
          .map((e) => ({ ...e.item })),
      })),
      general: rows
        .filter((e) => e.segments.length === 0)
        .slice(0, GENERAL_PER_ACCOUNT)
        .map((e) => ({ ...e.item })),
      needEvidence: Object.fromEntries(
        account.needs
          .map((need): [string, NeedEvidenceItem[]] => [need, (reasons.get(account.account)?.get(need) ?? []).slice(0, NEED_EVIDENCE_PER_NEED)])
          .filter(([, list]) => list.length > 0),
      ),
    };
  });

  // Evidence for the queried vendor, or for every cited vendor when none was named.
  const evidenceVendors =
    r.query.vendor !== null ? [r.query.vendor] : [...new Set(Object.keys(standings).map((k) => k.split("/")[0]))].sort();
  const evidence: Record<string, EvidenceItem[]> = {};
  for (const vendor of evidenceVendors) {
    const segments = [
      ...new Set(Object.keys(standings).filter((k) => k.split("/")[0] === vendor).map((k) => k.split("/")[1])),
    ].sort();
    if (segments.length === 0) {
      // Unfiltered, the vendor's newest items would come from any segment and
      // read as evidence for a standing it does not have.
      evidence[vendor] = [];
      notes.push(`no segment-specific news for ${vendor}: it has no cited segment`);
      continue;
    }
    const rows = await deps.runCypher(VENDOR_EVIDENCE_CYPHER, { vendor, segments });
    evidence[vendor] = rows.map(evidenceItem).sort(newestFirst).slice(0, EVIDENCE_PER_VENDOR);
  }

  const answer: CompetitiveAnswer = {
    query: r.query,
    modes,
    regimes,
    market: r.market,
    accounts,
    standings,
    evidence,
    notes,
  };
  fitBudget(answer);
  return { ok: true, answer };
}
