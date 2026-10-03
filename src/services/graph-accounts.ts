// Turns the declared install base into graph facts.
//
// Incumbency is the primary axis of every answer: the same competitive fact
// means opposite things depending on who already holds the account, so this is
// resolved before any vendor comparison.
import { parse } from "yaml";
import {
  NEEDS,
  SEGMENTS,
  type GraphFacts,
  type GraphNode,
  type GraphRelationship,
  type Need,
  type Segment,
} from "./graph-schema.js";

/**
 * One vendor's time in one segment. since/until are YYYY, YYYY-MM or
 * YYYY-MM-DD, or "" when unknown; until "" means current; until "?" means a
 * past stint whose end is unknown (only news produces it, install-history.ts).
 */
export interface Stint {
  vendor: string;
  since: string;
  until: string;
  /** "declared" (the accounts file) or "news:<source>" (an approved proposal). */
  source: string;
}

const DATE_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

/** Earliest or latest day a partial date can mean: 2026 -> 2026-01-01 / 2026-12-31. */
export function boundOf(date: string, end: "low" | "high"): string {
  const [y, m, d] = date.split("-");
  const month = m ?? (end === "low" ? "01" : "12");
  const day = d ?? (end === "low" ? "01" : String(new Date(Date.UTC(Number(y), Number(month), 0)).getUTCDate()).padStart(2, "0"));
  return `${y}-${month}-${day}`;
}

function parseStint(entry: unknown, where: string, now: Date): Stint {
  if (typeof entry === "string") return { vendor: entry, since: "", until: "", source: "declared" };
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`${where}: an entry is a vendor name or {vendor, since, until}`);
  }
  const raw = entry as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!["vendor", "since", "until"].includes(key)) throw new Error(`${where}: unknown key "${key}"`);
  }
  if (typeof raw.vendor !== "string" || raw.vendor.trim() === "") throw new Error(`${where}: an entry needs a vendor`);
  const date = (key: "since" | "until"): string => {
    if (raw[key] === undefined || raw[key] === null) return "";
    const value = String(raw[key]);
    if (!DATE_RE.test(value)) throw new Error(`${where}: ${key} "${value}" must be YYYY, YYYY-MM or YYYY-MM-DD`);
    return value;
  };
  const vendor = raw.vendor.trim();
  const since = date("since");
  const until = date("until");
  if (since !== "" && until !== "" && boundOf(since, "low") > boundOf(until, "high")) {
    throw new Error(`${where}: ${vendor} since ${since} is after until ${until}`);
  }
  if (until !== "" && boundOf(until, "low") > now.toISOString().slice(0, 10)) {
    throw new Error(`${where}: ${vendor} until ${until} is in the future — an announced end date belongs in triggers`);
  }
  return { vendor, since, until, source: "declared" };
}

export interface Account {
  id: string;
  name: string;
  aliases: string[];
  needs: Need[];
  /** Vendors installed now, per segment (stints without until). Several per segment is normal. */
  incumbents: Partial<Record<Segment, string[]>>;
  /** Every stint per segment, current ones included, in file order. */
  history: Partial<Record<Segment, Stint[]>>;
  /** Approved news that contradicts the file (install-history.ts); stored on the Account node. */
  conflicts?: string[];
  /**
   * Install-base events that open a segment held by a rival (end of support,
   * refresh due, a renewal date). Facts, not a pipeline: no stages or amounts.
   */
  triggers: Partial<Record<Segment, string>>;
  notes: string;
}

function assertIn<T extends string>(allowed: readonly T[], value: string, field: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`invalid ${field} "${value}" (expected one of: ${allowed.join(", ")})`);
  }
  return value as T;
}

/** Parse the accounts file. Throws on any segment or need outside a closed set. */
export function parseAccounts(yaml: string, now: Date = new Date()): Account[] {
  const doc = parse(yaml) as { accounts?: Record<string, Record<string, unknown>> } | null;
  const accounts = doc?.accounts ?? {};

  return Object.entries(accounts).map(([id, raw]) => {
    const needs = (Array.isArray(raw.needs) ? raw.needs : []).map((n) => assertIn(NEEDS, String(n), "need"));

    const incumbents: Partial<Record<Segment, string[]>> = {};
    const history: Partial<Record<Segment, Stint[]>> = {};
    for (const [segment, vendors] of Object.entries((raw.incumbents ?? {}) as Record<string, unknown>)) {
      const key = assertIn(SEGMENTS, segment, "segment");
      // A declared segment is a claim about the install base, so only a list
      // counts: a bare key or a scalar would otherwise become [] and answer
      // greenfield for a segment the user may simply not know.
      if (!Array.isArray(vendors)) {
        throw new Error(
          `${id}: incumbents.${key} must be a list of vendors — [] if nobody is installed, or omit the segment if unknown`,
        );
      }
      const stints = vendors.map((entry) => parseStint(entry, `${id}: incumbents.${key}`, now));
      history[key] = stints;
      incumbents[key] = [...new Set(stints.filter((s) => s.until === "").map((s) => s.vendor))];
    }

    const triggers: Partial<Record<Segment, string>> = {};
    if (raw.triggers !== undefined && raw.triggers !== null) {
      if (typeof raw.triggers !== "object" || Array.isArray(raw.triggers)) {
        throw new Error(`${id}: triggers must be a map of segment to description`);
      }
      for (const [segment, text] of Object.entries(raw.triggers as Record<string, unknown>)) {
        if (!(SEGMENTS as readonly string[]).includes(segment)) {
          throw new Error(`${id}: triggers.${segment} is not a segment (expected one of: ${SEGMENTS.join(", ")})`);
        }
        const key = segment as Segment;
        if (typeof text !== "string" || text.trim().length === 0) {
          throw new Error(`${id}: triggers.${key} must be a non-empty description of the install-base event`);
        }
        // Triggers are never trimmed from answers: an unbounded one would eat the budget.
        if (text.trim().length > 200) {
          throw new Error(`${id}: triggers.${key} is longer than 200 characters: an install-base fact fits one line`);
        }
        // A trigger opens a segment a rival holds: on [] there is nothing to
        // displace, and on an undeclared segment it would hide "find out first".
        if ((incumbents[key] ?? []).length === 0) {
          throw new Error(`${id}: triggers.${key} opens a segment held by a rival; declare its incumbents first`);
        }
        triggers[key] = text.trim();
      }
    }

    return {
      id,
      name: typeof raw.name === "string" ? raw.name : id,
      aliases: (Array.isArray(raw.aliases) ? raw.aliases : []).map(String),
      needs,
      incumbents,
      history,
      triggers,
      notes: typeof raw.notes === "string" ? raw.notes.trim() : "",
    };
  });
}

/**
 * The graph facts an account asserts.
 *
 * A Vendor node is materialised for every incumbent, including vendors with no
 * brief. This is deliberately unlike `briefToGraphFacts`, which refuses to
 * create a node for a competitor a brief merely names: that is a claim about
 * the market, whereas an incumbent is observed reality at the account. The
 * asymmetry is the point -- it also shows where the research backlog is, since
 * an incumbent with no brief is a vendor holding your account that nobody has
 * looked into.
 */
export function accountToGraphFacts(account: Account): GraphFacts {
  const vendors = new Set<string>();
  const stints = Object.entries(account.history) as Array<[Segment, Stint[] | undefined]>;
  for (const [, list] of stints) for (const s of list ?? []) vendors.add(s.vendor);

  const nodes: GraphNode[] = [
    {
      label: "Account",
      id: account.id,
      properties: {
        name: account.name,
        aliases: account.aliases.join(","),
        // Every segment the account declares, including those declared empty.
        // An omitted segment means "incumbent unknown", a declared empty list
        // "nobody installed"; neither leaves a USES edge, so without this both
        // would read as greenfield. Comma-joined: Neo4j properties are scalars.
        declaredSegments: SEGMENTS.filter((s) => s in account.incumbents).join(","),
        // Neo4j properties cannot be maps: JSON, keys in segment order, omitted when none.
        ...(Object.keys(account.triggers).length > 0
          ? {
              triggers: JSON.stringify(
                Object.fromEntries(SEGMENTS.filter((s) => account.triggers[s] !== undefined).map((s) => [s, account.triggers[s]])),
              ),
            }
          : {}),
        ...(account.conflicts !== undefined && account.conflicts.length > 0
          ? { historyConflicts: JSON.stringify(account.conflicts) }
          : {}),
        notes: account.notes,
      },
    },
    ...account.needs.map((need): GraphNode => ({ label: "Need", id: need, properties: { name: need } })),
    ...[...vendors].map((vendor): GraphNode => ({ label: "Vendor", id: vendor, properties: { name: vendor } })),
  ];

  const relationships: GraphRelationship[] = [
    ...account.needs.map((need): GraphRelationship => ({
      type: "HAS_NEED",
      from: account.id,
      to: need,
      properties: {},
    })),
    ...stints.flatMap(([segment, list]) =>
      (list ?? []).map((s): GraphRelationship => ({
        type: "USES",
        from: account.id,
        to: s.vendor,
        // Incumbency is per segment, never per account; past stints are kept
        // so the graph remembers who held the segment before.
        properties: { segment, since: s.since, until: s.until, source: s.source },
      })),
    ),
  ];

  return { nodes, relationships };
}

export type NeedsMap = Partial<Record<Need, Segment[]>>;

/** Parse the need-to-segment map. Both sides are validated against closed sets. */
export function parseNeedsMap(yaml: string): NeedsMap {
  const doc = parse(yaml) as { needs?: Record<string, unknown> } | null;
  const map: NeedsMap = {};
  for (const [need, segments] of Object.entries(doc?.needs ?? {})) {
    const key = assertIn(NEEDS, need, "need");
    map[key] = (Array.isArray(segments) ? segments : []).map((s) => assertIn(SEGMENTS, String(s), "segment"));
  }
  return map;
}

/**
 * The need-to-segment edges. This is the hinge of the whole query: an account
 * declares needs, and these decide which segments are worth discussing.
 */
export function needsMapToGraphFacts(map: NeedsMap): GraphFacts {
  const nodes: GraphNode[] = [];
  const relationships: GraphRelationship[] = [];

  for (const [need, segments] of Object.entries(map) as [Need, Segment[]][]) {
    nodes.push({ label: "Need", id: need, properties: { name: need } });
    for (const segment of segments) {
      nodes.push({ label: "Segment", id: segment, properties: { name: segment } });
      relationships.push({ type: "ADDRESSED_BY", from: need, to: segment, properties: {} });
    }
  }

  return { nodes, relationships };
}
