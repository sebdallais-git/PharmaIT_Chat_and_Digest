// Reads a digest request ("make me a digest of what happened this week",
// "storage news at Novartis last month") into a period and an optional focus.
// Deterministic: no model call decides what a digest covers.

import type { Domain, Entity } from "./watchlist-config.js";

export interface DigestRequest {
  from: Date;
  to: Date;
  // Human wording of the period, for the digest header
  label: string;
  focusEntities: string[];
  focusDomains: Domain[];
  // "my accounts": only the active role's accounts (and their peers)
  accountsOnly: boolean;
}

const DIGEST_PATTERN =
  /\b(digest|recap|round-?up|briefing|weekly (update|summary|brief)|summary of (the|this|last) (week|month)|what (has )?happened (today|yesterday|this week|last week|this month|last month|in the (last|past) (week|month|\d+ days))|(news|highlights) (of|from|for) (today|yesterday|this week|last week|this month|last month))\b/i;

export function isDigestRequest(text: string): boolean {
  return DIGEST_PATTERN.test(text);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

// Monday 00:00 (local) of the week containing `date`
function startOfWeek(date: Date): Date {
  const day = startOfDay(date);
  const sinceMonday = (day.getDay() + 6) % 7;
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() - sinceMonday);
}

function shortDate(date: Date): string {
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function parsePeriod(text: string, now: Date): { from: Date; to: Date; label: string } {
  const t = text.toLowerCase();
  const days = t.match(/\b(?:last|past) (\d{1,2}) days\b/);
  if (days) {
    const n = Math.min(Number(days[1]), 92);
    return { from: new Date(now.getTime() - n * DAY_MS), to: now, label: `the last ${n} days` };
  }
  if (/\b(last|previous) week\b/.test(t)) {
    const to = startOfWeek(now);
    const from = new Date(to.getFullYear(), to.getMonth(), to.getDate() - 7);
    const sunday = new Date(to.getTime() - DAY_MS);
    return { from, to, label: `the week of ${shortDate(from)}–${shortDate(sunday)}` };
  }
  if (/\byesterday\b/.test(t)) {
    const to = startOfDay(now);
    return { from: new Date(to.getTime() - DAY_MS), to, label: "yesterday" };
  }
  if (/\btoday\b/.test(t)) return { from: startOfDay(now), to: now, label: "today" };
  if (/\b(last|previous) month\b/.test(t)) {
    const to = new Date(now.getFullYear(), now.getMonth(), 1);
    const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return { from, to, label: from.toLocaleDateString("en-GB", { month: "long", year: "numeric" }) };
  }
  if (/\bthis month\b/.test(t)) {
    return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: now, label: "this month so far" };
  }
  const since = t.match(/\bsince (monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (since) {
    const target = WEEKDAYS.indexOf(since[1]);
    const today = startOfDay(now);
    const back = (today.getDay() - target + 7) % 7 || 7;
    const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
    return { from, to: now, label: `since ${since[1][0].toUpperCase()}${since[1].slice(1)}` };
  }
  return { from: new Date(now.getTime() - 7 * DAY_MS), to: now, label: "the last 7 days" };
}

const DOMAIN_WORDS: [Domain, RegExp][] = [
  ["storage", /\bstorage\b/i],
  ["backup", /\b(backup|data protection|cyber recovery)\b/i],
  ["infrastructure", /\b(infrastructure|servers?|compute|data ?cent(er|re)s?|network(ing)?|hci)\b/i],
  ["cyber", /\b(cyber|security|ransomware|breach(es)?)\b/i],
  ["ai", /\b(ai|artificial intelligence|genai|llms?)\b/i],
  ["cloud", /\bcloud\b/i],
  ["sap", /\bsap\b/i],
  ["mfg_it", /\b(manufacturing|mes|ot|plants?)\b/i],
  ["rnd_it", /\b(r&d|research|labs?|lims|clinical)\b/i],
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseDigestRequest(text: string, now: Date, entities: Iterable<Entity>): DigestRequest {
  const focusEntities: string[] = [];
  for (const entity of entities) {
    const names = [entity.name, ...entity.aliases].filter((n) => n.length >= 3);
    if (names.some((n) => new RegExp(`\\b${escapeRegExp(n)}\\b`, "i").test(text))) focusEntities.push(entity.id);
  }
  // "SAP" names both a vendor and a domain: as a domain it is broader, so it wins
  const focusDomains = DOMAIN_WORDS.filter(([, pattern]) => pattern.test(text)).map(([domain]) => domain);
  const entityFocus = focusDomains.includes("sap") ? focusEntities.filter((id) => id !== "sap") : focusEntities;
  return {
    ...parsePeriod(text, now),
    focusEntities: entityFocus,
    focusDomains,
    accountsOnly: /\bmy accounts?\b/i.test(text),
  };
}
