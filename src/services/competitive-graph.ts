// Reads the vendor-intelligence graph for competitive_position, and turns the
// resolver's answer into the compact JSON the tool returns.
//
// Everything live is injected (Cypher runner, watchlist items, brief files), so
// no test reaches Neo4j or sqlite; src/api/graph.ts binds the real ones.
import {
  MODE_GUIDANCE,
  resolveCompetitivePosition,
  type AccountView,
  type CompetitiveQuery,
  type CompetitiveResolution,
  type GraphSnapshot,
  type IncumbencyMode,
  type SnapshotAccount,
  type Standing,
} from "./competitive-position.js";
import type { Segment } from "./graph-schema.js";
import type { BriefExcerpts, Claim } from "./vendor-brief-excerpts.js";
import type { Domain } from "./watchlist-config.js";

export type RunCypher = (query: string, params?: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;

export interface EvidenceItem {
  title: string;
  url: string;
  publishedAt: string;
}

export interface CompetitiveDeps {
  runCypher: RunCypher;
  /** `domains` undefined means no domain filter; an empty list would match nothing. */
  recentItems(entity: string, domains: Domain[] | undefined, limit: number): EvidenceItem[];
  briefs(): BriefExcerpts;
  vendorAliases(): Record<string, string>;
}

export const ACCOUNTS_CYPHER = `
  MATCH (a:Account)
  OPTIONAL MATCH (a)-[:HAS_NEED]->(n:Need)
  WITH a, collect(DISTINCT n.id) AS needs
  OPTIONAL MATCH (a)-[u:USES]->(v:Vendor)
  RETURN a.id AS id, a.name AS name, a.aliases AS aliases, needs,
         collect(CASE WHEN v IS NULL THEN null ELSE {segment: u.segment, vendor: v.id} END) AS uses
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

/**
 * The watchlist domains whose items count as evidence for a segment. The
 * watchlist tags items with 12 IT domains, the graph speaks in segments; this
 * is the only place the two vocabularies meet.
 */
export const SEGMENT_DOMAINS: Record<Segment, Domain[]> = {
  "compute-ai": ["ai", "infrastructure"],
  "compute-standard": ["infrastructure"],
  "storage-block": ["storage"],
  "storage-file": ["storage"],
  "storage-object": ["storage"],
  "data-platform": ["data"],
  "data-protection": ["backup", "cyber"],
  hci: ["infrastructure"],
  networking: ["networking"],
  client: ["euc"],
  services: [],
};

export const EVIDENCE_PER_VENDOR = 3;
/** ~6k tokens: room in a 64K context for the question, the answer and the model's own reasoning. */
export const MAX_ANSWER_CHARS = 24_000;
export const TRIMMED_RATIONALE_CHARS = 200;

export interface AnswerStanding extends Standing {
  /** false when no brief file backs the graph's position. */
  curated: boolean;
  strong: Claim[];
  weak: Claim[];
  sources: string[];
}

export interface CompetitiveAnswer {
  query: CompetitiveResolution["query"];
  /** What each incumbency mode in this answer means; only the modes that occur. */
  modes: Partial<Record<IncumbencyMode, string>>;
  market: CompetitiveResolution["market"];
  accounts: AccountView[];
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
    return { segment: str(row.segment, `uses[${i}].segment`), vendor: str(row.vendor, `uses[${i}].vendor`) };
  });
}

export async function readGraphSnapshot(runCypher: RunCypher, vendorAliases: Record<string, string>): Promise<GraphSnapshot> {
  const [accountRows, needRows, positionRows, vendorRows] = await Promise.all([
    runCypher(ACCOUNTS_CYPHER),
    runCypher(NEED_SEGMENTS_CYPHER),
    runCypher(POSITIONS_CYPHER),
    runCypher(VENDORS_CYPHER),
  ]);

  return {
    accounts: accountRows.map((r) => ({
      id: str(r.id, "id"),
      name: typeof r.name === "string" && r.name.length > 0 ? r.name : str(r.id, "id"),
      // graph-accounts.ts stores aliases comma-joined (Neo4j properties are scalars or lists of scalars).
      aliases: (typeof r.aliases === "string" ? r.aliases : "")
        .split(",")
        .map((a) => a.trim())
        .filter((a) => a.length > 0),
      needs: strList(r.needs, "needs"),
      uses: uses(r.uses),
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
  };
}

function size(answer: CompetitiveAnswer): number {
  return JSON.stringify(answer).length;
}

/**
 * Shrink an over-budget answer in a fixed order, cheapest information first:
 * claim details, then claims, then rationale length. Structure (accounts,
 * modes, positions, sources) is never dropped -- it is what the question is about.
 */
function fitBudget(answer: CompetitiveAnswer): void {
  if (size(answer) <= MAX_ANSWER_CHARS) return;
  const standings = Object.values(answer.standings);
  const steps: Array<() => void> = [
    () => {
      for (const s of standings) for (const c of [...s.strong, ...s.weak]) c.detail = "";
    },
    () => {
      for (const s of standings) {
        s.strong = [];
        s.weak = [];
      }
    },
    () => {
      for (const s of standings) {
        if (s.rationale.length > TRIMMED_RATIONALE_CHARS) s.rationale = `${s.rationale.slice(0, TRIMMED_RATIONALE_CHARS).trimEnd()}…`;
      }
    },
  ];
  answer.notes.push("excerpts trimmed to fit the answer budget; ask about one account or segment for the full claims");
  for (const step of steps) {
    step();
    if (size(answer) <= MAX_ANSWER_CHARS) return;
  }
  answer.notes.push("the answer is still over budget: narrow the question by account or segment");
}

export async function competitivePosition(deps: CompetitiveDeps, query: CompetitiveQuery): Promise<CompetitiveResult> {
  const snapshot = await readGraphSnapshot(deps.runCypher, deps.vendorAliases());
  const resolved = resolveCompetitivePosition(snapshot, query);
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

  // Evidence for the queried vendor, or for every cited vendor when none was named.
  const evidenceVendors =
    r.query.vendor !== null ? [r.query.vendor] : [...new Set(Object.keys(standings).map((k) => k.split("/")[0]))].sort();
  const evidence: Record<string, EvidenceItem[]> = {};
  for (const vendor of evidenceVendors) {
    const domains = new Set<Domain>();
    for (const key of Object.keys(standings)) {
      const [v, segment] = key.split("/");
      if (v === vendor) for (const d of SEGMENT_DOMAINS[segment as Segment] ?? []) domains.add(d);
    }
    evidence[vendor] = deps.recentItems(vendor, domains.size > 0 ? [...domains].sort() : undefined, EVIDENCE_PER_VENDOR);
  }

  const answer: CompetitiveAnswer = {
    query: r.query,
    modes,
    market: r.market,
    accounts: r.accounts,
    standings,
    evidence,
    notes,
  };
  fitBudget(answer);
  return { ok: true, answer };
}
