// The role conversation, the same in the web chat and Telegram.
//
// Naming a new role starts a short onboarding that asks for each missing
// detail; naming a known role switches to it and shows its details; "add Lonza
// to my accounts" edits the active role. The model only reads free-form
// messages into validated changes (parseRoleIntent). Answers during onboarding
// are parsed without it, and the engine alone decides what happens next.

import { getLlmClient } from "./llm-client.js";
import {
  PORTFOLIO_LINES,
  activeRole,
  isRoleCandidate,
  parsePortfolio,
  portfolioText,
  roleId,
  roleLabel,
  rolePreamble,
  roleSummary,
  splitList,
  type DraftField,
  type PortfolioLine,
  type Role,
  type RoleDraft,
  type RoleState,
  type RoleStore,
} from "./role-store.js";

export interface RoleIntent {
  intent: "switch" | "update" | "show" | "none";
  // How the user named the role, for matching a saved one
  role: string;
  title: string;
  company: string;
  accountsAdd: string[];
  accountsRemove: string[];
  portfolioAdd: PortfolioLine[];
  portfolioRemove: PortfolioLine[];
  focus: string;
}

export interface RoleDeps {
  store: RoleStore;
  extract(text: string, known: Role[]): Promise<RoleIntent | null>;
  now(): Date;
}

const INTENTS = ["switch", "update", "show", "none"] as const;

// A question typed while onboarding is waiting for an answer is a question,
// not the answer: on 2026-10-02 "How should we approach novartis ?" became the
// company of a saved role.
const QUESTION = /\?\s*$|^\s*(how|what|why|which|who|when|where|should|could|can|would|is|are|do|does|tell me|show me|give me)\b/i;

const NEW_ROLE_STATEMENT = /\b(i am now|i'm now|switch (to|role)|act as|(i am|i'm) (the |a |an )?[\w\s/&-]{0,40}\b(at|for|from) \w)/i;

export function roleIntentPrompt(text: string, known: Role[]): string {
  const roles = known.length > 0 ? known.map((r) => `- ${roleLabel(r)}`).join("\n") : "- (none yet)";
  return `A salesperson is talking to their assistant. Read their message and decide whether it is about their own job role.

Known roles:
${roles}

Message: ${text}

Return ONLY a JSON object:
{"intent": "switch" | "update" | "show" | "none", "role": "", "title": "", "company": "", "accounts_add": [], "accounts_remove": [], "portfolio_add": [], "portfolio_remove": [], "focus": ""}

- "switch": they say who they are, or ask to switch to or act as a role. Fill "role" with how they named it, and title/company/accounts_add/portfolio_add/focus with whatever they stated.
- "update": they change the accounts, portfolio or focus of their current role.
- "show": they ask what their current role is.
- "none": anything else, including ordinary questions that merely mention a company.
- portfolio values only from: ${PORTFOLIO_LINES.join(", ")} ("euc" is end-user computing: PCs, laptops, workplace).
- "title" is their job title as stated; abbreviations count: "GAM" (Global Account Manager), "AE", "HLS principal", "CSM".
- Leave a field empty when the message does not state it. Never guess.`;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()) : [];
}

function lines(value: unknown): PortfolioLine[] {
  const known = new Set<string>(PORTFOLIO_LINES);
  return stringArray(value).map((v) => v.toLowerCase()).filter((v): v is PortfolioLine => known.has(v));
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseRoleIntent(reply: string): RoleIntent | null {
  const match = reply.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const intent = INTENTS.find((i) => i === r.intent);
  if (!intent) return null;
  return {
    intent,
    role: text(r.role),
    title: text(r.title),
    company: text(r.company),
    accountsAdd: stringArray(r.accounts_add),
    accountsRemove: stringArray(r.accounts_remove),
    portfolioAdd: lines(r.portfolio_add),
    portfolioRemove: lines(r.portfolio_remove),
    focus: text(r.focus),
  };
}

export const defaultExtract: RoleDeps["extract"] = async (message, known) => {
  try {
    const reply = await getLlmClient().chat([{ role: "user", content: roleIntentPrompt(message, known) }], { temperature: 0.1 });
    return parseRoleIntent(reply);
  } catch {
    return null;
  }
};

const QUESTIONS: Record<DraftField, string> = {
  title: "What's your title (e.g. Global Account Manager)?",
  company: "Which company do you work for?",
  accounts: "Which accounts do you cover? List them, e.g. \"Roche, Novartis and Sandoz\".",
  portfolio: `Which lines do you sell? Any of: ${portfolioText(PORTFOLIO_LINES)}, or "all".`,
  focus: 'Anything to focus on right now (e.g. "data-centre refresh at Novartis")? Say "skip" for none.',
};

function nextMissing(draft: RoleDraft): DraftField | null {
  if (!draft.title) return "title";
  if (!draft.company) return "company";
  if (draft.accounts.length === 0) return "accounts";
  if (draft.portfolio.length === 0) return "portfolio";
  if (draft.focus === null) return "focus";
  return null;
}

function mergeNames(current: string[], add: string[], remove: string[] = []): string[] {
  const drop = new Set(remove.map((n) => n.toLowerCase()));
  const out = current.filter((n) => !drop.has(n.toLowerCase()));
  for (const name of add) {
    if (!out.some((n) => n.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out;
}

function mergeLines(current: PortfolioLine[], add: PortfolioLine[], remove: PortfolioLine[] = []): PortfolioLine[] {
  const set = new Set([...current, ...add].filter((l) => !remove.includes(l)));
  return PORTFOLIO_LINES.filter((l) => set.has(l));
}

// Saves a complete draft as a role (replacing one with the same id) and activates it
function finishDraft(state: RoleState, draft: RoleDraft, now: Date): { state: RoleState; role: Role } {
  const role: Role = {
    id: roleId(draft.title, draft.company),
    title: draft.title,
    company: draft.company,
    accounts: draft.accounts,
    portfolio: draft.portfolio,
    focus: draft.focus ?? "",
    updatedAt: now.toISOString(),
  };
  const roles = [...state.roles.filter((r) => r.id !== role.id), role];
  return { state: { ...state, roles, active: role.id, draft: null }, role };
}

function continueDraft(store: RoleStore, state: RoleState, draft: RoleDraft, now: Date, lead = ""): string {
  const missing = nextMissing(draft);
  if (missing === null) {
    const done = finishDraft(state, draft, now);
    store.write(done.state);
    return `${lead}Saved and active:\n\n${roleSummary(done.role)}`;
  }
  store.write({ ...state, draft: { ...draft, asking: missing } });
  return `${lead}${QUESTIONS[missing]}`;
}

function answerDraft(store: RoleStore, state: RoleState, draft: RoleDraft, message: string, now: Date): string {
  if (/^\s*(cancel|stop|abort|never ?mind)\b/i.test(message)) {
    store.write({ ...state, draft: null });
    return "Cancelled: the new role was not saved.";
  }
  const answer = message.trim();
  const next = { ...draft };
  switch (draft.asking) {
    case "title":
      next.title = answer;
      break;
    case "company":
      next.company = answer;
      break;
    case "accounts":
      next.accounts = mergeNames(draft.accounts, splitList(answer));
      break;
    case "portfolio": {
      const parsed = parsePortfolio(answer);
      if (parsed.length === 0) return `I didn't recognise a line there. ${QUESTIONS.portfolio}`;
      next.portfolio = parsed;
      break;
    }
    case "focus":
      next.focus = /^(skip|none|no|nothing|n\/a)\b/i.test(answer) ? "" : answer;
      break;
  }
  return continueDraft(store, state, next, now);
}

// Matches how the user named a role against the saved ones; null when none or ambiguous
function findRole(roles: Role[], intent: RoleIntent): Role | null {
  const words = `${intent.role} ${intent.company} ${intent.title}`.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  if (words.length === 0) return null;
  const scored = roles
    .map((role) => {
      const hay = `${role.company} ${role.title} ${role.id}`.toLowerCase();
      return { role, score: words.filter((w) => hay.includes(w)).length };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0 || (scored.length > 1 && scored[0].score === scored[1].score)) return null;
  return scored[0].role;
}

function describeChanges(before: Role, after: Role): string[] {
  const changes: string[] = [];
  const added = after.accounts.filter((a) => !before.accounts.includes(a));
  const removed = before.accounts.filter((a) => !after.accounts.includes(a));
  if (added.length) changes.push(`added account${added.length > 1 ? "s" : ""} ${added.join(", ")}`);
  if (removed.length) changes.push(`removed account${removed.length > 1 ? "s" : ""} ${removed.join(", ")}`);
  const linesAdded = after.portfolio.filter((l) => !before.portfolio.includes(l));
  const linesRemoved = before.portfolio.filter((l) => !after.portfolio.includes(l));
  if (linesAdded.length) changes.push(`now selling ${portfolioText(linesAdded)}`);
  if (linesRemoved.length) changes.push(`no longer selling ${portfolioText(linesRemoved)}`);
  if (after.focus !== before.focus) changes.push(`focus set to "${after.focus}"`);
  return changes;
}

/**
 * Handles a message about the user's role and returns the reply, or null when
 * the message is not about the role (the caller then answers it normally).
 */
export async function handleRoleMessage(message: string, deps: RoleDeps): Promise<string | null> {
  let state = deps.store.read();
  const now = deps.now();
  let intent: RoleIntent | null = null;
  if (state.draft) {
    // A message that plainly names a role ("I'm now HLS principal at Everpure")
    // starts over instead of being stored as the pending answer
    if (!NEW_ROLE_STATEMENT.test(message)) {
      if (QUESTION.test(message)) {
        // Drop the onboarding and let the chat answer the question normally
        deps.store.write({ ...state, draft: null });
        return null;
      }
      return answerDraft(deps.store, state, state.draft, message, now);
    }
    intent = await deps.extract(message, state.roles);
    if (!intent || intent.intent !== "switch") return answerDraft(deps.store, state, state.draft, message, now);
    state = { ...state, draft: null };
  }

  intent ??= await deps.extract(message, state.roles);
  if (!intent || intent.intent === "none") return null;
  const current = activeRole(state);

  if (intent.intent === "show") {
    return current
      ? `Your active role:\n\n${roleSummary(current)}`
      : 'No role is set yet. Tell me who you are, e.g. "I am the Dell GAM for Roche, Novartis and Sandoz".';
  }

  if (intent.intent === "update" && current) {
    const updated: Role = {
      ...current,
      accounts: mergeNames(current.accounts, intent.accountsAdd, intent.accountsRemove),
      portfolio: mergeLines(current.portfolio, intent.portfolioAdd, intent.portfolioRemove),
      focus: intent.focus || current.focus,
      updatedAt: now.toISOString(),
    };
    const changes = describeChanges(current, updated);
    if (changes.length === 0) return `I didn't find a change to make.\n\n${roleSummary(current)}`;
    deps.store.write({ ...state, roles: state.roles.map((r) => (r.id === current.id ? updated : r)) });
    return `Updated: ${changes.join("; ")}.\n\n${roleSummary(updated)}`;
  }

  // "switch" (or an update with no role yet): a known role, or onboarding a new one
  const known = findRole(state.roles, intent);
  if (known) {
    deps.store.write({ ...state, active: known.id });
    return `Switched to your role as ${roleLabel(known)}:\n\n${roleSummary(known)}`;
  }
  const draft: RoleDraft = {
    title: intent.title,
    company: intent.company,
    accounts: mergeNames([], intent.accountsAdd),
    portfolio: mergeLines([], intent.portfolioAdd),
    focus: intent.focus || null,
    asking: "title",
  };
  const lead = draft.company ? `New role at ${draft.company}. ` : "New role. ";
  return continueDraft(deps.store, state, draft, now, lead);
}

export interface ChatRoleOptions {
  benchmark: boolean;
  store: RoleStore;
  extract?: RoleDeps["extract"];
  now?: () => Date;
}

/**
 * The chat's entry point: the role conversation's reply, or null to answer the
 * message normally. Benchmark requests (stack benchmarks, KB canaries) never
 * enter it, so their answers stay comparable whatever role is active.
 */
export async function roleReplyFor(message: string, options: ChatRoleOptions): Promise<string | null> {
  if (options.benchmark) return null;
  const state = options.store.read();
  if (!isRoleCandidate(message, state.draft !== null)) return null;
  return handleRoleMessage(message, {
    store: options.store,
    extract: options.extract ?? defaultExtract,
    now: options.now ?? (() => new Date()),
  });
}

/** The active role's system-prompt preamble, or "" (none active, or a benchmark request). */
export function activeRolePreamble(options: Pick<ChatRoleOptions, "benchmark" | "store">): string {
  if (options.benchmark) return "";
  const role = activeRole(options.store.read());
  return role ? rolePreamble(role) : "";
}
