import { describe, expect, it } from "@jest/globals";
import Database from "better-sqlite3";
import {
  checkCanary,
  createChatAsker,
  DEFAULT_CANARY_CONFIG,
  formatFailureSummary,
  loadCanaries,
  openCanaryStore,
  parseCanaryConfig,
  runCanaries,
  summarizeCanaryRuns,
  type Canary,
  type CanaryRun,
  type ChatReply,
} from "../src/services/kb-canary.js";

// The KB monitor asks a handful of questions whose answers the knowledge base
// is known to hold, and checks the answers for the facts by plain string
// matching. It replaced the n8n "KB health monitor" (2026-09-29), which sent no
// API token, parsed the SSE chat stream as JSON, had the 27B grade answers 0-10
// with an unmeasured rubric, and ran its chats through gap detection.

const merck: Canary = {
  id: "merck-notpetya",
  question: "Which malware hit Merck in 2017, and what did the attack cost?",
  expect: [["NotPetya"], ["1.4 billion", "1.4B"]],
};

const reply = (answer: string, chunkCount = 5): ChatReply => ({ answer, chunkCount });

describe("parseCanaryConfig", () => {
  it("reads canaries with groups of alternative terms", () => {
    const canaries = parseCanaryConfig({
      canaries: [{ id: "a", question: "Q?", expect: [["NotPetya"], ["1.4 billion", "1.4B"]] }],
    });
    expect(canaries).toEqual([{ id: "a", question: "Q?", expect: [["NotPetya"], ["1.4 billion", "1.4B"]] }]);
  });

  it("accepts a single string as a group of one", () => {
    expect(parseCanaryConfig({ canaries: [{ id: "a", question: "Q?", expect: ["Winnti"] }] })[0].expect).toEqual([["Winnti"]]);
  });

  it.each([
    ["no canaries list", {}],
    ["an empty list", { canaries: [] }],
    ["a missing question", { canaries: [{ id: "a", expect: ["x"] }] }],
    ["no expected terms", { canaries: [{ id: "a", question: "Q?", expect: [] }] }],
    ["an empty term", { canaries: [{ id: "a", question: "Q?", expect: [[""]] }] }],
    ["a duplicate id", { canaries: [{ id: "a", question: "Q?", expect: ["x"] }, { id: "a", question: "R?", expect: ["y"] }] }],
  ])("rejects %s", (_label, raw) => {
    expect(() => parseCanaryConfig(raw)).toThrow(/kb canaries/);
  });
});

describe("config/kb-canaries.yaml", () => {
  // A typo here would only surface as a 05:00 failure message
  it("parses, with a question and expected terms for every canary", () => {
    const canaries = loadCanaries(DEFAULT_CANARY_CONFIG);
    expect(canaries.length).toBeGreaterThanOrEqual(5);
    expect(canaries.map((c) => c.id)).toContain("roche-kaiseraugst-mes");
  });
});

describe("checkCanary", () => {
  it("passes when every group has a term in the answer, ignoring case", () => {
    const result = checkCanary(merck, reply("It was notpetya; the cost was $1.4B in total."), 1200);
    expect(result).toMatchObject({ id: "merck-notpetya", ok: true, missing: [], chunkCount: 5, ms: 1200 });
  });

  it("names the first term of each group that is missing", () => {
    expect(checkCanary(merck, reply("NotPetya cost an undisclosed amount."), 0).missing).toEqual(["1.4 billion"]);
  });

  // An answer from general knowledge with nothing retrieved means the index,
  // not the model, is what broke
  it("fails when no chunk was retrieved, even if the answer has the facts", () => {
    expect(checkCanary(merck, reply("NotPetya, $1.4 billion", 0), 0)).toMatchObject({ ok: false, chunkCount: 0 });
  });

  it("fails on a chat error", () => {
    expect(checkCanary(merck, { answer: "", chunkCount: 0, error: "HTTP 401" }, 0)).toMatchObject({ ok: false, error: "HTTP 401" });
  });
});

describe("runCanaries", () => {
  const winnti: Canary = { id: "bayer-winnti", question: "Which APT group compromised Bayer?", expect: [["Winnti"]] };

  it("asks each question in order and counts the passes", async () => {
    const asked: string[] = [];
    const run = await runCanaries([merck, winnti], async (q) => {
      asked.push(q);
      return q === merck.question ? reply("NotPetya, 1.4 billion") : reply("Lazarus");
    }, () => new Date("2026-09-30T03:00:00Z"));
    // winnti failed once and was asked again
    expect(asked).toEqual([merck.question, winnti.question, winnti.question]);
    expect(run).toMatchObject({ timestamp: "2026-09-30T03:00:00.000Z", passed: 1, total: 2 });
    expect(run.results[1]).toMatchObject({ id: "bayer-winnti", ok: false, missing: ["Winnti"], retried: true });
  });

  // Local generation varies; one odd answer must not page anyone
  it("counts a canary that passes on its retry as passed", async () => {
    let calls = 0;
    const run = await runCanaries([winnti], async () => (++calls === 1 ? reply("unknown") : reply("Winnti")));
    expect(run.passed).toBe(1);
    expect(run.results[0]).toMatchObject({ ok: true, retried: true });
  });

  it("records a thrown chat call as that canary's error and carries on", async () => {
    const run = await runCanaries([merck, winnti], async (q) => {
      if (q === merck.question) throw new Error("connect ECONNREFUSED");
      return reply("Winnti");
    });
    expect(run.results[0]).toMatchObject({ ok: false, error: "connect ECONNREFUSED" });
    expect(run.passed).toBe(1);
  });
});

describe("formatFailureSummary", () => {
  it("says nothing when every canary passed", async () => {
    const run = await runCanaries([merck], async () => reply("NotPetya 1.4B"));
    expect(formatFailureSummary(run)).toBe("");
  });

  it("lists each failed canary with what was missing, the chunk count or the error", async () => {
    const winnti: Canary = { id: "bayer-winnti", question: "Q?", expect: [["Winnti"]] };
    const mes: Canary = { id: "roche-mes", question: "R?", expect: [["Rockwell"]] };
    const run = await runCanaries([merck, winnti, mes], async (q) => {
      if (q === "Q?") return reply("Lazarus", 0);
      if (q === "R?") return { answer: "", chunkCount: 0, error: "HTTP 500" };
      return reply("NotPetya 1.4B");
    });
    expect(formatFailureSummary(run)).toBe(
      [
        "KB canary: 1/3 passed",
        "- bayer-winnti: missing Winnti (0 chunks)",
        "- roche-mes: HTTP 500",
      ].join("\n"),
    );
  });

  // App down at 05:00: one line, not one per canary
  it("says it once when every canary failed with the same error", async () => {
    const winnti: Canary = { id: "bayer-winnti", question: "Q?", expect: [["Winnti"]] };
    const run = await runCanaries([merck, winnti], async () => {
      throw new Error("fetch failed");
    });
    expect(formatFailureSummary(run)).toBe("KB canary: 0/2 passed, every question failed with: fetch failed");
  });
});

describe("createChatAsker", () => {
  const sse = (...events: object[]): string => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

  it("posts a benchmark chat with the token and reads the streamed answer and chunk ids", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const ask = createChatAsker("http://app", "secret", async (url, init) => {
      seen.push({ url: String(url), init: init ?? {} });
      return new Response(sse({ token: "Not" }, { token: "Petya" }, { done: true, chunkIds: ["a", "b"] }));
    });

    expect(await ask("Q?")).toEqual({ answer: "NotPetya", chunkCount: 2 });
    expect(seen[0].url).toBe("http://app/api/chat");
    // benchmark: no gap detection, no request logging, no detection shadow row
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ message: "Q?", benchmark: true });
    expect((seen[0].init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
  });

  it("sends no Authorization header when no token is configured", async () => {
    let headers: Record<string, string> = {};
    const ask = createChatAsker("http://app", null, async (_url, init) => {
      headers = init?.headers as Record<string, string>;
      return new Response(sse({ done: true, chunkIds: [] }));
    });
    await ask("Q?");
    expect(headers.Authorization).toBeUndefined();
  });

  it.each([
    ["an HTTP error", () => new Response("no", { status: 401 }), "HTTP 401"],
    ["a streamed error", () => new Response(sse({ token: "x" }, { error: "stack down" })), "stack down"],
    ["a stream without a done event", () => new Response(sse({ token: "x" })), "stream ended without a done event"],
  ])("reports %s", async (_label, respond, error) => {
    const ask = createChatAsker("http://app", null, async () => respond());
    expect(await ask("Q?")).toMatchObject({ chunkCount: 0, error });
  });
});

describe("summarizeCanaryRuns", () => {
  const at = (iso: string, passed: number, total = 2): CanaryRun => ({ timestamp: iso, passed, total, results: [] });
  const now = new Date("2026-10-01T12:00:00Z");

  it("reports never-run when there is no run yet", () => {
    expect(summarizeCanaryRuns([], now)).toEqual({ status: "never-run", latest: null, history: [] });
  });

  it("is ok when the newest run passed everything, failing when it did not", () => {
    expect(summarizeCanaryRuns([at("2026-10-01T03:00:00Z", 2), at("2026-09-30T03:00:00Z", 1)], now).status).toBe("ok");
    expect(summarizeCanaryRuns([at("2026-10-01T03:00:00Z", 1)], now).status).toBe("failing");
  });

  // A job that silently stopped running must not look like a healthy KB
  it("is stale when the newest run is more than 36 hours old", () => {
    expect(summarizeCanaryRuns([at("2026-09-29T23:00:00Z", 2)], now).status).toBe("stale");
  });

  it("keeps the newest run whole and the history as pass counts", () => {
    const summary = summarizeCanaryRuns([at("2026-10-01T03:00:00Z", 2), at("2026-09-30T03:00:00Z", 1)], now);
    expect(summary.latest?.timestamp).toBe("2026-10-01T03:00:00Z");
    expect(summary.history).toEqual([
      { timestamp: "2026-10-01T03:00:00Z", passed: 2, total: 2 },
      { timestamp: "2026-09-30T03:00:00Z", passed: 1, total: 2 },
    ]);
  });
});

describe("openCanaryStore", () => {
  it("keeps runs newest first with their per-canary results", async () => {
    const store = openCanaryStore(new Database(":memory:"));
    const first = await runCanaries([merck], async () => reply("NotPetya 1.4B"), () => new Date("2026-09-30T03:00:00Z"));
    const second = await runCanaries([merck], async () => reply("no idea"), () => new Date("2026-10-01T03:00:00Z"));
    store.record(first);
    store.record(second);

    const runs = store.list(10);
    expect(runs.map((r) => [r.timestamp, r.passed, r.total])).toEqual([
      ["2026-10-01T03:00:00.000Z", 0, 1],
      ["2026-09-30T03:00:00.000Z", 1, 1],
    ]);
    expect(runs[0].results[0]).toMatchObject({ id: "merck-notpetya", ok: false });
    expect(store.list(1)).toHaveLength(1);
    store.close();
  });
});
