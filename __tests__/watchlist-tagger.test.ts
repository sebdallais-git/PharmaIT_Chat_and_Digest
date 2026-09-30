import { describe, expect, it } from "@jest/globals";
import type { Entity, Watchlist } from "../src/services/watchlist-config.js";
import type { RawItem } from "../src/services/watchlist-sources.js";
import type { ChatMessage } from "../src/services/llm-client.js";
import { buildTaggingPrompt, createTagger, parseTagging, type TaggerDeps } from "../src/services/watchlist-tagger.js";

// ---- fixtures --------------------------------------------------------------

function entity(overrides: Partial<Entity> & { id: string; name: string }): Entity {
  return {
    kind: "customer",
    aliases: [],
    domains: [],
    peers: [],
    feeds: [],
    ...overrides,
  };
}

const ROCHE = entity({ id: "roche", name: "Roche", kind: "customer", aliases: ["Genentech"] });
const AWS = entity({ id: "aws", name: "AWS", kind: "vendor", aliases: ["Amazon Web Services"], domains: ["cloud"] });
const NOVARTIS = entity({ id: "novartis", name: "Novartis", kind: "peer" });

const WATCHLIST: Watchlist = {
  entities: new Map([
    ["roche", ROCHE],
    ["aws", AWS],
    ["novartis", NOVARTIS],
  ]),
  topics: [],
  priority: ["roche", "aws", "novartis"],
  notes: [],
};

const ITEM: RawItem = {
  title: "Roche picks AWS for its new R&D data lake",
  url: "https://example.com/a",
  publishedAt: "2026-09-18T00:00:00.000Z",
  body: "Roche announced a multi-year deal with AWS to migrate its research data platform to the cloud.",
  sourceKind: "rss",
  sourceName: "Roche IR",
  titleKey: "roche picks aws for its new rd data lake",
};

function fakeChat(replies: string[]): TaggerDeps["chat"] {
  const queue = [...replies];
  return async (_messages: ChatMessage[]) => {
    const next = queue.shift();
    if (next === undefined) throw new Error("fakeChat: no more replies queued");
    return next;
  };
}

const WELL_FORMED_REPLY = JSON.stringify({
  summary: "Roche is migrating its R&D data platform to AWS.",
  entities: ["roche", "aws"],
  domains: ["cloud", "data"],
  signal: "it_move",
  importance: 5,
  facts: { vendor: "aws" },
});

describe("buildTaggingPrompt", () => {
  it("lists only candidateIds, never the whole watchlist, and instructs strict JSON", () => {
    const messages = buildTaggingPrompt(ITEM, WATCHLIST, ["roche", "aws"]);
    const text = messages.map((m) => m.content).join("\n");

    // Candidates are present by id and name/alias.
    expect(text).toContain("roche");
    expect(text).toContain("Roche");
    expect(text).toContain("aws");
    expect(text).toContain("AWS");

    // The non-candidate entity never leaks into the prompt.
    expect(text).not.toContain("novartis");
    expect(text).not.toContain("Novartis");

    // Strict JSON instruction and importance rubric are present.
    expect(text.toLowerCase()).toContain("json");
    expect(text).toContain("5");
    expect(text).toContain("1");

    // Only roles llm-client understands.
    for (const message of messages) {
      expect(["system", "user"]).toContain(message.role);
    }
  });

  it("still produces a valid prompt when there are no candidate entities", () => {
    const genericItem: RawItem = {
      title: "Generic pharma manufacturing update",
      url: "https://example.com/b",
      publishedAt: "2026-09-18T00:00:00.000Z",
      body: "A routine industry update with no named customer or vendor.",
      sourceKind: "news",
      sourceName: "Google News",
      titleKey: "generic pharma manufacturing update",
    };
    const messages = buildTaggingPrompt(genericItem, WATCHLIST, []);
    expect(messages.length).toBeGreaterThan(0);
    const text = messages.map((m) => m.content).join("\n");
    expect(text).not.toContain("Roche");
    expect(text).not.toContain("AWS");
  });

  it("shows a filled-in example reply, not a type signature, using this item's own candidate ids", () => {
    const messages = buildTaggingPrompt(ITEM, WATCHLIST, ["roche", "aws"]);
    const text = messages.map((m) => m.content).join("\n");

    // A real, parseable example object is present...
    expect(text).toContain('{"summary"');
    expect(text).toContain('"entities":["roche","aws"]');

    // ...and the old type-grammar phrasing is gone.
    expect(text).not.toContain("string | null");
    expect(text).not.toContain('"importance": number');
  });

  it("states anchors for all five importance values", () => {
    const messages = buildTaggingPrompt(ITEM, WATCHLIST, ["roche", "aws"]);
    const text = messages.map((m) => m.content).join("\n");

    expect(text).toContain("5 =");
    expect(text).toContain("4 =");
    expect(text).toContain("3 =");
    expect(text).toContain("2 =");
    expect(text).toContain("1 =");
  });

  it("phrases the signal rule as 'pick exactly one of: ..., or null'", () => {
    const messages = buildTaggingPrompt(ITEM, WATCHLIST, ["roche", "aws"]);
    const text = messages.map((m) => m.content).join("\n");

    expect(text).toContain("pick exactly one of: it_move, financial, cyber, corporate, or null");
  });

  it("states that domains are the IT dimension, glosses every domain, and calls out the empty-domains case", () => {
    const messages = buildTaggingPrompt(ITEM, WATCHLIST, ["roche", "aws"]);
    const text = messages.map((m) => m.content).join("\n");

    // The IT/technology framing that distinguishes domains from the
    // business/clinical/scientific subject of an item.
    expect(text).toContain("IT/technology dimension");

    // Every domain gets its own short gloss (fix round 2: a live smoke test
    // mistagged a trial result as rnd_it without one).
    expect(text).toContain("rnd_it = research informatics, lab data platforms, scientific computing");
    expect(text).toContain("cyber = security incidents, controls, threat actors");
    expect(text).toContain("ai = AI/ML platforms, GPUs, AI factories, model deployment");
    expect(text).toContain("cloud = public/hybrid cloud adoption and migration");
    expect(text).toContain("infrastructure = datacentre, servers, compute, HCI, power and cooling");
    // Split out of infrastructure on 2026-09-30
    expect(text).toContain("networking = switching, routing");
    expect(text).toContain("euc = end-user computing: PCs, laptops");
    expect(text).toContain("mfg_it = manufacturing execution, OT/shop-floor systems, serialisation");
    expect(text).toContain("sap = SAP and ERP programmes");
    expect(text).toContain("data = data platforms, warehouses, lakehouses, analytics");
    expect(text).toContain("storage = primary/secondary storage systems");
    expect(text).toContain("backup = backup, recovery, cyber-vault");

    // domains: [] is explicitly normal, with the trial-result case named.
    expect(text).toContain("domains: [] -- this is normal and expected, not an error");
    expect(text).toContain("drug approval, trial result or regulatory milestone");
  });
});

describe("parseTagging", () => {
  it("turns a well-formed JSON reply into a Tagging", () => {
    const tagging = parseTagging(WELL_FORMED_REPLY, WATCHLIST);
    expect(tagging).toEqual({
      summary: "Roche is migrating its R&D data platform to AWS.",
      entities: ["roche", "aws"],
      domains: ["cloud", "data"],
      signal: "it_move",
      importance: 5,
      facts: { vendor: "aws" },
      flagged: false,
    });
  });

  it("drops unknown entity ids and unknown domains but keeps the rest", () => {
    const raw = JSON.stringify({
      summary: "s",
      entities: ["roche", "not-a-real-entity"],
      domains: ["cloud", "not-a-real-domain"],
      signal: "it_move",
      importance: 3,
      facts: null,
    });
    const tagging = parseTagging(raw, WATCHLIST);
    expect(tagging?.entities).toEqual(["roche"]);
    expect(tagging?.domains).toEqual(["cloud"]);
    expect(tagging?.flagged).toBe(false);
  });

  it("turns an out-of-range importance into null and flags the tagging", () => {
    const raw = JSON.stringify({ summary: "s", entities: [], domains: [], signal: null, importance: 9 });
    const tagging = parseTagging(raw, WATCHLIST);
    expect(tagging?.importance).toBeNull();
    expect(tagging?.flagged).toBe(true);
  });

  it("turns a non-integer importance into null and flags the tagging", () => {
    const raw = JSON.stringify({ summary: "s", entities: [], domains: [], signal: null, importance: 3.5 });
    const tagging = parseTagging(raw, WATCHLIST);
    expect(tagging?.importance).toBeNull();
    expect(tagging?.flagged).toBe(true);
  });

  it("parses JSON wrapped in prose", () => {
    const raw = `Sure, here is the tagging you asked for:\n${WELL_FORMED_REPLY}\nLet me know if you need anything else.`;
    const tagging = parseTagging(raw, WATCHLIST);
    expect(tagging?.entities).toEqual(["roche", "aws"]);
    expect(tagging?.importance).toBe(5);
  });

  it("parses JSON wrapped in a ```json fence", () => {
    const raw = "```json\n" + WELL_FORMED_REPLY + "\n```";
    const tagging = parseTagging(raw, WATCHLIST);
    expect(tagging?.entities).toEqual(["roche", "aws"]);
    expect(tagging?.signal).toBe("it_move");
  });

  it("returns null for a reply with no JSON object at all", () => {
    expect(parseTagging("I cannot help with that.", WATCHLIST)).toBeNull();
  });

  it("returns null for a reply whose braces never balance", () => {
    expect(parseTagging('{"summary": "s", "entities": [', WATCHLIST)).toBeNull();
  });

  it("keeps domains and returns entities: [] when nothing matches", () => {
    const raw = JSON.stringify({ summary: "s", entities: [], domains: ["cyber"], signal: null, importance: null });
    const tagging = parseTagging(raw, WATCHLIST);
    expect(tagging?.entities).toEqual([]);
    expect(tagging?.domains).toEqual(["cyber"]);
  });

  it("dedupes repeated entity ids", () => {
    const raw = JSON.stringify({
      summary: "s",
      entities: ["roche", "aws", "roche"],
      domains: [],
      signal: null,
      importance: null,
    });
    const tagging = parseTagging(raw, WATCHLIST);
    expect(tagging?.entities).toEqual(["roche", "aws"]);
  });

  it("caps an oversized summary at MAX_SUMMARY_LENGTH", () => {
    const longSummary = "x".repeat(2000);
    const raw = JSON.stringify({ summary: longSummary, entities: [], domains: [], signal: null, importance: null });
    const tagging = parseTagging(raw, WATCHLIST);
    expect(tagging?.summary.length).toBe(1200);
    expect(tagging?.summary).toBe(longSummary.slice(0, 1200));
  });

  it("treats facts arriving as a string as absent (null)", () => {
    const raw = JSON.stringify({ summary: "s", entities: [], domains: [], signal: null, importance: null, facts: "vendor: aws" });
    const tagging = parseTagging(raw, WATCHLIST);
    expect(tagging?.facts).toBeNull();
  });

  it("treats facts arriving as an array as absent (null)", () => {
    const raw = JSON.stringify({ summary: "s", entities: [], domains: [], signal: null, importance: null, facts: ["aws", "cloud"] });
    const tagging = parseTagging(raw, WATCHLIST);
    expect(tagging?.facts).toBeNull();
  });
});

describe("createTagger", () => {
  it("returns the parsed tagging on a well-formed first reply", async () => {
    const chat = fakeChat([WELL_FORMED_REPLY]);
    const tagger = createTagger({ chat, watchlist: WATCHLIST });

    const tagging = await tagger(ITEM, ["roche", "aws"]);

    expect(tagging.entities).toEqual(["roche", "aws"]);
    expect(tagging.flagged).toBe(false);
  });

  it("retries once on an unparseable reply, then succeeds", async () => {
    const chat = fakeChat(["not json at all", WELL_FORMED_REPLY]);
    const tagger = createTagger({ chat, watchlist: WATCHLIST });

    const tagging = await tagger(ITEM, ["roche", "aws"]);

    expect(tagging.entities).toEqual(["roche", "aws"]);
    expect(tagging.flagged).toBe(false);
  });

  it("returns a flagged tagging with the item's title as summary after two unparseable replies", async () => {
    const chat = fakeChat(["still not json", "nope, still nothing"]);
    const tagger = createTagger({ chat, watchlist: WATCHLIST });

    const tagging = await tagger(ITEM, ["roche", "aws"]);

    expect(tagging).toEqual({
      summary: ITEM.title,
      entities: [],
      domains: [],
      signal: null,
      importance: null,
      facts: null,
      flagged: true,
    });
  });

  it("never calls chat more than twice", async () => {
    const calls: ChatMessage[][] = [];
    const chat: TaggerDeps["chat"] = async (messages) => {
      calls.push(messages);
      return "garbage";
    };
    const tagger = createTagger({ chat, watchlist: WATCHLIST });

    await tagger(ITEM, ["roche", "aws"]);

    expect(calls.length).toBe(2);
  });

  it("keeps domains and returns entities: [] for an item with no matching entity", async () => {
    const reply = JSON.stringify({
      summary: "General pharma manufacturing news, no named IT vendor.",
      entities: [],
      domains: ["mfg_it"],
      signal: null,
      importance: 2,
      facts: null,
    });
    const chat = fakeChat([reply]);
    const tagger = createTagger({ chat, watchlist: WATCHLIST });

    const tagging = await tagger(ITEM, []);

    expect(tagging.entities).toEqual([]);
    expect(tagging.domains).toEqual(["mfg_it"]);
  });
});
