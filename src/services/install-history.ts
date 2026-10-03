// Install-base changes proposed from news (install-history-extract.ts) and
// approved by the user in config/install-history.local.yaml, merged into an
// account's stints at rebuild (spec 2026-10-03-install-history-design.md).
//
// The accounts file is the truth for now; approved news only adds the past.
// A contradiction never overrides the file: it becomes a conflict note.
import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import type { Account, Stint } from "./graph-accounts.js";
import { SEGMENTS, type Segment } from "./graph-schema.js";
import { normaliseSpace } from "./need-evidence.js";

export const INSTALL_HISTORY_FILE = "config/install-history.local.yaml";

const CHANGES = ["installed", "replaced", "removed"] as const;
export type Change = (typeof CHANGES)[number];
const STATUSES = ["proposed", "approved", "rejected"] as const;

export interface HistoryEntry {
  id: string;
  status: (typeof STATUSES)[number];
  account: string;
  segment: string;
  vendor: string;
  change: Change;
  replaced_vendor?: string;
  /** The news item's own date, YYYY-MM-DD: never the model's. */
  date: string;
  quote: string;
  source: string;
  extracted: string;
}

export interface InstallHistoryFile {
  /** Processed item -> "done", so a re-run skips it. */
  sources: Record<string, string>;
  entries: HistoryEntry[];
}

const HEADER = `# Written by scripts/extract-install-history.ts. Change status to approved or
# rejected; approved entries add history at the next graph rebuild. The accounts
# file stays the truth for who is installed now.
`;

export function historyEntryId(account: string, segment: string, vendor: string, change: string, quote: string): string {
  const key = `${account}\n${segment}\n${vendor}\n${change}\n${normaliseSpace(quote)}`;
  return `ih-${createHash("sha256").update(key).digest("hex").slice(0, 10)}`;
}

const text = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));

export function parseInstallHistory(yaml: string): InstallHistoryFile {
  const doc = (parse(yaml) ?? {}) as { sources?: unknown; entries?: unknown };
  const sources: Record<string, string> = {};
  if (doc.sources !== null && typeof doc.sources === "object" && !Array.isArray(doc.sources)) {
    for (const [k, v] of Object.entries(doc.sources as Record<string, unknown>)) sources[k] = text(v);
  }
  const seen = new Set<string>();
  const entries = (Array.isArray(doc.entries) ? doc.entries : []).map((raw): HistoryEntry => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const id = text(r.id);
    if (seen.has(id)) throw new Error(`duplicate id ${id}`);
    seen.add(id);
    const status = text(r.status);
    if (!(STATUSES as readonly string[]).includes(status)) throw new Error(`${id}: status must be proposed, approved or rejected`);
    const change = text(r.change);
    if (!(CHANGES as readonly string[]).includes(change)) throw new Error(`${id}: change must be installed, replaced or removed`);
    const segment = text(r.segment);
    if (!(SEGMENTS as readonly string[]).includes(segment)) throw new Error(`${id}: invalid segment "${segment}"`);
    const date = text(r.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${id}: date must be YYYY-MM-DD`);
    const replaced = text(r.replaced_vendor);
    if ((change === "replaced") !== (replaced !== "")) {
      throw new Error(`${id}: replaced_vendor is required exactly when change is replaced`);
    }
    return {
      id,
      status: status as HistoryEntry["status"],
      account: text(r.account),
      segment,
      vendor: text(r.vendor),
      change: change as Change,
      ...(replaced !== "" ? { replaced_vendor: replaced } : {}),
      date,
      quote: text(r.quote).trim(),
      source: text(r.source),
      extracted: text(r.extracted),
    };
  });
  return { sources, entries };
}

export function renderInstallHistory(file: InstallHistoryFile): string {
  return HEADER + stringify({ sources: file.sources, entries: file.entries }, { lineWidth: 0 });
}

/** A run's result folded into the file as it is on disk now: the user's entries win. */
export function mergeInstallHistory(onDisk: InstallHistoryFile, fromRun: InstallHistoryFile): InstallHistoryFile {
  const known = new Set(onDisk.entries.map((e) => e.id));
  return {
    sources: { ...onDisk.sources, ...fromRun.sources },
    entries: [...onDisk.entries.map((e) => ({ ...e })), ...fromRun.entries.filter((e) => !known.has(e.id))],
  };
}

export function checkHistoryAgainstAccounts(file: InstallHistoryFile, accounts: Account[]): void {
  const ids = new Set(accounts.map((a) => a.id));
  for (const e of file.entries) {
    if (e.status === "approved" && !ids.has(e.account)) throw new Error(`${e.id} names unknown account "${e.account}"`);
  }
}

/** Approved entries for this account, oldest first, applied to its stints. */
export function applyHistory(account: Account, entries: HistoryEntry[]): Account {
  const history: Account["history"] = {};
  for (const [segment, list] of Object.entries(account.history)) history[segment as Segment] = (list ?? []).map((s) => ({ ...s }));
  const conflicts: string[] = [...(account.conflicts ?? [])];

  const approved = entries
    .filter((e) => e.status === "approved" && e.account === account.id)
    .sort((a, b) => a.date.localeCompare(b.date));

  for (const e of approved) {
    const segment = e.segment as Segment;
    const stints = (history[segment] ??= []);
    const source = `news:${e.source}`;
    const current = (vendor: string) => stints.find((s) => s.vendor === vendor && s.until === "");

    const ended = (vendor: string): void => {
      if (current(vendor) !== undefined) {
        conflicts.push(
          `approved news says ${vendor} left ${segment} on ${e.date}; accounts.local.yaml still lists it as current`,
        );
        return;
      }
      const open = stints.find((s) => s.vendor === vendor && s.until === "?");
      if (open !== undefined) open.until = e.date;
      else if (!stints.some((s) => s.vendor === vendor && s.until === e.date)) {
        stints.push({ vendor, since: "", until: e.date, source });
      }
    };

    const installed = (vendor: string): void => {
      const now = current(vendor);
      if (now !== undefined) {
        if (now.since === "") now.since = e.date;
        return;
      }
      // Not current in the file: a past stint whose end the news does not say.
      if (!stints.some((s) => s.vendor === vendor && s.since === e.date)) {
        stints.push({ vendor, since: e.date, until: "?", source } satisfies Stint);
      }
    };

    if (e.change === "installed") installed(e.vendor);
    else if (e.change === "removed") ended(e.vendor);
    else {
      ended(e.replaced_vendor ?? "");
      installed(e.vendor);
    }
  }

  return { ...account, history, conflicts };
}
