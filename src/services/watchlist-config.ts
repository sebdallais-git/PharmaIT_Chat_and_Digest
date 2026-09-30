// Watchlist config schema and loader.
//
// config/watchlist.yaml is the single definition of who is watched (customers,
// their peer sets, IT vendors) and what topics are tracked with no named entity.
// This module parses that document into typed structures consumed by every
// later watchlist task (adapters, item store, tagger, ingest).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYamlDocument } from "yaml";

export const DOMAINS = [
  "cyber",
  "ai",
  "cloud",
  "infrastructure",
  "rnd_it",
  "mfg_it",
  "sap",
  "data",
  "storage",
  "backup",
  // Split out of "infrastructure" on 2026-09-30: the user sells both lines, and
  // lumped in with datacentre news neither showed up in a digest of its own
  "networking",
  "euc",
] as const;
export type Domain = (typeof DOMAINS)[number];

export const SIGNALS = ["it_move", "financial", "cyber", "corporate"] as const;
export type Signal = (typeof SIGNALS)[number];

export type EntityKind = "customer" | "peer" | "vendor";

export interface Feed {
  kind: "rss" | "edgar" | "ir_page" | "news";
  url?: string;
  cik?: string;
  verifiedAt?: string;
  note?: string;
}

export interface Entity {
  id: string;
  name: string;
  kind: EntityKind;
  aliases: string[];
  domains: Domain[];
  peers: string[];
  feeds: Feed[];
}

export interface TopicQuery {
  query: string;
  domains: Domain[];
}

export interface Watchlist {
  entities: Map<string, Entity>;
  topics: TopicQuery[];
  priority: string[];
  // Informational notes collected while parsing (e.g. a peer with no separate
  // definition, auto-created from a customer's peer list). These never cause
  // a parse to fail; they are returned on every successful parse so callers
  // can see what was inferred, and are also folded into a thrown
  // WatchlistError's message when the parse fails for an unrelated reason.
  notes: string[];
}

export class WatchlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatchlistError";
  }
}

// ---- type guards --------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDomain(value: string): value is Domain {
  return (DOMAINS as readonly string[]).includes(value);
}

// ---- small parsing helpers, collecting problems rather than throwing ---

function parseStringArray(value: unknown, label: string, errors: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array of strings`);
    return [];
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      result.push(item);
    } else {
      errors.push(`${label} contains a non-string entry`);
    }
  }
  return result;
}

const KNOWN_FEED_KINDS = new Set(["rss", "edgar", "ir_page", "news"]);

function parseFeeds(value: unknown, label: string, errors: string[]): Feed[] {
  if (value === undefined) return [];
  if (!isRecord(value)) {
    errors.push(`${label} feeds must be an object`);
    return [];
  }

  const feeds: Feed[] = [];
  for (const [kind, rawEntry] of Object.entries(value)) {
    if (!KNOWN_FEED_KINDS.has(kind)) {
      errors.push(`${label} has an unknown feed kind "${kind}"`);
      continue;
    }
    if (kind === "rss" || kind === "news") {
      const urls = parseStringArray(rawEntry, `${label} ${kind} feed`, errors);
      for (const url of urls) feeds.push({ kind, url });
    } else if (kind === "edgar") {
      if (typeof rawEntry !== "string") {
        errors.push(`${label} edgar feed must be a string CIK`);
        continue;
      }
      feeds.push({ kind: "edgar", cik: rawEntry });
    } else {
      // ir_page
      if (typeof rawEntry !== "string") {
        errors.push(`${label} ir_page feed must be a string URL`);
        continue;
      }
      feeds.push({ kind: "ir_page", url: rawEntry });
    }
  }
  return feeds;
}

// A bare vendor/peer id has no display name of its own in the config; derive
// a readable one from the kebab-case id (e.g. "google-cloud" -> "Google Cloud").
function humanize(id: string): string {
  return id
    .split("-")
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// A single verifiedAt date applies to every feed a fragment records for one
// entity (they were all checked in the same run) -- stamped onto each Feed
// object rather than kept as a separate entity-level field, since Feed
// already carries its own optional verifiedAt (Task 1).
function stampVerifiedAt(feeds: Feed[], value: unknown, label: string, errors: string[]): void {
  if (value === undefined) return;
  if (typeof value !== "string") {
    errors.push(`${label} verifiedAt must be a string`);
    return;
  }
  for (const feed of feeds) feed.verifiedAt = value;
}

interface VendorEntryData {
  id: string;
  name?: string;
  aliases: string[];
  feeds: Feed[];
}

// R8: a vendor list entry is either a bare id (unchanged) or a single-key
// mapping { id: { name?, aliases?, feeds?, verifiedAt? } } -- needed to give
// a renamed vendor (e.g. Everpure, formerly Pure Storage) an explicit
// name/aliases and to attach researched feeds to any vendor.
function parseVendorEntries(value: unknown, label: string, errors: string[]): VendorEntryData[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array of strings`);
    return [];
  }

  const result: VendorEntryData[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      result.push({ id: item, aliases: [], feeds: [] });
      continue;
    }
    if (!isRecord(item)) {
      errors.push(`${label} contains an entry that is neither a string id nor a single-key mapping`);
      continue;
    }
    const keys = Object.keys(item);
    if (keys.length !== 1) {
      errors.push(`${label} vendor mapping must have exactly one key (the vendor id), found ${keys.length}`);
      continue;
    }
    const id = keys[0];
    const body = item[id];
    if (!isRecord(body)) {
      errors.push(`${label} vendor "${id}" must map to an object`);
      continue;
    }
    const name = typeof body.name === "string" ? body.name : undefined;
    const aliases = parseStringArray(body.aliases, `${label} vendor "${id}" aliases`, errors);
    const feeds = parseFeeds(body.feeds, `${label} vendor "${id}"`, errors);
    stampVerifiedAt(feeds, body.verifiedAt, `${label} vendor "${id}"`, errors);
    result.push({ id, name, aliases, feeds });
  }
  return result;
}

// ---- main parser ----------------------------------------------------------

export function parseWatchlist(raw: unknown): Watchlist {
  if (!isRecord(raw)) {
    throw new WatchlistError("watchlist config must be an object");
  }

  const errors: string[] = [];
  // Notes about entities that had to be inferred (e.g. a peer with no
  // separate definition) -- see Watchlist.notes for what callers get.
  const notes: string[] = [];

  const entities = new Map<string, Entity>();
  const customerIds: string[] = [];
  const peerIds: string[] = [];
  const vendorIds: string[] = [];

  function addEntity(id: string, entity: Entity, priorityList: string[]): void {
    if (entities.has(id)) {
      errors.push(`duplicate id "${id}"`);
      return;
    }
    entities.set(id, entity);
    priorityList.push(id);
  }

  // --- customers ---
  const customersRaw = raw.customers;
  if (customersRaw !== undefined && !isRecord(customersRaw)) {
    errors.push('"customers" must be an object');
  }
  const customerEntries = isRecord(customersRaw) ? Object.entries(customersRaw) : [];

  for (const [id, value] of customerEntries) {
    if (!isRecord(value)) {
      errors.push(`customer "${id}" must be an object`);
      continue;
    }
    let name = id;
    if (typeof value.name === "string") {
      name = value.name;
    } else {
      errors.push(`customer "${id}" is missing a "name"`);
    }
    const aliases = parseStringArray(value.aliases, `customer "${id}" aliases`, errors);
    const peers = parseStringArray(value.peers, `customer "${id}" peers`, errors);
    const feeds = parseFeeds(value.feeds, `customer "${id}"`, errors);
    stampVerifiedAt(feeds, value.verifiedAt, `customer "${id}"`, errors);
    addEntity(id, { id, name, kind: "customer", aliases, domains: [], peers, feeds }, customerIds);
  }

  // --- vendors ---
  const vendorsRaw = raw.vendors;
  if (vendorsRaw !== undefined && !isRecord(vendorsRaw)) {
    errors.push('"vendors" must be an object');
  }
  const vendorEntries = isRecord(vendorsRaw) ? Object.entries(vendorsRaw) : [];

  for (const [groupKey, value] of vendorEntries) {
    if (!isDomain(groupKey)) {
      errors.push(`vendor group "${groupKey}" is not a known domain`);
      continue;
    }
    const items = parseVendorEntries(value, `vendor group "${groupKey}"`, errors);
    for (const item of items) {
      const existing = entities.get(item.id);
      if (existing !== undefined) {
        // A vendor spanning several domains (e.g. Databricks: both "ai" and
        // "data") is listed once per domain group by design; merge domains
        // instead of treating the repeat as a duplicate id. But the same id
        // twice within the SAME group's array is a config typo (R4), not a
        // multi-domain vendor, and is a hard error. Any other entity kind
        // reusing this id is a genuine cross-section collision.
        if (existing.kind === "vendor") {
          if (existing.domains.includes(groupKey)) {
            errors.push(`duplicate id "${item.id}" within vendor group "${groupKey}"`);
          } else {
            existing.domains.push(groupKey);
            // A multi-domain vendor is expected to define its name/aliases/
            // feeds once (R8) and repeat as a bare id elsewhere, but tolerate
            // a second mapping supplying them too.
            if (item.name !== undefined) existing.name = item.name;
            if (item.aliases.length > 0) existing.aliases = item.aliases;
            if (item.feeds.length > 0) existing.feeds = item.feeds;
          }
        } else {
          errors.push(`duplicate id "${item.id}"`);
        }
        continue;
      }
      addEntity(
        item.id,
        {
          id: item.id,
          name: item.name ?? humanize(item.id),
          kind: "vendor",
          aliases: item.aliases,
          domains: [groupKey],
          peers: [],
          feeds: item.feeds,
        },
        vendorIds,
      );
    }
  }

  // --- explicit peer feeds (a peer has no section of its own the way
  // customers/vendors do; "peers" only ever attaches feeds to a peer id that
  // some customer's peer list already references -- see the loop below) ---
  const peersRaw = raw.peers;
  if (peersRaw !== undefined && !isRecord(peersRaw)) {
    errors.push('"peers" must be an object');
  }
  const peerEntries = isRecord(peersRaw) ? Object.entries(peersRaw) : [];

  const explicitPeerFeeds = new Map<string, Feed[]>();
  for (const [id, value] of peerEntries) {
    if (!isRecord(value)) {
      errors.push(`peer "${id}" must be an object`);
      continue;
    }
    const feeds = parseFeeds(value.feeds, `peer "${id}"`, errors);
    stampVerifiedAt(feeds, value.verifiedAt, `peer "${id}"`, errors);
    explicitPeerFeeds.set(id, feeds);
  }
  const consumedExplicitPeerIds = new Set<string>();

  // --- peers implied by customers' peer lists ---
  // Snapshot the customer entities before mutating `entities` with new peers.
  const customerEntitiesSnapshot = customerIds
    .map((id) => entities.get(id))
    .filter((entity): entity is Entity => entity !== undefined);

  for (const customer of customerEntitiesSnapshot) {
    for (const peerId of customer.peers) {
      if (entities.has(peerId)) continue; // already a customer, vendor or earlier peer

      const explicitFeeds = explicitPeerFeeds.get(peerId);
      if (explicitFeeds !== undefined) {
        consumedExplicitPeerIds.add(peerId);
        entities.set(peerId, {
          id: peerId,
          name: humanize(peerId),
          kind: "peer",
          aliases: [],
          domains: [],
          peers: [],
          feeds: explicitFeeds,
        });
        peerIds.push(peerId);
        continue;
      }

      notes.push(`peer "${peerId}" referenced by "${customer.id}" has no separate definition; auto-created`);
      entities.set(peerId, {
        id: peerId,
        name: humanize(peerId),
        kind: "peer",
        aliases: [],
        domains: [],
        peers: [],
        feeds: [],
      });
      peerIds.push(peerId);
    }
  }

  for (const id of explicitPeerFeeds.keys()) {
    if (!consumedExplicitPeerIds.has(id)) {
      errors.push(`peer "${id}" is defined under "peers" but no customer's peer list references it`);
    }
  }

  // --- topics ---
  const topicsRaw = raw.topics;
  if (topicsRaw !== undefined && !isRecord(topicsRaw)) {
    errors.push('"topics" must be an object');
  }
  const topicEntries = isRecord(topicsRaw) ? Object.entries(topicsRaw) : [];

  const topics: TopicQuery[] = [];
  for (const [groupKey, value] of topicEntries) {
    let domains: Domain[];
    if (groupKey === "none") {
      domains = [];
    } else if (isDomain(groupKey)) {
      domains = [groupKey];
    } else {
      errors.push(`topic group "${groupKey}" is not a known domain or "none"`);
      continue;
    }
    const queries = parseStringArray(value, `topic group "${groupKey}"`, errors);
    for (const query of queries) {
      topics.push({ query, domains });
    }
  }

  if (errors.length > 0) {
    throw new WatchlistError([...errors, ...notes].join("\n"));
  }

  return {
    entities,
    topics,
    priority: [...customerIds, ...peerIds, ...vendorIds],
    notes,
  };
}

export function loadWatchlist(path: string = "config/watchlist.yaml"): Watchlist {
  const resolvedPath = resolve(process.cwd(), path);
  const contents = readFileSync(resolvedPath, "utf8");
  const document: unknown = parseYamlDocument(contents);
  return parseWatchlist(document);
}
