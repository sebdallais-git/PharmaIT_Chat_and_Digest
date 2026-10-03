import { describe, expect, it } from "@jest/globals";
import type { Entity, Watchlist } from "../src/services/watchlist-config.js";
import type { StoredItem } from "../src/services/watchlist-store.js";
import { isDigestRequest, parseDigestRequest, parsePeriod } from "../src/services/digest-request.js";
import {
  buildDigest,
  parseBullets,
  renderDigest,
  resolveAccounts,
  selectDigestItems,
  type CompleteFn,
  type DigestProse,
} from "../src/services/digest-builder.js";
import { PORTFOLIO_LINES, type Role } from "../src/services/role-store.js";
import { digestResponse, parseDigestCall } from "../src/api/digest.js";

// The digest agent: a period's watchlist items, chosen deterministically, turned
// into a role-driven digest that ends with sales action items. Asked for in the
// web chat or on Telegram, and sent every Monday at 07:00.

function entity(id: string, kind: Entity["kind"], over: Partial<Entity> = {}): Entity {
  return { id, name: over.name ?? id[0].toUpperCase() + id.slice(1), kind, aliases: [], domains: [], peers: [], feeds: [], ...over };
}

const watchlist: Watchlist = {
  entities: new Map(
    [
      entity("roche", "customer", { peers: ["pfizer"] }),
      entity("novartis", "customer"),
      entity("sandoz", "customer"),
      entity("pfizer", "peer"),
      entity("dell", "vendor"),
      entity("netapp", "vendor", { name: "NetApp" }),
      entity("crowdstrike", "vendor", { name: "CrowdStrike" }),
    ].map((e) => [e.id, e]),
  ),
  topics: [],
  priority: [],
  notes: [],
};

let nextId = 1;
function item(over: Partial<StoredItem> & { title: string }): StoredItem {
  const id = nextId++;
  return {
    id,
    urlCanonical: `https://news.example/${id}`,
    contentHash: `h${id}`,
    titleKey: over.title.toLowerCase(),
    sourceKind: "rss",
    sourceName: "Source",
    summary: `summary of ${over.title}`,
    signal: null,
    importance: 3,
    facts: null,
    publishedAt: "2026-09-29T08:00:00.000Z",
    fetchedAt: "2026-09-30T00:40:00.000Z",
    body: "",
    entities: [],
    domains: [],
    urls: [`https://news.example/${id}`],
    flagged: false,
    ...over,
  };
}

const dellGam: Role = {
  id: "dell-gam",
  title: "GAM",
  company: "Dell",
  accounts: ["Roche", "Novartis", "Sandoz", "Lonza"],
  portfolio: [...PORTFOLIO_LINES],
  focus: "",
  updatedAt: "2026-09-30T08:00:00.000Z",
};

// Wednesday 30 Sep 2026, 10:00 local
const now = new Date(2026, 8, 30, 10, 0, 0);

describe("isDigestRequest", () => {
  it.each([
    "make me a digest of what happened this week",
    "weekly update please",
    "what happened last week?",
    "recap of this month",
    "news from yesterday",
  ])("recognises %s", (text) => expect(isDigestRequest(text)).toBe(true));

  it.each(["What is Dell PowerProtect?", "Which ransomware groups target pharma?", "I am the Dell GAM"])("ignores %s", (text) =>
    expect(isDigestRequest(text)).toBe(false),
  );
});

describe("parsePeriod", () => {
  it("defaults to the last 7 days", () => {
    const { from, to, label } = parsePeriod("make me a digest of what happened this week", now);
    expect(to).toEqual(now);
    expect(now.getTime() - from.getTime()).toBe(7 * 24 * 3600 * 1000);
    expect(label).toBe("the last 7 days");
  });

  // The Monday job asks for "last week": the previous Monday 00:00 to this Monday 00:00
  it("reads last week as the previous calendar week", () => {
    const { from, to, label } = parsePeriod("last week", now);
    expect(from).toEqual(new Date(2026, 8, 21));
    expect(to).toEqual(new Date(2026, 8, 28));
    expect(label).toBe("the week of 21 Sept–27 Sept");
  });

  it("reads today, yesterday, this month and last N days", () => {
    expect(parsePeriod("today", now).from).toEqual(new Date(2026, 8, 30));
    expect(parsePeriod("yesterday", now)).toMatchObject({ from: new Date(2026, 8, 29), to: new Date(2026, 8, 30) });
    expect(parsePeriod("this month", now).from).toEqual(new Date(2026, 8, 1));
    expect(parsePeriod("the last 3 days", now).label).toBe("the last 3 days");
    expect(parsePeriod("since monday", now).from).toEqual(new Date(2026, 8, 28));
  });
});

describe("parseDigestRequest", () => {
  it("picks up named companies and domains as the focus", () => {
    const request = parseDigestRequest("storage news at Novartis last month", now, watchlist.entities.values());
    expect(request.focusEntities).toEqual(["novartis"]);
    expect(request.focusDomains).toEqual(["storage"]);
  });

  it("has no focus for a plain weekly digest", () => {
    const request = parseDigestRequest("make me a digest of what happened this week", now, watchlist.entities.values());
    expect(request).toMatchObject({ focusEntities: [], focusDomains: [], accountsOnly: false });
  });

  // networking and euc were split out of infrastructure on 2026-09-30
  it("reads networking and end-user computing words as their own domains", () => {
    expect(parseDigestRequest("networking news this week", now, []).focusDomains).toEqual(["networking"]);
    expect(parseDigestRequest("anything on laptops and VDI last month", now, []).focusDomains).toEqual(["euc"]);
    expect(parseDigestRequest("server news", now, []).focusDomains).toEqual(["infrastructure"]);
    // "medical devices" is pharma news, not end-user computing
    expect(parseDigestRequest("medical devices digest this week", now, []).focusDomains).toEqual([]);
  });

  it("reads 'my accounts' as accounts only", () => {
    expect(parseDigestRequest("digest for my accounts", now, watchlist.entities.values()).accountsOnly).toBe(true);
  });
});

describe("resolveAccounts", () => {
  it("maps the role's accounts to watchlist entities and reports the ones it does not follow", () => {
    expect(resolveAccounts(watchlist, dellGam)).toEqual({ ids: ["roche", "novartis", "sandoz"], unmatched: ["Lonza"] });
  });

  it("uses the watchlist's customers when no role is set", () => {
    expect(resolveAccounts(watchlist, null).ids).toEqual(["roche", "novartis", "sandoz"]);
  });
});

describe("selectDigestItems", () => {
  const request = parseDigestRequest("digest this week", now, []);

  it("sorts items into sections: accounts first, then infrastructure, industry, cyber, AI, R&D", () => {
    const items = [
      item({ title: "Roche buys GPUs", entities: ["roche"], domains: ["ai"] }),
      item({ title: "NetApp launches array", entities: ["netapp"], domains: ["storage"] }),
      item({ title: "Pfizer deal", entities: ["pfizer"] }),
      item({ title: "CrowdStrike report", entities: ["crowdstrike"], domains: ["cyber"] }),
      item({ title: "LLM news", domains: ["ai"] }),
      item({ title: "LIMS upgrade", domains: ["rnd_it"] }),
    ];
    const selection = selectDigestItems(items, request, watchlist, dellGam);
    const titles = (key: keyof typeof selection.sections) => selection.sections[key].map((e) => e.item.title);
    expect(titles("accounts")).toEqual(["Roche buys GPUs"]);
    expect(titles("infrastructure")).toEqual(["NetApp launches array"]);
    expect(titles("industry")).toEqual(["Pfizer deal"]);
    expect(titles("cyber")).toEqual(["CrowdStrike report"]);
    expect(titles("aiCloud")).toEqual(["LLM news"]);
    expect(titles("rdMfg")).toEqual(["LIMS upgrade"]);
    expect(selection.numbered.map((e) => e.n)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("files networking and end-user computing news under the infrastructure scene", () => {
    const selection = selectDigestItems(
      [item({ title: "Arista switch", domains: ["networking"] }), item({ title: "HP AI PCs", domains: ["euc"] })],
      request,
      watchlist,
      dellGam,
    );
    expect(selection.sections.infrastructure.map((e) => e.item.title)).toEqual(["Arista switch", "HP AI PCs"]);
  });

  it("ranks by importance, caps each section and drops low-importance market noise", () => {
    const items = [
      ...Array.from({ length: 12 }, (_, i) => item({ title: `infra ${i}`, domains: ["storage"], importance: (i % 4) + 1 })),
      item({ title: "minor Roche note", entities: ["roche"], importance: 1 }),
    ];
    const selection = selectDigestItems(items, request, watchlist, dellGam);
    expect(selection.sections.infrastructure).toHaveLength(8);
    expect(selection.sections.infrastructure.every((e) => (e.item.importance ?? 0) >= 2)).toBe(true);
    expect(selection.sections.infrastructure[0].item.importance).toBe(4);
    // An account's own news is kept whatever its importance
    expect(selection.sections.accounts.map((e) => e.item.title)).toEqual(["minor Roche note"]);
  });

  // Live on 2026-09-30: Roche had 25 items, Novartis 3, Sandoz 2, and ranking by
  // importance alone filled every account slot with Roche
  it("gives every account a share of the accounts section, round-robin", () => {
    const items = [
      ...Array.from({ length: 10 }, (_, i) => item({ title: `Roche ${i}`, entities: ["roche"], importance: 5 })),
      item({ title: "Novartis a", entities: ["novartis"], importance: 3 }),
      item({ title: "Novartis b", entities: ["novartis"], importance: 2 }),
      item({ title: "Sandoz a", entities: ["sandoz"], importance: 2 }),
    ];
    const titles = selectDigestItems(items, request, watchlist, dellGam).sections.accounts.map((e) => e.item.title);
    expect(titles).toHaveLength(8);
    expect(titles).toEqual(expect.arrayContaining(["Novartis a", "Novartis b", "Sandoz a"]));
    expect(titles.slice(0, 3)).toEqual(["Roche 0", "Novartis a", "Sandoz a"]);
  });

  it("keeps only the focus when one is asked for", () => {
    const focused = parseDigestRequest("storage digest this week", now, []);
    const selection = selectDigestItems(
      [item({ title: "array", domains: ["storage"] }), item({ title: "breach", domains: ["cyber"] })],
      focused,
      watchlist,
      dellGam,
    );
    expect(selection.numbered.map((e) => e.item.title)).toEqual(["array"]);
  });
});

describe("parseBullets", () => {
  it("keeps bullets that cite known items and strips unknown references", () => {
    const reply = "Here you go:\n- Roche is buying GPUs [1][9]\n- Unsourced claim\n* NetApp launched [2]\nThanks!";
    expect(parseBullets(reply, new Set([1, 2]), 5)).toEqual(["Roche is buying GPUs [1]", "NetApp launched [2]"]);
  });

  it("stops at the maximum", () => {
    expect(parseBullets("- a [1]\n- b [1]\n- c [1]", new Set([1]), 2)).toHaveLength(2);
  });
});

describe("renderDigest", () => {
  const selection = selectDigestItems(
    [
      item({ title: "Roche buys GPUs", entities: ["roche"], domains: ["ai"] }),
      item({ title: "NetApp launches array", entities: ["netapp"], domains: ["storage"] }),
      ...Array.from({ length: 5 }, (_, i) => item({ title: `A long cyber headline number ${i} about ransomware in pharma`, domains: ["cyber"] })),
    ],
    parseDigestRequest("this week", now, []),
    watchlist,
    dellGam,
  );
  const prose: DigestProse = {
    headline: ["Roche is scaling AI [1]"],
    accounts: ["Roche: GPU purchase opens a server conversation [1]"],
    infrastructure: [],
    actions: ["**Servers** · Roche: propose PowerEdge XE for the GPU build-out [1]"],
  };
  const options = { period: "the last 7 days", role: dellGam, now };

  it("renders every part, with links, the role and the footer", () => {
    const text = renderDigest(selection, prose, { failingFeeds: [{ feedId: "veeva:rss:x", failures: 11 }] }, { ...options, budget: 20_000 });
    expect(text).toContain("**Digest · the last 7 days** for GAM at Dell");
    expect(text).toContain("[[1]](https://news.example/");
    expect(text).toContain("**Your accounts**");
    // No prose for infrastructure: its items are listed instead
    expect(text).toContain("[NetApp launches array](https://news.example/");
    expect(text).toContain("**Action items**");
    expect(text).toContain("PowerEdge XE");
    expect(text).toContain("not in the watchlist: Lonza");
    expect(text).toContain("veeva (11×)");
  });

  it("fits a Telegram budget by dropping links, then shortening lists", () => {
    const full = renderDigest(selection, prose, { failingFeeds: [] }, { ...options, budget: 20_000 });
    const tight = renderDigest(selection, prose, { failingFeeds: [] }, { ...options, budget: 700 });
    expect(full.length).toBeGreaterThan(700);
    expect(tight.length).toBeLessThanOrEqual(700);
    expect(tight).not.toContain("https://");
    expect(tight).toContain("**Action items**");
  });

  // Live: the hard cut landed on the action items, the part that matters most
  it("never cuts the action items: lists and prose give way first", () => {
    const longProse: DigestProse = {
      headline: Array.from({ length: 4 }, (_, i) => `Headline ${i} ${"word ".repeat(40)}[1]`),
      accounts: ["Roche: " + "word ".repeat(40) + "[1]"],
      infrastructure: Array.from({ length: 4 }, (_, i) => `Infra ${i} ${"word ".repeat(40)}[2]`),
      actions: Array.from({ length: 6 }, (_, i) => `**Line ${i}** · Roche: ${"act ".repeat(30)}[1]`),
    };
    const text = renderDigest(selection, longProse, { failingFeeds: [] }, { ...options, budget: 2000 });
    expect(text.length).toBeLessThanOrEqual(2000);
    for (let i = 0; i < 6; i++) expect(text).toContain(`**Line ${i}**`);
    expect(text).not.toContain("…");
  });

  it("asks for a role when none is set", () => {
    const text = renderDigest(selection, prose, { failingFeeds: [] }, { ...options, role: null, budget: 20_000 });
    expect(text).toMatch(/No role set/);
  });
});

describe("buildDigest", () => {
  it("makes one bounded model call per written part and cites real items only", async () => {
    const prompts: string[] = [];
    const complete: CompleteFn = async (prompt, maxTokens) => {
      prompts.push(prompt);
      expect(maxTokens).toBeLessThanOrEqual(600);
      return "- something happened [1]\n- invented [99]";
    };
    const result = await buildDigest(
      parseDigestRequest("digest this week", now, []),
      {
        itemsInPeriod: () => [
          item({ title: "Roche buys GPUs", entities: ["roche"], domains: ["ai"] }),
          item({ title: "NetApp launches array", entities: ["netapp"], domains: ["storage"] }),
        ],
        failingFeeds: () => [],
        watchlist,
        role: dellGam,
        complete,
        now: () => now,
      },
      3900,
    );
    // headline, accounts, infrastructure, actions
    expect(prompts).toHaveLength(4);
    expect(prompts[3]).toMatch(/Storage, Servers, Networking, Backup, End-user computing, Security/);
    expect(prompts[3]).toContain("Dell's portfolio");
    // Live: an invented "PowerEdge XE9700"; and bullets ran 40-60 words
    expect(prompts[3]).toMatch(/product families, never model numbers/);
    for (const prompt of prompts) expect(prompt).toMatch(/at most \d+ words/);
    expect(result.markdown).not.toContain("invented");
    expect(result.items).toBe(2);
  });

  it("still delivers the item lists when the model is down", async () => {
    const result = await buildDigest(
      parseDigestRequest("digest this week", now, []),
      {
        itemsInPeriod: () => [item({ title: "NetApp launches array", entities: ["netapp"], domains: ["storage"] })],
        failingFeeds: () => [],
        watchlist,
        role: dellGam,
        complete: async () => {
          throw new Error("stack down");
        },
        now: () => now,
      },
      3900,
    );
    expect(result.markdown).toContain("NetApp launches array");
    expect(result.markdown).not.toContain("**Action items**");
  });
});

describe("POST /api/digest", () => {
  it("defaults to the last 7 days within the Telegram budget", () => {
    expect(parseDigestCall({})).toEqual({ request: "digest of the last 7 days", budget: 3900 });
    expect(parseDigestCall({ request: "digest of last week", budget: 20_000 })).toEqual({ request: "digest of last week", budget: 20_000 });
  });

  it.each([{ request: 3 }, { budget: 10 }, { budget: 1.5 }, { budget: "big" }])("rejects %j", (body) => {
    expect("error" in parseDigestCall(body)).toBe(true);
  });

  it("returns the digest, or a 503 when building it failed", async () => {
    const ok = await digestResponse({ request: "last week" }, async (request) => ({ markdown: `digest for ${request}`, period: "p", items: 1 }));
    expect(ok).toEqual({ status: 200, body: { markdown: "digest for last week", period: "p", items: 1 } });
    const failed = await digestResponse({}, async () => {
      throw new Error("stack down");
    });
    expect(failed).toEqual({ status: 503, body: { error: "Digest failed: stack down" } });
  });
});

// The weekday briefing (Tue-Fri 07:30) replaced the 06:00 "news digest" job,
// which reported the retired news agent's "0 new articles" every morning
describe("buildDigest in briefing mode", () => {
  const deps = (items: StoredItem[], complete: CompleteFn) => ({
    itemsInPeriod: () => items,
    failingFeeds: () => [{ feedId: "veeva:rss:x", failures: 11 }],
    watchlist,
    role: dellGam,
    complete,
    now: () => now,
  });

  it("covers only the accounts and the action items, in two model calls", async () => {
    const prompts: string[] = [];
    const complete: CompleteFn = async (prompt) => {
      prompts.push(prompt);
      return "- Roche is buying GPUs [1]";
    };
    const result = await buildDigest(
      parseDigestRequest("yesterday", now, []),
      deps([item({ title: "Roche buys GPUs", entities: ["roche"], domains: ["ai"] }), item({ title: "NetApp launches array", domains: ["storage"] })], complete),
      3900,
      { briefing: true },
    );
    expect(prompts).toHaveLength(2);
    expect(result.markdown).toContain("**Briefing · yesterday** for GAM at Dell");
    expect(result.markdown).toContain("**Your accounts**");
    expect(result.markdown).toContain("**Action items**");
    expect(result.markdown).not.toContain("Infrastructure scene");
    expect(result.markdown).not.toContain("NetApp");
    // The weekly digest reports failing feeds; a daily note would repeat them every morning
    expect(result.markdown).not.toContain("veeva");
    expect(result.items).toBe(1);
  });

  // An empty stdout is how a Hermes script job stays silent
  it("is empty, with no model call, on a day with no news about the accounts", async () => {
    let calls = 0;
    const result = await buildDigest(
      parseDigestRequest("yesterday", now, []),
      deps([item({ title: "NetApp launches array", domains: ["storage"] })], async () => {
        calls++;
        return "";
      }),
      3900,
      { briefing: true },
    );
    expect(result).toEqual({ markdown: "", period: "yesterday", items: 0 });
    expect(calls).toBe(0);
  });
});

// Live on 2026-09-30: yesterday's only "Roche" item was a mis-tagged financial
// analyst story, and the model wrote six "No action; unrelated" bullets that
// would have gone to Telegram
describe("empty bullets and quiet briefings", () => {
  it("drops bullets that say there is nothing to do", () => {
    const reply = [
      "- **Storage** · Roche: No action; item [1] is unrelated to the company.",
      "- No relevant news found for Roche [1]",
      "- **Servers** · Roche: propose PowerEdge for the new AI lab [1]",
    ].join("\n");
    expect(parseBullets(reply, new Set([1]), 6)).toEqual(["**Servers** · Roche: propose PowerEdge for the new AI lab [1]"]);
  });

  const deps = (items: StoredItem[], reply: string) => ({
    itemsInPeriod: () => items,
    failingFeeds: () => [],
    watchlist,
    role: dellGam,
    complete: async () => reply,
    now: () => now,
  });

  it("stays silent when no action item survives", async () => {
    const result = await buildDigest(
      parseDigestRequest("yesterday", now, []),
      deps([item({ title: "Analyst named Roche", entities: ["roche"], importance: 2 })], "- **Storage** · Roche: No action; unrelated [1]"),
      3900,
      { briefing: true },
    );
    expect(result.markdown).toBe("");
  });

  it("leaves out importance-1 account items, where tagging noise lives", async () => {
    let calls = 0;
    const result = await buildDigest(
      parseDigestRequest("yesterday", now, []),
      { ...deps([item({ title: "minor Roche mention", entities: ["roche"], importance: 1 })], ""), complete: async () => { calls++; return ""; } },
      3900,
      { briefing: true },
    );
    expect(result.markdown).toBe("");
    expect(calls).toBe(0);
  });
});

// Since 2026-10-03 the watchlist follows the top 60 pharma / medtech customers,
// each with a headquarters theater and a size rank. With no role the digest
// covers all of them, so "Your accounts" is grouped by theater; within a
// theater, accounts take turns in size-rank order.
describe("accounts grouped by theater", () => {
  const ranked = (id: string, theater: "Americas" | "EMEA" | "APAC", rank: number) =>
    entity(id, "customer", { theater, size: { rank, year: 2025, basis: "FY2024 healthcare revenue" } });
  const world: Watchlist = {
    entities: new Map(
      [
        ranked("roche", "EMEA", 2),
        ranked("novartis", "EMEA", 7),
        ranked("sandoz", "EMEA", 39),
        ranked("jnj", "Americas", 1),
        ranked("pfizer", "Americas", 4),
        ranked("takeda", "APAC", 17),
        entity("netapp", "vendor", { name: "NetApp" }),
      ].map((e) => [e.id, e]),
    ),
    topics: [],
    priority: [],
    notes: [],
  };
  const about = (id: string, n: number, importance = 3) =>
    Array.from({ length: n }, (_, i) => item({ title: `${id} news ${i}`, entities: [id], domains: ["ai"], importance }));
  const weekly = parseDigestRequest("digest this week", now, []);

  it("reads a theater named in the request", () => {
    expect(parseDigestRequest("digest EMEA last week", now, []).theater).toBe("EMEA");
    expect(parseDigestRequest("briefing apac", now, []).theater).toBe("APAC");
    expect(parseDigestRequest("digest this week", now, []).theater).toBeNull();
  });

  it("groups accounts Americas, EMEA, APAC, size rank first within each, capped per theater", () => {
    // Watchlist order is not rank order: Sandoz (39) is listed before nothing, Roche (2) first
    const items = [...about("sandoz", 3), ...about("novartis", 3), ...about("roche", 3), ...about("pfizer", 2), ...about("jnj", 1), ...about("takeda", 6)];
    const selection = selectDigestItems(items, weekly, world, null);

    expect(selection.accountGroups.map((g) => g.theater)).toEqual(["Americas", "EMEA", "APAC"]);
    const titles = selection.accountGroups.map((g) => g.entries.map((e) => e.item.title));
    expect(titles[0]).toEqual(["jnj news 0", "pfizer news 0", "pfizer news 1"]);
    expect(titles[1]).toEqual(["roche news 0", "novartis news 0", "sandoz news 0", "roche news 1"]);
    expect(titles[2]).toHaveLength(4);
    // The flat section is the groups in order, numbered contiguously
    expect(selection.sections.accounts.map((e) => e.n)).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
  });

  it("does not group when the accounts sit in one theater", () => {
    const role: Role = { ...dellGam, accounts: ["Roche", "Novartis", "Sandoz"] };
    const selection = selectDigestItems([...about("roche", 5), ...about("novartis", 5)], weekly, world, role);
    expect(selection.accountGroups).toHaveLength(1);
    expect(selection.accountGroups[0].theater).toBeNull();
    expect(selection.accountGroups[0].entries).toHaveLength(8);
  });

  it("narrows the accounts to the theater the request names", () => {
    const selection = selectDigestItems([...about("roche", 2), ...about("jnj", 2)], parseDigestRequest("digest EMEA", now, []), world, null);
    expect(selection.accountIds).toEqual(["roche", "novartis", "sandoz"]);
    expect(selection.sections.accounts.map((e) => e.item.title)).toEqual(["roche news 0", "roche news 1"]);
    // Another theater's customer news does not slip into the market sections either
    expect(selection.numbered.map((e) => e.item.title)).not.toContain("jnj news 0");
  });

  it("keeps an item about customers in two theaters when one is the theater asked for, and vendor news", () => {
    const both = item({ title: "Roche and J&J pick NetApp", entities: ["roche", "jnj", "netapp"], domains: ["storage"] });
    const vendor = item({ title: "NetApp launches array", entities: ["netapp"], domains: ["storage"] });
    const selection = selectDigestItems([both, vendor], parseDigestRequest("digest EMEA", now, []), world, null);
    expect(selection.numbered.map((e) => e.item.title)).toEqual(["Roche and J&J pick NetApp", "NetApp launches array"]);
  });

  it("tells an item about accounts in two theaters once, in the first theater", () => {
    const both = item({ title: "J&J and Roche joint venture", entities: ["jnj", "roche"], domains: ["ai"] });
    const selection = selectDigestItems([both, ...about("takeda", 1)], weekly, world, null);
    expect(selection.accountGroups.map((g) => [g.theater, g.entries.map((e) => e.item.title)])).toEqual([
      ["Americas", ["J&J and Roche joint venture"]],
      ["APAC", ["takeda news 0"]],
    ]);
  });

  it("writes each theater in its own short call and renders it under its own heading", async () => {
    const prompts: string[] = [];
    const complete: CompleteFn = async (prompt) => {
      prompts.push(prompt);
      const n = Number(prompt.match(/\[(\d+)\]/)?.[1] ?? 1);
      return `- bullet a [${n}]\n- bullet b [${n}]\n- bullet c [${n}]\n- bullet d [${n}]`;
    };
    const result = await buildDigest(
      weekly,
      { itemsInPeriod: () => [...about("jnj", 2), ...about("roche", 2), ...about("takeda", 2)], failingFeeds: () => [], watchlist: world, role: null, complete, now: () => now },
      20_000,
    );
    // headline, three theaters, actions
    expect(prompts).toHaveLength(5);
    const md = result.markdown;
    const headings = ["**Your accounts · Americas**", "**Your accounts · EMEA**", "**Your accounts · APAC**"];
    for (const h of headings) expect(md).toContain(h);
    expect(md.indexOf(headings[0])).toBeLessThan(md.indexOf(headings[1]));
    expect(md.indexOf(headings[1])).toBeLessThan(md.indexOf(headings[2]));
    expect(md).not.toContain("**Your accounts**\n");
    // At most 3 bullets per theater in the weekly digest
    const emea = md.slice(md.indexOf(headings[1]), md.indexOf(headings[2]));
    expect(emea.match(/^- /gm)).toHaveLength(3);
  });

  it("keeps at least one bullet per theater and every action item under a tight budget", () => {
    const selection = selectDigestItems([...about("jnj", 4), ...about("roche", 4), ...about("takeda", 4)], weekly, world, null);
    const long = (n: number) => `${"word ".repeat(30)}[${n}]`;
    const [am, em, ap] = selection.accountGroups.map((g) => g.entries[0].n);
    const prose: DigestProse = {
      headline: [long(am), long(em)],
      accounts: [],
      byTheater: { Americas: [long(am), long(am), long(am)], EMEA: [long(em), long(em), long(em)], APAC: [long(ap), long(ap), long(ap)] },
      infrastructure: [],
      actions: Array.from({ length: 6 }, (_, i) => `**Line ${i}** · ${long(am)}`),
    };
    const opts = { period: "the last 7 days", role: null, now };
    // The roomy render is well over the budget, so the tight one had to give way
    expect(renderDigest(selection, prose, { failingFeeds: [] }, { ...opts, budget: 20_000 }).length).toBeGreaterThan(2500);
    const md = renderDigest(selection, prose, { failingFeeds: [] }, { ...opts, budget: 1800 });
    expect(md.length).toBeLessThanOrEqual(1800);
    for (const t of ["Americas", "EMEA", "APAC"]) expect(md).toContain(`**Your accounts · ${t}**`);
    for (let i = 0; i < 6; i++) expect(md).toContain(`**Line ${i}**`);
  });

  it("briefing: two bullets per theater at most, and a theater with only importance-1 news is left out", async () => {
    const prompts: string[] = [];
    const complete: CompleteFn = async (prompt) => {
      prompts.push(prompt);
      const n = Number(prompt.match(/\[(\d+)\]/)?.[1] ?? 1);
      return `- bullet a [${n}]\n- bullet b [${n}]\n- bullet c [${n}]`;
    };
    const result = await buildDigest(
      parseDigestRequest("yesterday", now, []),
      { itemsInPeriod: () => [...about("jnj", 3), ...about("roche", 3), ...about("takeda", 3, 1)], failingFeeds: () => [], watchlist: world, role: null, complete, now: () => now },
      3900,
      { briefing: true },
    );
    // Americas, EMEA, actions
    expect(prompts).toHaveLength(3);
    const md = result.markdown;
    expect(md).not.toContain("APAC");
    const am = md.slice(md.indexOf("**Your accounts · Americas**"), md.indexOf("**Your accounts · EMEA**"));
    expect(am.match(/^- /gm)).toHaveLength(2);
  });
});
