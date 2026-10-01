// Answers "what is <vendor> doing best for my accounts?" from a snapshot of the
// vendor-intelligence graph. Pure: no Neo4j, no files -- competitive-graph.ts
// reads the snapshot, this decides what it means.
//
// Incumbency is resolved first, per segment, because the same competitive fact
// means opposite things depending on who already holds the account
// (docs/superpowers/specs/2026-09-21-vendor-intel-graph-design.md, "Query path").
// Vendors are never ranked: every list is alphabetical, whatever its position
// label says -- six of eight vendors are Gartner Leaders, so the label alone
// carries little signal and ordering by it would invent one.
import { SEGMENTS } from "./graph-schema.js";

export type IncumbencyMode = "defend" | "displace" | "greenfield";

export const MODE_GUIDANCE: Record<IncumbencyMode, string> = {
  defend:
    "the vendor is installed: defend and expand through roadmap, lifecycle and adjacent attach; function gaps are tolerable",
  displace: "a rival is installed: displacing it needs a disqualifying weakness or a triggering event",
  greenfield: "nobody is installed: function and price actually decide",
};

export interface CompetitiveQuery {
  vendor?: string;
  account?: string;
  segment?: string;
}

export interface SnapshotAccount {
  id: string;
  name: string;
  aliases: string[];
  needs: string[];
  uses: Array<{ segment: string; vendor: string }>;
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
}

export interface AccountView {
  account: string;
  name: string;
  needs: string[];
  segments: SegmentView[];
}

export interface CompetitiveResolution {
  query: { vendor: string | null; account: string | null; segment: string | null };
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

export function resolveCompetitivePosition(snap: GraphSnapshot, query: CompetitiveQuery): ResolveResult {
  if (!query.vendor && !query.account && !query.segment) {
    return { ok: false, error: "give at least one of vendor, account or segment" };
  }

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
  const notes = new Set<string>();

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

  const accounts = scope.map((account): AccountView => {
    const inPlay = new Set<string>();
    if (segment !== null) {
      inPlay.add(segment);
    } else {
      for (const need of account.needs) for (const s of snap.needSegments[need] ?? []) inPlay.add(s);
      // Where the vendor is installed is always worth discussing (defend), need or not.
      if (vendor !== null) for (const use of account.uses) if (use.vendor === vendor) inPlay.add(use.segment);
    }
    if (inPlay.size === 0) notes.add(`${account.id} declares no needs, so no segment is in play there`);

    const segments = [...inPlay].sort(bySegment).map((seg): SegmentView => {
      const incumbents = [...new Set(account.uses.filter((u) => u.segment === seg).map((u) => u.vendor))].sort();
      const names =
        vendor !== null
          ? [vendor]
          : [...new Set([...snap.positions.filter((p) => p.segment === seg).map((p) => p.vendor), ...incumbents])].sort();

      const vendors = names.map((v): VendorInSegment => {
        const position = cite(v, seg);
        if (position === null) notes.add(`no curated brief for ${v} in ${seg}: its position there is unknown, not absent`);
        const mode: IncumbencyMode = incumbents.includes(v) ? "defend" : incumbents.length > 0 ? "displace" : "greenfield";
        return { vendor: v, mode, position };
      });

      const via = account.needs.filter((need) => (snap.needSegments[need] ?? []).includes(seg));
      return { segment: seg, via, incumbents, vendors };
    });

    return { account: account.id, name: account.name, needs: account.needs, segments };
  });

  return {
    ok: true,
    value: {
      query: { vendor, account: query.account ? scope[0].id : null, segment },
      market,
      accounts,
      standings,
      notes: [...notes],
    },
  };
}
