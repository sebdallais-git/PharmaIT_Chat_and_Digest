// The user's role: who they are, which accounts they cover and what they sell.
//
// It frames every chat answer (rolePreamble) and every digest. Roles are set by
// chatting (role-dialogue.ts), never with a selector, and saved in
// data/run/roles.json: account coverage is account intelligence, so the file is
// written mode 600 and never committed (data/ is gitignored).

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Theater } from "./watchlist-config.js";

export const PORTFOLIO_LINES = ["storage", "servers", "networking", "backup", "euc", "security"] as const;
export type PortfolioLine = (typeof PORTFOLIO_LINES)[number];

const LINE_LABELS: Record<PortfolioLine, string> = {
  storage: "storage",
  servers: "servers",
  networking: "networking",
  backup: "backup",
  euc: "end-user computing",
  security: "security",
};

export interface Role {
  id: string;
  title: string;
  company: string;
  accounts: string[];
  portfolio: PortfolioLine[];
  focus: string;
  // Where the seller's strategic influence sits (2026-10-04): the digest leads
  // with accounts headquartered there and gives them double room
  homeTheater?: Theater;
  updatedAt: string;
}

export type DraftField = "title" | "company" | "accounts" | "portfolio" | "focus";

// A role being onboarded. focus is null until asked: "" means the user skipped it.
export interface RoleDraft {
  title: string;
  company: string;
  accounts: string[];
  portfolio: PortfolioLine[];
  focus: string | null;
  asking: DraftField;
}

export interface RoleState {
  version: 1;
  active: string | null;
  roles: Role[];
  draft: RoleDraft | null;
}

export interface RoleStore {
  read(): RoleState;
  write(state: RoleState): void;
}

export const DEFAULT_ROLES_PATH = join(process.cwd(), "data", "run", "roles.json");

const EMPTY_STATE: RoleState = { version: 1, active: null, roles: [], draft: null };

export function openRoleStore(path: string = DEFAULT_ROLES_PATH): RoleStore {
  return {
    read(): RoleState {
      if (!existsSync(path)) return structuredClone(EMPTY_STATE);
      return JSON.parse(readFileSync(path, "utf-8")) as RoleState;
    },
    write(state): void {
      // Write-then-rename, so a crash never leaves half a file behind
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
    },
  };
}

export function activeRole(state: RoleState): Role | null {
  return state.roles.find((r) => r.id === state.active) ?? null;
}

export function roleLabel(role: Pick<Role, "title" | "company">): string {
  return `${role.title} at ${role.company}`;
}

export function roleId(title: string, company: string): string {
  return `${company}-${title}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** "Roche, Novartis and Sandoz" -> ["Roche", "Novartis", "Sandoz"] */
export function splitList(text: string): string[] {
  return text
    .split(/,|;|&|\band\b|\n/i)
    .map((part) => part.trim().replace(/[.!]+$/, "").trim())
    .filter((part) => part.length > 0 && part.length <= 60);
}

const LINE_KEYWORDS: [PortfolioLine, RegExp][] = [
  ["storage", /\b(storage|arrays?|flash|san|nas|file|object)\b/i],
  ["servers", /\b(servers?|compute|hci|poweredge|gpus?)\b/i],
  ["networking", /\b(network(ing)?|switch(es|ing)?|wan|lan)\b/i],
  ["backup", /\b(backup|data protection|recovery|cyber recovery|resilience)\b/i],
  ["euc", /\b(euc|end[- ]user|pcs?|laptops?|desktops?|workplace|clients?|devices?)\b/i],
  ["security", /\b(security|cyber\s?security|zero trust)\b/i],
];

/** Maps the user's wording onto the six lines, in canonical order. */
export function parsePortfolio(text: string): PortfolioLine[] {
  if (/\b(all|everything|all of (it|them)|the whole (portfolio|thing))\b/i.test(text)) return [...PORTFOLIO_LINES];
  const found = new Set(LINE_KEYWORDS.filter(([, pattern]) => pattern.test(text)).map(([line]) => line));
  return PORTFOLIO_LINES.filter((line) => found.has(line));
}

export function portfolioText(lines: readonly PortfolioLine[]): string {
  return lines.map((line) => LINE_LABELS[line]).join(", ");
}

// Cheap pre-check before any model call: could this message be about the role?
// A false positive costs one extraction call and then falls through to the chat.
const ROLE_PATTERN =
  /\b(my role|roles?\b.*\b(switch|change|use)|switch (to )?(my |the )?[\w\s-]{0,40}\brole|act as|i am now|i'm now|(i am|i'm) (the |a |an )?[\w\s/&-]{0,40}\b(at|for|from) \w|my accounts|to my accounts|from my accounts|i (don't|do not|no longer|also) sell|i sell|my portfolio|my focus|home theater|gam\b)/i;

export function isRoleCandidate(text: string, onboarding: boolean): boolean {
  return onboarding || ROLE_PATTERN.test(text);
}

const THEATER_WORDS: Array<[Theater, RegExp]> = [
  ["Americas", /\bamericas\b/i],
  ["EMEA", /\bemea\b/i],
  ["APAC", /\bapac\b/i],
];

/** "HLS Principal, EMEA" → "EMEA"; undefined when the title names no theater. */
export function inferHomeTheater(title: string): Theater | undefined {
  return THEATER_WORDS.find(([, pattern]) => pattern.test(title))?.[0];
}

export function roleSummary(role: Role): string {
  return [
    `**${roleLabel(role)}**`,
    `- Accounts: ${role.accounts.join(", ") || "none yet"}`,
    `- Portfolio: ${portfolioText(role.portfolio) || "none yet"}`,
    `- Focus: ${role.focus || "none"}`,
    ...(role.homeTheater ? [`- Home theater: ${role.homeTheater}`] : []),
    "",
    `Change anything by telling me, e.g. "add Lonza to my accounts" or "I don't sell networking".`,
  ].join("\n");
}

/** Appended to the chat system prompt while a role is active. */
export function rolePreamble(role: Role): string {
  return [
    "",
    "",
    `The user is ${roleLabel(role)}. Their accounts: ${role.accounts.join(", ")}. They sell: ${portfolioText(role.portfolio)}.`,
    ...(role.focus ? [`Their current focus: ${role.focus}.`] : []),
    ...(role.homeTheater
      ? [`Their strategic influence is with accounts headquartered in ${role.homeTheater}: lead with those, then the rest.`]
      : []),
    `- Answer for this seller: say what the facts mean for their accounts and for selling ${portfolioText(role.portfolio)} there.`,
    `- When recommending solutions, lead with ${role.company}'s products; name competitors plainly, especially where they are installed.`,
  ].join("\n");
}
