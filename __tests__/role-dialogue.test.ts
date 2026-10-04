import { afterEach, describe, expect, it } from "@jest/globals";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PORTFOLIO_LINES,
  isRoleCandidate,
  openRoleStore,
  parsePortfolio,
  roleSummary,
  rolePreamble,
  splitList,
  inferHomeTheater,
  effectiveHomeTheater,
  type Role,
  type RoleStore,
} from "../src/services/role-store.js";
import { roleMessageReply, roleStatus } from "../src/api/role.js";
import { activeRolePreamble, handleRoleMessage, parseRoleIntent, roleIntentPrompt, roleReplyFor, type RoleIntent } from "../src/services/role-dialogue.js";

// The user's role (who they are, which accounts, what they sell) frames every
// answer and every digest. It is set by chatting, never with a selector:
// naming a new role starts a short onboarding, naming a known one switches to
// it and shows its details, and "add Lonza to my accounts" edits it.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempStore(): { store: RoleStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "roles-"));
  dirs.push(dir);
  const path = join(dir, "roles.json");
  return { store: openRoleStore(path), path };
}

const dellGam: Role = {
  id: "dell-global-account-manager",
  title: "Global Account Manager",
  company: "Dell",
  accounts: ["Roche", "Novartis", "Sandoz"],
  portfolio: [...PORTFOLIO_LINES],
  focus: "",
  updatedAt: "2026-09-30T08:00:00.000Z",
};

const intent = (partial: Partial<RoleIntent>): RoleIntent => ({
  intent: "none",
  role: "",
  title: "",
  company: "",
  accountsAdd: [],
  accountsRemove: [],
  portfolioAdd: [],
  portfolioRemove: [],
  focus: "",
  homeTheater: "",
  ...partial,
});

// The model is only asked about free-form messages; onboarding answers never reach it
function extractor(result: RoleIntent | null) {
  const calls: string[] = [];
  const extract = async (text: string) => {
    calls.push(text);
    return result;
  };
  return { extract, calls };
}

const now = () => new Date("2026-09-30T09:00:00.000Z");

describe("parsing helpers", () => {
  it("splits a spoken list on commas and 'and'", () => {
    expect(splitList("Roche, Novartis and Sandoz")).toEqual(["Roche", "Novartis", "Sandoz"]);
    expect(splitList("roche; novartis & sandoz.")).toEqual(["roche", "novartis", "sandoz"]);
  });

  it("maps portfolio wording onto the six lines", () => {
    expect(parsePortfolio("storage and data protection")).toEqual(["storage", "backup"]);
    expect(parsePortfolio("servers, networking, PCs and laptops")).toEqual(["servers", "networking", "euc"]);
    expect(parsePortfolio("all of it")).toEqual([...PORTFOLIO_LINES]);
    expect(parsePortfolio("flowers")).toEqual([]);
  });

  it("recognises messages that may be about the role, and not ordinary questions", () => {
    for (const text of [
      "I am the Dell GAM for Roche, Novartis and Sandoz",
      "I'm now HLS principal at Everpure",
      "switch to my Everpure role",
      "add Lonza to my accounts",
      "I don't sell networking",
      "what is my role?",
    ]) {
      expect(isRoleCandidate(text, false)).toBe(true);
    }
    for (const text of ["What happened at Roche this week?", "Which ransomware groups target pharma?"]) {
      expect(isRoleCandidate(text, false)).toBe(false);
    }
    // While onboarding, every message is an answer
    expect(isRoleCandidate("Roche, Novartis", true)).toBe(true);
  });
});

describe("openRoleStore", () => {
  it("starts empty and persists roles, the active one and a draft, readable only by the user", () => {
    const { store, path } = tempStore();
    expect(store.read()).toEqual({ version: 1, active: null, roles: [], draft: null });

    store.write({ version: 1, active: dellGam.id, roles: [dellGam], draft: null });

    expect(openRoleStore(path).read().roles[0].company).toBe("Dell");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf-8")).active).toBe(dellGam.id);
  });
});

describe("roleSummary and rolePreamble", () => {
  it("shows the role's details and how to change them", () => {
    const text = roleSummary(dellGam);
    expect(text).toContain("Global Account Manager at Dell");
    expect(text).toContain("Roche, Novartis, Sandoz");
    expect(text).toContain("end-user computing");
    expect(text).toMatch(/add .* to my accounts/i);
  });

  it("tells the chat model who is asking and how to frame answers", () => {
    const preamble = rolePreamble({ ...dellGam, focus: "data-centre refresh" });
    expect(preamble).toContain("Global Account Manager at Dell");
    expect(preamble).toContain("Roche, Novartis, Sandoz");
    expect(preamble).toContain("data-centre refresh");
    expect(preamble).toMatch(/Dell's products/);
  });
});

describe("handleRoleMessage", () => {
  it("onboards a new role: asks each missing detail, then saves and activates it", async () => {
    const { store } = tempStore();
    const { extract, calls } = extractor(intent({ intent: "switch", title: "Global Account Manager", company: "Dell" }));
    const deps = { store, extract, now };

    const first = await handleRoleMessage("I am the Dell GAM", deps);
    expect(first).toMatch(/Which accounts do you cover/);

    const second = await handleRoleMessage("Roche, Novartis and Sandoz", deps);
    expect(second).toMatch(/Which lines do you sell/);

    const third = await handleRoleMessage("everything", deps);
    expect(third).toMatch(/focus/i);

    const done = await handleRoleMessage("skip", deps);
    expect(done).toContain("Global Account Manager at Dell");

    const state = store.read();
    expect(state.draft).toBeNull();
    expect(state.active).toBe("dell-global-account-manager");
    expect(state.roles[0]).toMatchObject({ accounts: ["Roche", "Novartis", "Sandoz"], portfolio: [...PORTFOLIO_LINES], focus: "" });
    // Only the first, free-form message went to the model
    expect(calls).toEqual(["I am the Dell GAM"]);
  });

  it("re-asks when an onboarding answer names no portfolio line", async () => {
    const { store } = tempStore();
    store.write({ version: 1, active: null, roles: [], draft: { title: "Principal", company: "Everpure", accounts: ["Roche"], portfolio: [], focus: null, asking: "portfolio" } });
    const reply = await handleRoleMessage("flowers", { store, extract: extractor(null).extract, now });
    expect(reply).toMatch(/storage, servers, networking, backup, end-user computing, security/);
    expect(store.read().draft?.asking).toBe("portfolio");
  });

  // Live on 2026-09-30: "I'm now HLS principal at Everpure" typed mid-onboarding
  // was stored as the answer to the pending question
  it("lets a new role statement break out of an open onboarding", async () => {
    const { store } = tempStore();
    store.write({ version: 1, active: null, roles: [], draft: { title: "", company: "Dell", accounts: [], portfolio: [], focus: null, asking: "title" } });
    const { extract, calls } = extractor(intent({ intent: "switch", title: "HLS Principal", company: "Everpure" }));

    const reply = await handleRoleMessage("I'm now HLS principal at Everpure", { store, extract, now });

    expect(calls).toEqual(["I'm now HLS principal at Everpure"]);
    expect(reply).toMatch(/New role at Everpure/);
    expect(store.read().draft).toMatchObject({ company: "Everpure", title: "HLS Principal", asking: "accounts" });
  });

  it("still takes a plain answer during onboarding as the answer", async () => {
    const { store } = tempStore();
    store.write({ version: 1, active: null, roles: [], draft: { title: "", company: "Dell", accounts: [], portfolio: [], focus: null, asking: "title" } });
    const { extract, calls } = extractor(null);
    await handleRoleMessage("Global Account Manager", { store, extract, now });
    expect(calls).toEqual([]);
    expect(store.read().draft).toMatchObject({ title: "Global Account Manager", asking: "accounts" });
  });

  // Live on 2026-10-02: "How should we approach novartis ?" typed mid-onboarding
  // was saved as the company, and the digests lost every account
  it.each(["How should we approach novartis ?", "what is Dell doing best for Roche", "Tell me about Lonza's storage"])(
    "lets the chat answer a question typed during onboarding and keeps the onboarding as it was: %s",
    async (question) => {
      const { store } = tempStore();
      const draft = { title: "HLS Principal", company: "", accounts: [], portfolio: [], focus: null, asking: "company" as const };
      store.write({ version: 1, active: null, roles: [], draft });
      const { extract, calls } = extractor(null);

      expect(await handleRoleMessage(question, { store, extract, now })).toBeNull();

      expect(calls).toEqual([]);
      // Nothing saved, nothing lost: the next plain answer still fills the company
      expect(store.read()).toMatchObject({ draft, roles: [], active: null });
      await handleRoleMessage("Everpure", { store, extract, now });
      expect(store.read().draft).toMatchObject({ title: "HLS Principal", company: "Everpure", asking: "accounts" });
    },
  );

  it.each([
    ["company", "Cancer Research UK"],
    ["title", "Director of IT"],
    ["accounts", "Roche, Novartis"],
    // The focus answer is free text: only a question mark makes it a question
    ["focus", "How we win storage at Novartis"],
    ["focus", "Do more storage deals"],
  ] as const)("still takes a plain %s answer during onboarding: %s", async (asking, answer) => {
    const { store } = tempStore();
    store.write({ version: 1, active: null, roles: [], draft: { title: "T", company: asking === "company" ? "" : "C", accounts: asking === "accounts" || asking === "title" || asking === "company" ? [] : ["Roche"], portfolio: asking === "focus" ? ["storage"] : [], focus: null, asking } });
    expect(await handleRoleMessage(answer, { store, extract: extractor(null).extract, now })).not.toBeNull();
  });

  it("still cancels on 'cancel?'", async () => {
    const { store } = tempStore();
    store.write({ version: 1, active: null, roles: [], draft: { title: "Principal", company: "Everpure", accounts: [], portfolio: [], focus: null, asking: "accounts" } });
    expect(await handleRoleMessage("cancel?", { store, extract: extractor(null).extract, now })).toMatch(/cancel/i);
    expect(store.read().draft).toBeNull();
  });

  it("drops the onboarding on cancel", async () => {
    const { store } = tempStore();
    store.write({ version: 1, active: null, roles: [], draft: { title: "Principal", company: "Everpure", accounts: [], portfolio: [], focus: null, asking: "accounts" } });
    expect(await handleRoleMessage("cancel", { store, extract: extractor(null).extract, now })).toMatch(/cancel/i);
    expect(store.read().draft).toBeNull();
  });

  it("switches to a known role and shows its details", async () => {
    const { store } = tempStore();
    const everpure: Role = { ...dellGam, id: "everpure-hls-principal", title: "HLS Principal", company: "Everpure", accounts: ["Roche", "Lonza"], portfolio: ["storage", "backup"] };
    store.write({ version: 1, active: everpure.id, roles: [dellGam, everpure], draft: null });

    const reply = await handleRoleMessage("switch to my Dell role", { store, extract: extractor(intent({ intent: "switch", role: "Dell", company: "Dell" })).extract, now });

    expect(reply).toMatch(/Switched to/);
    expect(reply).toContain("Roche, Novartis, Sandoz");
    expect(store.read().active).toBe(dellGam.id);
  });

  it("edits the active role by chatting and says what changed", async () => {
    const { store } = tempStore();
    store.write({ version: 1, active: dellGam.id, roles: [dellGam], draft: null });

    const reply = await handleRoleMessage("add Lonza to my accounts, I don't sell networking", {
      store,
      extract: extractor(intent({ intent: "update", accountsAdd: ["Lonza"], portfolioRemove: ["networking"] })).extract,
      now,
    });

    expect(reply).toMatch(/Lonza/);
    const role = store.read().roles[0];
    expect(role.accounts).toEqual(["Roche", "Novartis", "Sandoz", "Lonza"]);
    expect(role.portfolio).not.toContain("networking");
    expect(role.updatedAt).toBe("2026-09-30T09:00:00.000Z");
  });

  it("shows the active role when asked", async () => {
    const { store } = tempStore();
    store.write({ version: 1, active: dellGam.id, roles: [dellGam], draft: null });
    const reply = await handleRoleMessage("what is my role?", { store, extract: extractor(intent({ intent: "show" })).extract, now });
    expect(reply).toContain("Global Account Manager at Dell");
  });

  // A false keyword match must fall through to the normal chat untouched
  it("returns null for a message that is not about the role", async () => {
    const { store } = tempStore();
    expect(await handleRoleMessage("I'm looking for Roche news", { store, extract: extractor(intent({ intent: "none" })).extract, now })).toBeNull();
    expect(await handleRoleMessage("I'm looking for Roche news", { store, extract: extractor(null).extract, now })).toBeNull();
  });
});

describe("parseRoleIntent", () => {
  it("reads the model's JSON and keeps only the six portfolio lines", () => {
    const parsed = parseRoleIntent(
      'Sure: {"intent":"update","role":"","title":"","company":"","accounts_add":["Lonza"],"accounts_remove":[],"portfolio_add":["storage","flowers"],"portfolio_remove":[],"focus":""}',
    );
    expect(parsed).toMatchObject({ intent: "update", accountsAdd: ["Lonza"], portfolioAdd: ["storage"] });
  });

  it.each(["no json here", '{"intent":"dance"}', "{broken"])("returns null for %s", (text) => {
    expect(parseRoleIntent(text)).toBeNull();
  });

  it("gives the model the known roles to match against", () => {
    expect(roleIntentPrompt("switch to Dell", [dellGam])).toContain("Global Account Manager at Dell");
  });

  // Live: "I am the Dell GAM" came back with no title
  it("tells the model an abbreviation like GAM is a title", () => {
    expect(roleIntentPrompt("I work at Dell", [])).toMatch(/"GAM"/);
  });
});

describe("chat entry points", () => {
  it("never routes benchmark requests to the role conversation or adds a preamble", async () => {
    const { store } = tempStore();
    store.write({ version: 1, active: dellGam.id, roles: [dellGam], draft: null });
    const { extract, calls } = extractor(intent({ intent: "show" }));
    expect(await roleReplyFor("what is my role?", { benchmark: true, store, extract, now })).toBeNull();
    expect(calls).toEqual([]);
    expect(activeRolePreamble({ benchmark: true, store })).toBe("");
    expect(activeRolePreamble({ benchmark: false, store })).toContain("Global Account Manager at Dell");
  });

  // An ordinary question must not cost a model call
  it("asks the model nothing for a message that cannot be about the role", async () => {
    const { store } = tempStore();
    const { extract, calls } = extractor(intent({ intent: "switch" }));
    expect(await roleReplyFor("Which ransomware groups target pharma?", { benchmark: false, store, extract, now })).toBeNull();
    expect(calls).toEqual([]);
  });

  it("has no preamble when no role is active", () => {
    expect(activeRolePreamble({ benchmark: false, store: tempStore().store })).toBe("");
  });
});

describe("/api/role (Hermes)", () => {
  it("reports the active role, the saved ones and whether an onboarding is open", () => {
    expect(roleStatus({ version: 1, active: dellGam.id, roles: [dellGam], draft: null })).toEqual({
      active: dellGam,
      roles: [dellGam],
      onboarding: false,
    });
  });

  it("answers a role turn, and hints instead of staying silent when the message is not about the role", async () => {
    const { store } = tempStore();
    store.write({ version: 1, active: dellGam.id, roles: [dellGam], draft: null });
    const shown = await roleMessageReply("what is my role?", { store, extract: extractor(intent({ intent: "show" })).extract, now });
    expect(shown.status).toBe(200);
    expect(JSON.stringify(shown.body)).toContain("Global Account Manager at Dell");

    const other = await roleMessageReply("what happened at Roche?", { store, extract: extractor(intent({ intent: "none" })).extract, now });
    expect(JSON.stringify(other.body)).toMatch(/did not read as a change to your role/);

    expect((await roleMessageReply("  ", { store, extract: extractor(null).extract, now })).status).toBe(400);
  });
});

// Home theater (2026-10-04): a seller paid on every deal whose strategic influence
// sits with the customers headquartered in one theater. The digest leads with it.
describe("home theater", () => {
  const everpure: Role = {
    id: "everpure-hls-principal-emea",
    title: "HLS Principal, EMEA",
    company: "Everpure",
    accounts: ["Roche", "Pfizer"],
    portfolio: ["storage", "backup"],
    focus: "",
    homeTheater: "EMEA",
    updatedAt: "2026-10-04T08:00:00.000Z",
  };

  it("is inferred from a title that names a theater", () => {
    expect(inferHomeTheater("HLS Principal, EMEA")).toBe("EMEA");
    expect(inferHomeTheater("GAM Americas")).toBe("Americas");
    expect(inferHomeTheater("apac sales lead")).toBe("APAC");
    expect(inferHomeTheater("Global Account Manager")).toBeUndefined();
  });

  it("shows in the role summary and tells the chat model to lead with it", () => {
    expect(roleSummary(everpure)).toContain("- Home theater: EMEA");
    expect(roleSummary(dellGam)).not.toContain("Home theater");
    expect(rolePreamble(everpure)).toContain("headquartered in EMEA");
    expect(rolePreamble(dellGam)).not.toContain("headquartered");
  });

  it("is set from the title when an onboarding finishes", async () => {
    const { store } = tempStore();
    store.write({ version: 1, active: null, roles: [], draft: { title: "HLS Principal, EMEA", company: "Everpure", accounts: ["Roche"], portfolio: ["storage"], focus: null, asking: "focus" } });
    await handleRoleMessage("skip", { store, extract: extractor(null).extract, now });
    expect(store.read().roles[0].homeTheater).toBe("EMEA");
  });

  it("is changed by chatting, and read from the model's JSON only when it is a theater", async () => {
    const { store } = tempStore();
    store.write({ version: 1, active: dellGam.id, roles: [dellGam], draft: null });
    const reply = await handleRoleMessage("my home theater is EMEA", {
      store,
      extract: extractor(intent({ intent: "update", homeTheater: "EMEA" })).extract,
      now,
    });
    expect(reply).toMatch(/home theater set to EMEA/);
    expect(store.read().roles[0].homeTheater).toBe("EMEA");
    expect(parseRoleIntent('{"intent":"update","home_theater":"EMEA"}')?.homeTheater).toBe("EMEA");
    expect(parseRoleIntent('{"intent":"update","home_theater":"Europe"}')?.homeTheater).toBe("");
    expect(roleIntentPrompt("x", [])).toContain('"home_theater"');
    // Only keyword-matched messages reach the role engine in the chat
    expect(isRoleCandidate("my home theater is EMEA", false)).toBe(true);
  });

  // Review: the live role (saved before this field existed) has no homeTheater
  it("falls back to the title for a role saved without one", () => {
    const old: Role = { ...everpure, homeTheater: undefined };
    expect(effectiveHomeTheater(old)).toBe("EMEA");
    expect(roleSummary(old)).toContain("- Home theater: EMEA");
    expect(rolePreamble(old)).toContain("headquartered in EMEA");
    expect(effectiveHomeTheater(dellGam)).toBeUndefined();
  });

  it("tells the model a home-theater message is an update, and accepts British spelling", () => {
    expect(roleIntentPrompt("x", [])).toMatch(/"update": they change the accounts, portfolio, focus or home theater/);
    expect(isRoleCandidate("my home theatre is EMEA", false)).toBe(true);
  });

  it("ignores a theater the model offers when the message does not mention one", async () => {
    const { store } = tempStore();
    store.write({ version: 1, active: dellGam.id, roles: [dellGam], draft: null });
    await handleRoleMessage("add Lonza to my accounts", {
      store,
      extract: extractor(intent({ intent: "update", accountsAdd: ["Lonza"], homeTheater: "EMEA" })).extract,
      now,
    });
    expect(store.read().roles[0].homeTheater).toBeUndefined();
    expect(store.read().roles[0].accounts).toContain("Lonza");
  });

  it("keeps a theater stated while starting a new role, and when switching to a known one", async () => {
    const { store } = tempStore();
    const extract = extractor(intent({ intent: "switch", title: "GAM", company: "Dell", homeTheater: "EMEA" })).extract;
    await handleRoleMessage("I am the Dell GAM, my home theater is EMEA", { store, extract, now });
    expect(store.read().draft).toMatchObject({ homeTheater: "EMEA" });
    for (const answer of ["Roche", "storage", "skip"]) await handleRoleMessage(answer, { store, extract: extractor(null).extract, now });
    expect(store.read().roles[0]).toMatchObject({ title: "GAM", homeTheater: "EMEA" });

    const other = tempStore().store;
    other.write({ version: 1, active: null, roles: [dellGam], draft: null });
    await handleRoleMessage("switch to my Dell GAM role, home theater APAC", {
      store: other,
      extract: extractor(intent({ intent: "switch", role: "Dell GAM", company: "Dell", homeTheater: "APAC" })).extract,
      now,
    });
    expect(other.read().roles[0]).toMatchObject({ id: dellGam.id, homeTheater: "APAC" });
  });

  it("re-onboarding the same role keeps a theater set earlier by chat", async () => {
    const { store } = tempStore();
    const set: Role = { ...dellGam, homeTheater: "EMEA" };
    store.write({ version: 1, active: set.id, roles: [set], draft: { title: dellGam.title, company: "Dell", accounts: ["Roche"], portfolio: ["storage"], focus: null, asking: "focus" } });
    await handleRoleMessage("skip", { store, extract: extractor(null).extract, now });
    expect(store.read().roles.find((r) => r.id === dellGam.id)?.homeTheater).toBe("EMEA");
  });
});
