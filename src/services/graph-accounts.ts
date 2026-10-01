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

export interface Account {
  id: string;
  name: string;
  aliases: string[];
  needs: Need[];
  /** Vendors installed per segment. Several per segment is normal. */
  incumbents: Partial<Record<Segment, string[]>>;
  notes: string;
}

function assertIn<T extends string>(allowed: readonly T[], value: string, field: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`invalid ${field} "${value}" (expected one of: ${allowed.join(", ")})`);
  }
  return value as T;
}

/** Parse the accounts file. Throws on any segment or need outside a closed set. */
export function parseAccounts(yaml: string): Account[] {
  const doc = parse(yaml) as { accounts?: Record<string, Record<string, unknown>> } | null;
  const accounts = doc?.accounts ?? {};

  return Object.entries(accounts).map(([id, raw]) => {
    const needs = (Array.isArray(raw.needs) ? raw.needs : []).map((n) => assertIn(NEEDS, String(n), "need"));

    const incumbents: Partial<Record<Segment, string[]>> = {};
    for (const [segment, vendors] of Object.entries((raw.incumbents ?? {}) as Record<string, unknown>)) {
      const key = assertIn(SEGMENTS, segment, "segment");
      incumbents[key] = (Array.isArray(vendors) ? vendors : []).map(String);
    }

    return {
      id,
      name: typeof raw.name === "string" ? raw.name : id,
      aliases: (Array.isArray(raw.aliases) ? raw.aliases : []).map(String),
      needs,
      incumbents,
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
  for (const list of Object.values(account.incumbents)) for (const vendor of list ?? []) vendors.add(vendor);

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
    ...Object.entries(account.incumbents).flatMap(([segment, list]) =>
      (list ?? []).map((vendor): GraphRelationship => ({
        type: "USES",
        from: account.id,
        to: vendor,
        // Incumbency is per segment, never per account: an account can run one
        // vendor in file and another in block, facing different rivals in each.
        properties: { segment },
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
