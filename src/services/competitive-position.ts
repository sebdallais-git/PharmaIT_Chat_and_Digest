// Answers "what is <vendor> doing best for my accounts?" from a snapshot of the
// vendor-intelligence graph. Pure: no Neo4j, no files -- competitive-graph.ts
// reads the snapshot, this decides what it means.
//
// Incumbency is resolved first, per segment, because the same competitive fact
// means opposite things depending on who already holds the account
// (docs/superpowers/specs/2026-09-21-vendor-intel-graph-design.md, "Query path").
// Lists are never ordered by position: every list is alphabetical whatever its
// label says -- six of eight vendors are Gartner Leaders, so the label alone
// carries little signal. The one order is each segment's `ranking`
// (segment-ranking.ts): win likelihood there, incumbency first, with reasons.
import { SEGMENTS } from "./graph-schema.js";
import { rankSegment, type RankedVendor, type Regime } from "./segment-ranking.js";

export type IncumbencyMode = "defend" | "displace" | "greenfield" | "unknown";

export const MODE_GUIDANCE: Record<IncumbencyMode, string> = {
  defend:
    "the vendor is installed: defend and expand through roadmap, lifecycle and adjacent attach; function gaps are tolerable; " +
    "the segment's events show lifecycle and roadmap moves",
  displace:
    "a rival is installed: displacing it needs a disqualifying weakness or a triggering event; look for one in the segment's events",
  greenfield: "declared: nobody is installed, so function and price actually decide",
  unknown: "who is installed here is not recorded: find out before choosing defend, displace or greenfield",
};

export const REGIME_GUIDANCE: Record<Regime, string> = {
  open: "a declared trigger opens the segment: position decides, incumbency only breaks ties",
  defend: "the incumbent keeps the segment unless a trigger is declared: rivals rank behind it",
  greenfield: "nobody is installed: position decides",
  unknown: "no ranking until you record who is installed",
};

export const HISTORY_RECENT_MONTHS = 18;

export interface HistoryStint {
  vendor: string;
  since: string;
  until: string;
  source: string;
}

/** The latest day a stint's dates mention, for ordering and the recent window ("" when undated). */
function stintDay(s: HistoryStint): string {
  const dates = [s.since, s.until].filter((d) => d !== "" && d !== "?");
  return dates.map((d) => (d.length === 4 ? `${d}-12-31` : d.length === 7 ? `${d}-28` : d)).sort().pop() ?? "";
}

export interface CompetitiveQuery {
  vendor?: string;
  account?: string;
  segment?: string;
  history?: "recent" | "full";
}

export interface SnapshotAccount {
  id: string;
  name: string;
  aliases: string[];
  needs: string[];
  /**
   * Segments whose incumbents the account declares, an empty list included.
   * An incumbent-less segment outside this list is unknown, not greenfield.
   */
  declared: string[];
  /** USES edges; since/until/source are absent on graphs built before history (all current). */
  uses: Array<{ segment: string; vendor: string; since?: string; until?: string; source?: string }>;
  /** Approved news that contradicts the accounts file (install-history.ts). */
  historyConflicts?: string[];
  /** Declared install-base triggers by segment; absent on hand-built snapshots. */
  triggers?: Record<string, string>;
}

export interface SnapshotPosition {
  vendor: string;
  segment: string;
  position: string;
  confidence: string;
  rationale: string;
  asOf: string;
}

export interface GraphSnapshot {
  accounts: SnapshotAccount[];
  needSegments: Record<string, string[]>;
  positions: SnapshotPosition[];
  vendors: string[];
  /** Normalised alias -> vendor id, e.g. "pure-storage" -> "everpure". */
  vendorAliases: Record<string, string>;
  /** Problems met while reading the graph, passed on to the answer's notes. */
  notes?: string[];
}

export interface Standing {
  position: string;
  confidence: string;
  rationale: string;
  asOf: string;
}

export interface VendorInSegment {
  vendor: string;
  mode: IncumbencyMode;
  /** null when no brief places the vendor in this segment: unknown, not absent. */
  position: string | null;
}

export interface SegmentView {
  segment: string;
  /** The account's needs that put this segment in play; empty when only the vendor's own install does. */
  via: string[];
  incumbents: string[];
  vendors: VendorInSegment[];
  regime: Regime;
  /** The declared install-base trigger, stated once per segment. */
  trigger: string | null;
  /** Win likelihood here: whole rank groups up to 3 plus the asked vendor; null when who is installed is unknown. */
  ranking: RankedVendor[] | null;
  /** How many vendors were ranked, shown or not. */
  ranked: number;
  /** Per rank, how many tied vendors are not listed; omitted when none. */
  hidden?: Array<{ rank: number; count: number }>;
  /** The asked vendor when no brief places it here and it is not installed: shown, never ranked. */
  unranked?: string;
  /** Who held the segment, newest first: recent changes by default, every stint in full mode. */
  history?: HistoryStint[];
  /** Recent mode: dated stints older than the window, left out. */
  olderChanges?: number;
}

export interface AccountView {
  account: string;
  name: string;
  needs: string[];
  segments: SegmentView[];
}

export interface CompetitiveResolution {
  query: { vendor: string | null; account: string | null; segment: string | null; history: "recent" | "full" };
  /** Positions independent of any account, for the queried vendor and/or segment. */
  market: Array<{ vendor: string; segment: string; position: string }>;
  accounts: AccountView[];
  /**
   * Rationale and confidence once per cited vendor/segment pair, keyed by
   * standingKey. Kept out of the account views so a pair cited by three
   * accounts is not repeated three times.
   */
  standings: Record<string, Standing>;
  notes: string[];
}

export type ResolveResult = { ok: true; value: CompetitiveResolution } | { ok: false; error: string };

export function normaliseName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "-");
}

export function standingKey(vendor: string, segment: string): string {
  return `${vendor}/${segment}`;
}

const SEGMENT_ORDER = new Map<string, number>(SEGMENTS.map((segment, i) => [segment, i]));

function bySegment(a: string, b: string): number {
  return (SEGMENT_ORDER.get(a) ?? SEGMENTS.length) - (SEGMENT_ORDER.get(b) ?? SEGMENTS.length);
}

function resolveVendor(raw: string, snap: GraphSnapshot): string | null {
  const key = normaliseName(raw);
  if (snap.vendors.includes(key)) return key;
  const aliased = snap.vendorAliases[key];
  return aliased !== undefined && snap.vendors.includes(aliased) ? aliased : null;
}

function resolveAccount(raw: string, snap: GraphSnapshot): SnapshotAccount | null {
  const key = normaliseName(raw);
  return snap.accounts.find((a) => [a.id, a.name, ...a.aliases].some((name) => normaliseName(name) === key)) ?? null;
}

export function resolveCompetitivePosition(snap: GraphSnapshot, query: CompetitiveQuery, now: Date = new Date()): ResolveResult {
  if (!query.vendor && !query.account && !query.segment) {
    return { ok: false, error: "give at least one of vendor, account or segment" };
  }
  const historyMode = query.history ?? "recent";
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - HISTORY_RECENT_MONTHS);
  const cutoffDay = cutoff.toISOString().slice(0, 10);

  let vendor: string | null = null;
  if (query.vendor) {
    vendor = resolveVendor(query.vendor, snap);
    if (vendor === null) {
      return { ok: false, error: `unknown vendor "${query.vendor}" (known: ${[...snap.vendors].sort().join(", ")})` };
    }
  }

  let segment: string | null = null;
  if (query.segment) {
    const key = normaliseName(query.segment);
    if (!SEGMENT_ORDER.has(key)) {
      return { ok: false, error: `unknown segment "${query.segment}" (known: ${SEGMENTS.join(", ")})` };
    }
    segment = key;
  }

  let scope = snap.accounts;
  if (query.account) {
    const account = resolveAccount(query.account, snap);
    if (account === null) {
      const known = snap.accounts.map((a) => a.id).sort().join(", ") || "none declared";
      return { ok: false, error: `unknown account "${query.account}" (known: ${known})` };
    }
    scope = [account];
  }

  const positionOf = new Map(snap.positions.map((p) => [standingKey(p.vendor, p.segment), p]));
  const standings: Record<string, Standing> = {};
  const notes = new Set<string>(snap.notes ?? []);
  for (const account of scope) for (const conflict of account.historyConflicts ?? []) notes.add(conflict);

  // Records the full standing once and returns the bare label for the views.
  const cite = (v: string, seg: string): string | null => {
    const p = positionOf.get(standingKey(v, seg));
    if (p === undefined) return null;
    standings[standingKey(v, seg)] = { position: p.position, confidence: p.confidence, rationale: p.rationale, asOf: p.asOf };
    return p.position;
  };

  const market =
    vendor !== null || segment !== null
      ? snap.positions
          .filter((p) => (vendor === null || p.vendor === vendor) && (segment === null || p.segment === segment))
          .sort((a, b) => bySegment(a.segment, b.segment) || a.vendor.localeCompare(b.vendor))
          .map((p) => ({ vendor: p.vendor, segment: p.segment, position: cite(p.vendor, p.segment) ?? p.position }))
      : [];
  if (vendor !== null && market.length === 0) {
    notes.add(
      `no curated brief places ${vendor} ${segment !== null ? `in ${segment}` : "in any segment"}: its position is unknown, not absent`,
    );
  }

  if (snap.accounts.length === 0) {
    notes.add("no accounts are declared: copy config/accounts.example.yaml to config/accounts.local.yaml and rebuild the graph");
  }

  // Vendor -> segments where no brief places it: one note per vendor, not per
  // pair (every ranking entry already says "no brief"; per-pair notes cost ~1.6k
  // on a full graph, out of a budget rankings are never trimmed from).
  const unbriefed = new Map<string, Set<string>>();

  const accounts = scope.map((account): AccountView => {
    const inPlay = new Set<string>();
    if (segment !== null) {
      inPlay.add(segment);
    } else {
      for (const need of account.needs) for (const s of snap.needSegments[need] ?? []) inPlay.add(s);
      // Where the vendor is installed is always worth discussing (defend), need or not.
      if (vendor !== null) for (const use of account.uses) if (use.vendor === vendor && (use.until ?? "") === "") inPlay.add(use.segment);
    }
    if (inPlay.size === 0) notes.add(`${account.id} declares no needs, so no segment is in play there`);

    const segments = [...inPlay].sort(bySegment).map((seg): SegmentView => {
      const incumbents = [
        ...new Set(account.uses.filter((u) => u.segment === seg && (u.until ?? "") === "").map((u) => u.vendor)),
      ].sort();
      const names =
        vendor !== null
          ? [vendor]
          : [...new Set([...snap.positions.filter((p) => p.segment === seg).map((p) => p.vendor), ...incumbents])].sort();

      const vendors = names.map((v): VendorInSegment => {
        const position = cite(v, seg);
        if (position === null) unbriefed.set(v, new Set([...(unbriefed.get(v) ?? []), seg]));
        const mode: IncumbencyMode = incumbents.includes(v)
          ? "defend"
          : incumbents.length > 0
            ? "displace"
            : account.declared.includes(seg)
              ? "greenfield"
              : "unknown";
        return { vendor: v, mode, position };
      });

      const via = account.needs.filter((need) => (snap.needSegments[need] ?? []).includes(seg));
      const trigger = account.triggers?.[seg] ?? null;
      const { regime, ranking, ranked, hidden, unranked } = rankSegment({
        // A graph built before declaredSegments existed still knows its incumbents.
        declared: account.declared.includes(seg) || incumbents.length > 0,
        incumbents,
        trigger,
        positions: new Map(
          snap.positions
            .filter((p) => p.segment === seg)
            .map((p) => [p.vendor, { position: p.position, confidence: p.confidence }]),
        ),
        keep: vendor,
      });
      const stints: HistoryStint[] = account.uses
        .filter((u) => u.segment === seg)
        .map((u) => ({ vendor: u.vendor, since: u.since ?? "", until: u.until ?? "", source: u.source ?? "declared" }))
        // Current stints first, then newest first; the name only keeps the output stable.
        .sort(
          (a, b) =>
            Number(b.until === "") - Number(a.until === "") ||
            stintDay(b).localeCompare(stintDay(a)) ||
            a.vendor.localeCompare(b.vendor),
        );
      const dated = stints.filter((s) => stintDay(s) !== "");
      // Full mode lists every stint, but not a lone undated current one: it only
      // repeats the installed line (today's plain files, pre-history graphs).
      const hasHistory = stints.some((s) => stintDay(s) !== "" || s.until !== "");
      const shown =
        historyMode === "full" ? (hasHistory ? stints : []) : dated.filter((s) => stintDay(s) >= cutoffDay);
      const older = historyMode === "full" ? 0 : dated.length - shown.length;
      return {
        segment: seg,
        via,
        incumbents,
        vendors,
        regime,
        trigger,
        ranking,
        ranked,
        ...(hidden !== undefined ? { hidden } : {}),
        ...(unranked !== undefined ? { unranked } : {}),
        ...(shown.length > 0 ? { history: shown } : {}),
        ...(older > 0 ? { olderChanges: older } : {}),
      };
    });

    return { account: account.id, name: account.name, needs: account.needs, segments };
  });

  for (const [v, segs] of [...unbriefed].sort(([a], [b]) => a.localeCompare(b))) {
    notes.add(`no curated brief for ${v} in ${[...segs].sort(bySegment).join(", ")}: its position there is unknown, not absent`);
  }

  return {
    ok: true,
    value: {
      query: { vendor, account: query.account ? scope[0].id : null, segment, history: historyMode },
      market,
      accounts,
      standings,
      notes: [...notes],
    },
  };
}
