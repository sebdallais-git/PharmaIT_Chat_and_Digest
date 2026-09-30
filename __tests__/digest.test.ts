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
