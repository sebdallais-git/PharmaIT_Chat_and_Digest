// The closed vocabularies of the vendor-intelligence graph, and the parser that
// turns a vendor brief's frontmatter into graph facts.
//
// Everything here is validated at parse time, before a single write reaches
// Neo4j. The previous graph accumulated 174 distinct relationship types against
// 20 declared because src/api/knowledge.ts validated labels but never
// relationships, and an LLM was free to invent both. Nothing here is inferred:
// the frontmatter is parsed, not interpreted.
import { parse } from "yaml";

export const SEGMENTS = [
  "compute-ai",
  "compute-standard",
  "storage-block",
  "storage-file",
  "storage-object",
  // Distinct from the storage segments beneath it: Snowflake, Databricks and
  // Palantir compete with each other and with Dell AI Data Platform and HPE
  // Ezmeral, not with NetApp. Filing them under storage-object would make the
  // graph assert a rivalry that does not exist.
  "data-platform",
  "data-protection",
  "hci",
  "networking",
  "client",
  "services",
] as const;

export const NEEDS = [
  // The six the landing page advertises as use cases. __tests__/graph-accounts
  // asserts the page and this list cannot drift apart: the page once promised
  // SAP and Multi Cloud while the model had no need for either, so those
  // questions reached a traversal with nothing to traverse.
  "ai-factory",
  "ai-data-platform",
  "end-user-computing",
  "cyber-resilience",
  "multi-cloud",
  "sap",
  // Tracked but not all advertised.
  "gxp-compliance",
  "rnd-compute",
  "data-sovereignty",
  "manufacturing-ot",
  "cost-optimisation",
  "sustainability",
] as const;

export const POSITIONS = ["leader", "strong", "present", "absent"] as const;
export const CONFIDENCES = ["high", "medium", "low"] as const;

export const NODE_LABELS = ["Vendor", "Segment", "Product", "Account", "Need", "Evidence"] as const;

export const RELATIONSHIP_TYPES = [
  "OFFERS",
  "IN_SEGMENT",
  "COMPETES_IN",
  "HAS_NEED",
  "ADDRESSED_BY",
  "USES",
  "SUPPORTS",
] as const;

/**
 * Properties that identify an edge, per relationship type.
 *
 * An account can use one vendor in several segments -- Roche runs HPE in both
 * compute-ai and compute-standard -- so merging USES on (from, type, to) alone
 * collapses them and loses a segment silently. Identity properties go INTO the
 * MERGE pattern; everything else is SET afterwards, so values that legitimately
 * change (a rationale, an asOf) update in place instead of creating duplicates.
 */
export const EDGE_IDENTITY: Record<RelationshipType, string[]> = {
  OFFERS: [],
  IN_SEGMENT: [],
  COMPETES_IN: [],
  HAS_NEED: [],
  ADDRESSED_BY: [],
  // Dates in the identity: two stints of one vendor in one segment stay two edges.
  USES: ["segment", "since", "until"],
  SUPPORTS: ["url"],
};

export type Segment = (typeof SEGMENTS)[number];
export type Need = (typeof NEEDS)[number];
export type Position = (typeof POSITIONS)[number];
export type Confidence = (typeof CONFIDENCES)[number];
export type NodeLabel = (typeof NODE_LABELS)[number];
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

export interface VendorBrief {
  vendor: string;
  segment: Segment;
  position: Position;
  confidence: Confidence;
  asOf: string;
  products: string[];
  competitors: string[];
  rationale: string;
  sources: string[];
  body: string;
}

export interface GraphNode {
  label: NodeLabel;
  id: string;
  properties: Record<string, unknown>;
}

export interface GraphRelationship {
  type: RelationshipType;
  from: string;
  to: string;
  properties: Record<string, unknown>;
}

export interface GraphFacts {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown, field: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`invalid ${field} "${String(value)}" (expected one of: ${allowed.join(", ")})`);
  }
  return value as T;
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`invalid ${field}: expected a list of strings`);
  }
  return value as string[];
}

/** Parse a vendor brief. Throws on any value outside a closed vocabulary. */
export function parseVendorBrief(markdown: string): VendorBrief {
  const parts = markdown.split(/^---\s*$/m);
  if (parts.length < 3) throw new Error("vendor brief has no frontmatter block");

  const fm = parse(parts[1]) as Record<string, unknown> | null;
  if (fm === null || typeof fm !== "object") throw new Error("vendor brief frontmatter is not a mapping");

  const vendor = typeof fm.vendor === "string" && fm.vendor.length > 0 ? fm.vendor : null;
  if (vendor === null) throw new Error("vendor brief is missing `vendor`");

  // A position with no rationale is the false confidence this design exists to
  // remove, so an empty rationale is a hard failure rather than a warning.
  const rationale = typeof fm.rationale === "string" ? fm.rationale.trim() : "";
  if (rationale.length === 0) throw new Error("vendor brief is missing `rationale` (a position without one is unusable)");

  return {
    vendor,
    segment: oneOf(SEGMENTS, fm.segment, "segment"),
    position: oneOf(POSITIONS, fm.position, "position"),
    confidence: oneOf(CONFIDENCES, fm.confidence, "confidence"),
    asOf: String(fm.as_of ?? ""),
    products: stringList(fm.products, "products"),
    competitors: stringList(fm.competitors, "competitors"),
    rationale,
    sources: stringList(fm.sources, "sources"),
    body: parts.slice(2).join("---").trim(),
  };
}

/**
 * The graph facts a brief asserts. Deliberately narrow: a brief speaks for its
 * own vendor only. Competitors named here are a claim about the market, not a
 * fact about those vendors -- their own briefs place them in a segment.
 */
export function briefToGraphFacts(brief: VendorBrief): GraphFacts {
  const nodes: GraphNode[] = [
    { label: "Vendor", id: brief.vendor, properties: { name: brief.vendor } },
    { label: "Segment", id: brief.segment, properties: { name: brief.segment } },
    ...brief.products.map((product): GraphNode => ({
      label: "Product",
      id: product,
      properties: { name: product, vendor: brief.vendor },
    })),
  ];

  const relationships: GraphRelationship[] = [
    {
      type: "COMPETES_IN",
      from: brief.vendor,
      to: brief.segment,
      properties: {
        position: brief.position,
        confidence: brief.confidence,
        rationale: brief.rationale,
        asOf: brief.asOf,
      },
    },
    ...brief.products.flatMap((product): GraphRelationship[] => [
      { type: "OFFERS", from: brief.vendor, to: product, properties: {} },
      { type: "IN_SEGMENT", from: product, to: brief.segment, properties: {} },
    ]),
  ];

  return { nodes, relationships };
}
