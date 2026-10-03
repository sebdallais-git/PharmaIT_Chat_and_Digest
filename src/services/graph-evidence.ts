// Watchlist items as graph evidence: which segments an item speaks to, and the
// Evidence nodes and SUPPORTS edges the rebuild writes for it.
//
// Pure apart from the two small binders at the bottom, which read
// watchlist.db. The rebuild is the only writer of Evidence (spec 2026-10-02).
import { existsSync } from "node:fs";
import { SEGMENTS, type GraphFacts, type GraphNode, type GraphRelationship, type Segment } from "./graph-schema.js";
import type { Domain } from "./watchlist-config.js";
import { openWatchlistStore, type StoredItem, type WatchlistStore } from "./watchlist-store.js";

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

export const EVIDENCE_WINDOW_DAYS = 180;

const DAY_MS = 24 * 60 * 60 * 1000;
const FAR_FUTURE = "9999-12-31T23:59:59.999Z";

export type EvidenceSourceItem = Pick<
  StoredItem,
  "id" | "urlCanonical" | "title" | "signal" | "publishedAt" | "sourceName" | "entities" | "domains"
>;

/** Items tagged with any of the ids, published at or after `sinceIso`; null when watchlist.db does not exist. */
export type EvidenceSource = (entityIds: string[], sinceIso: string) => EvidenceSourceItem[] | null;

export interface EvidenceFacts {
  facts: GraphFacts;
  evidence: number;
  /** Distinct graph vendors and accounts at least one item supports. */
  entities: number;
  futureSkipped: number;
}

export function segmentsForDomains(domains: readonly string[]): Segment[] {
  return SEGMENTS.filter((segment) => SEGMENT_DOMAINS[segment].some((d) => domains.includes(d)));
}

export function evidenceSince(now: Date): string {
  return new Date(now.getTime() - EVIDENCE_WINDOW_DAYS * DAY_MS).toISOString();
}

/**
 * One Evidence node per item and one SUPPORTS edge per graph entity it is
 * tagged with. Entities outside the graph are dropped here, because the writer
 * refuses an edge to a node nobody declared.
 */
export function evidenceToGraphFacts(items: EvidenceSourceItem[], graphIds: ReadonlySet<string>, now: Date): EvidenceFacts {
  // A feed that misdates an item a month ahead (one did on 2026-10-02) would
  // otherwise sit on top of every "newest" list until that date passes.
  const latest = now.getTime() + DAY_MS;
  const nodes: GraphNode[] = [];
  const relationships: GraphRelationship[] = [];
  const supported = new Set<string>();
  let futureSkipped = 0;

  for (const item of items) {
    if (Date.parse(item.publishedAt) > latest) {
      futureSkipped++;
      continue;
    }
    const targets = item.entities.filter((e) => graphIds.has(e));
    if (targets.length === 0) continue;

    const id = `watchlist:${item.id}`;
    nodes.push({
      label: "Evidence",
      id,
      properties: {
        // Tells news apart from reference evidence (need-evidence.ts) on the same label.
        kind: "watchlist",
        // The RSS parser yields "" for an untitled item, and the answer refuses an
        // empty title: one such row would fail every answer about its account.
        title: item.title.trim() || item.urlCanonical,
        url: item.urlCanonical,
        publishedAt: item.publishedAt.slice(0, 10),
        signal: item.signal,
        domains: [...item.domains],
        source: item.sourceName,
      },
    });
    const segments = segmentsForDomains(item.domains);
    for (const target of targets) {
      supported.add(target);
      relationships.push({ type: "SUPPORTS", from: id, to: target, properties: { url: item.urlCanonical, segments } });
    }
  }

  return { facts: { nodes, relationships }, evidence: nodes.length, entities: supported.size, futureSkipped };
}

/** Reads through a store the caller already holds open (the nightly ingest's). */
export function storeEvidence(store: Pick<WatchlistStore, "itemsInPeriod">): EvidenceSource {
  return (entityIds, sinceIso) => store.itemsInPeriod(sinceIso, FAR_FUTURE, { entities: entityIds });
}

/** Opens watchlist.db for one read. A missing file is null: openWatchlistStore would create it. */
export function watchlistEvidence(path: string): EvidenceSource {
  return (entityIds, sinceIso) => {
    if (!existsSync(path)) return null;
    const store = openWatchlistStore(path);
    try {
      return storeEvidence(store)(entityIds, sinceIso);
    } finally {
      store.close();
    }
  };
}
