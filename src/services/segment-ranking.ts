// Win likelihood inside one account segment (spec 2026-10-02-vendor-ranking).
//
// Pure and deterministic: incumbency decides first, position second, and
// nothing else breaks a tie -- never alphabetical order. A segment whose
// install base is unknown is not ranked at all: guessing there is what the
// whole design refuses to do.
export type Regime = "unknown" | "greenfield" | "defend" | "open";

export interface RankedVendor {
  vendor: string;
  /** Competition rank: equal keys share it and the next rank skips (1, 1, 3). */
  rank: number;
  /** [role, position]: role is incumbent | rival | nobody installed; position is label/confidence or "no brief". */
  reasons: string[];
}

export interface SegmentPosition {
  position: string;
  confidence: string;
}

export interface RankingInput {
  /** The account declared this segment's incumbents, an empty list included. */
  declared: boolean;
  incumbents: string[];
  trigger: string | null;
  /** Every vendor a brief places in this segment. */
  positions: ReadonlyMap<string, SegmentPosition>;
  /** The asked-about vendor: shown wherever it ranks. */
  keep: string | null;
}

export interface SegmentRanking {
  regime: Regime;
  /** Whole rank groups up to RANKING_TOP entries, plus `keep`; null exactly when the regime is unknown. */
  ranking: RankedVendor[] | null;
  /** How many candidates were ranked, shown or not. */
  ranked: number;
}

/** A full list costs ~7k of untrimmable JSON on a full graph; the top 3 answers the question. */
export const RANKING_TOP = 3;

const POSITION_SCORE: Record<string, number> = { leader: 4, strong: 3, present: 2, absent: 0 };
const NO_BRIEF_SCORE = 1;

/** True when key a sorts strictly above key b (compared element by element, higher first). */
function above(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export function rankSegment(input: RankingInput): SegmentRanking {
  if (!input.declared) return { regime: "unknown", ranking: null, ranked: 0 };
  const regime: Regime = input.incumbents.length === 0 ? "greenfield" : input.trigger !== null ? "open" : "defend";

  // An installed vendor is always a candidate; anyone else needs a brief that places it here.
  const candidates = new Set(input.incumbents);
  for (const [vendor, p] of input.positions) if (p.position !== "absent") candidates.add(vendor);

  const entries = [...candidates].map((vendor) => {
    const p = input.positions.get(vendor) ?? null;
    const incumbent = input.incumbents.includes(vendor);
    const score = p === null ? NO_BRIEF_SCORE : (POSITION_SCORE[p.position] ?? NO_BRIEF_SCORE);
    const key =
      regime === "defend" ? [incumbent ? 1 : 0, score] : regime === "open" ? [score, incumbent ? 1 : 0] : [score];
    const role = regime === "greenfield" ? "nobody installed" : incumbent ? "incumbent" : "rival";
    return { vendor, key, reasons: [role, p === null ? "no brief" : `${p.position}/${p.confidence}`] };
  });

  const ranked = entries
    .map((e) => ({ vendor: e.vendor, rank: 1 + entries.filter((o) => above(o.key, e.key)).length, reasons: e.reasons }))
    // Tied entries are listed by id only so the output is stable; the shared rank carries the meaning.
    .sort((a, b) => a.rank - b.rank || a.vendor.localeCompare(b.vendor));

  // Whole rank groups, while they fit in RANKING_TOP entries: a tied group that
  // would pass it is left out entirely rather than broken alphabetically. The
  // asked vendor is always shown; "ranked" says how many there were.
  const shown = new Set<string>();
  for (const rank of [...new Set(ranked.map((r) => r.rank))]) {
    const group = ranked.filter((r) => r.rank === rank);
    if (shown.size + group.length > RANKING_TOP) break;
    for (const r of group) shown.add(r.vendor);
  }
  if (input.keep !== null) shown.add(input.keep);

  return { regime, ranking: ranked.filter((r) => shown.has(r.vendor)), ranked: ranked.length };
}
