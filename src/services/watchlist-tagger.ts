// Watchlist item tagger.
//
// Tags a RawItem with the closed watchlist vocabulary -- entities, domains,
// a signal and an importance score -- using the local chat model. Every
// downstream digest sentence rests on these tags, so the closed vocabulary
// is enforced here, at the boundary, exactly like watchlist-store.ts
// enforces it again at the storage boundary: an id or domain the model
// invents rather than picks from the watchlist is dropped, never stored.
//
// Everything here is local: TaggerDeps.chat is injected by the caller
// (never getLlmClient() called from this module), so there is no code path
// by which tagging can reach a cloud model.

import { DOMAINS, SIGNALS, type Domain, type Entity, type Signal, type Watchlist } from "./watchlist-config.js";
import type { RawItem } from "./watchlist-sources.js";
import type { ChatMessage, ChatOptions } from "./llm-client.js";

const DOMAIN_SET: ReadonlySet<string> = new Set(DOMAINS);
const SIGNAL_SET: ReadonlySet<string> = new Set(SIGNALS);

// Short glosses for the prompt (fix round 2): a live smoke test against the
// real 27B model tagged a phase III trial result as domains: ["rnd_it"] --
// "rnd_it" reads, to a model guessing from the bare id, as "this is R&D
// news" rather than its actual meaning, "R&D *IT*" (lab informatics,
// research data platforms, scientific computing). Every domain gets the
// same terse treatment so none of them are left for the model to guess at.
const DOMAIN_GLOSSES: Record<Domain, string> = {
  cyber: "security incidents, controls, threat actors",
  ai: "AI/ML platforms, GPUs, AI factories, model deployment",
  cloud: "public/hybrid cloud adoption and migration",
  infrastructure: "datacentre, servers, compute, HCI, power and cooling",
  rnd_it: "research informatics, lab data platforms, scientific computing",
  mfg_it: "manufacturing execution, OT/shop-floor systems, serialisation",
  sap: "SAP and ERP programmes",
  data: "data platforms, warehouses, lakehouses, analytics",
  storage: "primary/secondary storage systems",
  backup: "backup, recovery, cyber-vault",
  networking: "switching, routing, LAN/WAN, SD-WAN, wireless, datacentre fabrics",
  euc: "end-user computing: PCs, laptops, workstations, VDI, device management, digital workplace",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isKnownDomain(value: unknown): value is Domain {
  return typeof value === "string" && DOMAIN_SET.has(value);
}

function isKnownSignal(value: unknown): value is Signal {
  return typeof value === "string" && SIGNAL_SET.has(value);
}

// A valid importance is an integer 1-5. Anything else (out of range,
// fractional, a string, missing) is not a parse failure on its own -- the
// rest of the reply may still be usable -- but the score itself becomes
// null and the whole tagging is flagged for human review (R3 of the brief).
function isValidImportance(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5;
}

// A digest sentence never needs more than a couple of paragraphs; caps a
// runaway summary (the local model occasionally rambles) rather than
// storing an unbounded string all the way into watchlist-store.ts.
export const MAX_SUMMARY_LENGTH = 1200;

export interface Tagging {
  summary: string;
  entities: string[];
  domains: Domain[];
  signal: Signal | null;
  importance: number | null;
  facts: Record<string, unknown> | null;
  flagged: boolean;
}

export interface TaggerDeps {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
  watchlist: Watchlist;
}

// ---- prompt -----------------------------------------------------------

// Renders one candidate entity as "id (Name; alias: A, alias: B)" so the
// model can match either the canonical name or an alias (e.g. "Genentech")
// back to the id it must actually return.
function describeCandidate(entity: Entity): string {
  const aliasSuffix = entity.aliases.length > 0 ? `; aliases: ${entity.aliases.join(", ")}` : "";
  return `- ${entity.id} (${entity.name}${aliasSuffix})`;
}

// Builds a filled-in example reply, not a type signature. A 27B model
// follows a concrete example far more reliably than a TypeScript-flavoured
// grammar (an earlier version literally showed `"signal": string | null,
// "importance": number` and invited the model to echo those placeholder
// tokens back). The example draws its entity ids from this item's own
// candidates when there are any, so it never has to hardcode a real
// customer name into the static prompt text (that leak was fixed once
// already and must not come back through the example). With no candidates
// for this item, the example truthfully shows the "no match" shape instead
// of inventing a fake id.
function buildExampleReply(candidates: Entity[]): string {
  const exampleEntities = candidates.slice(0, 2).map((entity) => entity.id);
  const example = {
    summary: "Example: a candidate entity made a notable IT-related move.",
    entities: exampleEntities,
    domains: ["cloud"],
    signal: "it_move",
    importance: 4,
    facts: { vendor: "example-vendor" },
  };
  return JSON.stringify(example);
}

// Builds the two-message chat prompt for one item. `candidateIds` is the
// caller's job to compute (the entities whose name or an alias appears in
// the item, plus the feed's own entity) -- this function only renders
// whichever ids it is given, and never reaches into the full watchlist for
// anything beyond looking those ids up. That is what keeps the prompt short
// with ~71 entities in the watchlist: only the handful of candidates ever
// appear in the text sent to the model.
export function buildTaggingPrompt(item: RawItem, watchlist: Watchlist, candidateIds: string[]): ChatMessage[] {
  const candidates = candidateIds
    .map((id) => watchlist.entities.get(id))
    .filter((entity): entity is Entity => entity !== undefined);

  const entityList =
    candidates.length > 0
      ? candidates.map(describeCandidate).join("\n")
      : "(none -- no watched entity's name or alias appears in this item)";

  const system = [
    "You are a tagging engine for a pharma IT-watchlist digest. You read one news item and return ONE JSON object, nothing else.",
    "",
    "Required keys: summary, entities, domains, signal, importance, facts. signal and facts may be null; the others are never omitted. No extra keys.",
    "Example reply (illustrative values only -- this is not this item's actual answer):",
    buildExampleReply(candidates),
    "",
    "Rules (closed vocabularies -- any value outside these lists is invalid and will be discarded):",
    "- entities: pick ZERO OR MORE ids ONLY from the candidate list below. Never invent an id, and never return an id that is not in this list, even if the company is mentioned elsewhere.",
    "Candidate entities for this item:",
    entityList,
    "",
    "- domains: describe ONLY the IT/technology dimension of the item -- never the business, clinical or scientific subject on its own. Pick zero or more values from:",
    ...DOMAINS.map((domain) => `  ${domain} = ${DOMAIN_GLOSSES[domain]}`),
    "  An item with no technology angle (most pharma business, clinical and scientific news) MUST return domains: [] -- this is normal and expected, not an error.",
    "  Example: a drug approval, trial result or regulatory milestone that names no technology is domains: [] and usually signal: corporate.",
    `- signal: pick exactly one of: ${SIGNALS.join(", ")}, or null.`,
    "- importance: an integer from 1 to 5, rating how much this item matters to the watchlist:",
    "  5 = a named customer's strategic IT or financial move (a platform switch, a major outage, an acquisition, a large contract).",
    "  4 = a significant move by a peer or a major vendor that affects a customer's market position.",
    "  3 = a named customer or vendor has a smaller, still concrete IT-relevant development.",
    "  2 = incremental product or partnership news with no named customer impact.",
    "  1 = routine vendor noise (a minor product update, a generic press release) with no clear link to a watched entity's strategy.",
    "  Use the anchor that best matches; never omit importance.",
    "- facts: a small object of structured details worth keeping (e.g. {\"vendor\": \"aws\", \"dealSize\": \"multi-year\"}), or null if there is nothing structured to extract.",
    "- summary: one or two plain-English sentences, no markdown.",
    "",
    "Respond with the JSON object only -- no prose before or after it, no markdown code fence.",
  ].join("\n");

  const user = [
    `Title: ${item.title}`,
    `Source: ${item.sourceName} (${item.sourceKind})`,
    `Published: ${item.publishedAt}`,
    "Body:",
    item.body,
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// ---- parsing ------------------------------------------------------------

// Extracts the first balanced {...} block from `raw`, tolerating prose
// before/after and a ```json fence -- the local 27B model wraps its JSON in
// both often enough that a bare JSON.parse(raw) would fail far too often.
// Brace matching tracks string literals (and escapes within them) so a
// brace character inside a quoted summary never desyncs the depth count.
function extractJsonBlock(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = start; i < raw.length; i++) {
    const char = raw[i];

    if (inString) {
      if (escapeNext) {
        escapeNext = false;
      } else if (char === "\\") {
        escapeNext = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }

  return null; // braces never balanced -- truncated/garbled reply
}

// Parses a raw model reply into a Tagging, or null when the reply carries no
// recoverable JSON object at all (createTagger's cue to retry). Once a JSON
// object is found, every field is validated independently against its
// closed vocabulary: an unknown entity id or domain is dropped (not fatal),
// an invalid importance becomes null and flags the tagging, but none of
// that turns the whole parse into a null result -- only a missing/unparseable
// JSON block does.
export function parseTagging(raw: string, watchlist: Watchlist): Tagging | null {
  const block = extractJsonBlock(raw);
  if (block === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const rawSummary = typeof parsed.summary === "string" ? parsed.summary : "";
  const summary = rawSummary.length > MAX_SUMMARY_LENGTH ? rawSummary.slice(0, MAX_SUMMARY_LENGTH) : rawSummary;

  const entities = Array.isArray(parsed.entities)
    ? [
        ...new Set(
          parsed.entities.filter((value): value is string => typeof value === "string" && watchlist.entities.has(value)),
        ),
      ]
    : [];

  const domains = Array.isArray(parsed.domains) ? parsed.domains.filter(isKnownDomain) : [];

  const signal = isKnownSignal(parsed.signal) ? parsed.signal : null;

  let importance: number | null = null;
  let flagged = false;
  if (parsed.importance !== undefined && parsed.importance !== null) {
    if (isValidImportance(parsed.importance)) {
      importance = parsed.importance;
    } else {
      // Present but outside 1-5 or non-integer: drop the score, flag for review.
      flagged = true;
    }
  }

  // isRecord rejects arrays, strings, numbers and booleans -- a model that
  // returns "facts": "some string" or "facts": [1, 2] gets null here rather
  // than a Tagging.facts typed as Record<string, unknown> containing
  // something that isn't actually a record.
  const facts = isRecord(parsed.facts) ? parsed.facts : null;

  return { summary, entities, domains, signal, importance, facts, flagged };
}

// ---- tagger ---------------------------------------------------------------

// The flagged fallback returned when neither chat call yields a parseable
// reply: no tags, the item's own title standing in for a summary so the
// digest still has something to show, and flagged=true so a human can go
// look at what the model actually said.
function unparseableFallback(item: RawItem): Tagging {
  return {
    summary: item.title,
    entities: [],
    domains: [],
    signal: null,
    importance: null,
    facts: null,
    flagged: true,
  };
}

// Builds the tagging function for one run. Retries the chat call exactly
// once on an unparseable reply (two chat calls total, at most) before
// falling back -- the local model occasionally drops a stray token that
// breaks JSON.parse but produces a clean reply on a second try; retrying
// forever would just burn the run's time budget on a genuinely broken
// prompt or model.
export function createTagger(deps: TaggerDeps): (item: RawItem, candidateIds: string[]) => Promise<Tagging> {
  return async (item, candidateIds) => {
    const messages = buildTaggingPrompt(item, deps.watchlist, candidateIds);

    const firstReply = await deps.chat(messages);
    const firstTagging = parseTagging(firstReply, deps.watchlist);
    if (firstTagging !== null) return firstTagging;

    const secondReply = await deps.chat(messages);
    const secondTagging = parseTagging(secondReply, deps.watchlist);
    if (secondTagging !== null) return secondTagging;

    return unparseableFallback(item);
  };
}
