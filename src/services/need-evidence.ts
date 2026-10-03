// The need-evidence proposals file: reasons why each account has each need,
// cited from the legacy documents (spec 2026-10-02-need-evidence-design.md).
//
// The 27B proposes entries (need-evidence-extract.ts); the user approves them
// by editing `status`; only approved entries reach the graph, through the
// rebuild. Pure: the callers read and write the file.
import { createHash } from "node:crypto";
import { stringify } from "yaml";
import { appendProposals, proposalsDocument } from "./proposals-file.js";
import type { Account } from "./graph-accounts.js";
import { NEEDS, type GraphFacts, type GraphNode, type GraphRelationship } from "./graph-schema.js";

export const NEED_EVIDENCE_FILE = "config/need-evidence.local.yaml";
export const MAX_CLAIM_CHARS = 200;

const STATUSES = ["proposed", "approved", "rejected"] as const;
export type EvidenceStatus = (typeof STATUSES)[number];

export interface NeedEvidenceEntry {
  id: string;
  status: EvidenceStatus;
  account: string;
  need: string;
  claim: string;
  quote: string;
  source: string;
  extracted: string;
}

export interface NeedEvidenceFile {
  /** Processed document -> content hash, so a re-run skips what has not changed. */
  sources: Record<string, string>;
  entries: NeedEvidenceEntry[];
}

const HEADER = `# Written by scripts/extract-need-evidence.ts. Change status to approved or
# rejected; only approved entries reach the graph. Re-runs never touch an
# entry that is already here, so your decisions stay.
`;

export function normaliseSpace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Stable across re-runs: the same quote for the same account and need is the same entry. */
export function entryId(account: string, need: string, quote: string): string {
  return `ne-${createHash("sha256").update(`${account}\n${need}\n${normaliseSpace(quote)}`).digest("hex").slice(0, 10)}`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parseNeedEvidence(yaml: string): NeedEvidenceFile {
  // Shape, ids and duplicates: a malformed file fails instead of reading as empty
  const { sources, entries: raw } = proposalsDocument(yaml);
  const entries = raw.map((r): NeedEvidenceEntry => {
    const id = text(r.id);
    const status = text(r.status);
    if (!(STATUSES as readonly string[]).includes(status)) {
      throw new Error(`${id}: status must be proposed, approved or rejected`);
    }
    const need = text(r.need);
    if (!(NEEDS as readonly string[]).includes(need)) throw new Error(`${id}: invalid need "${need}"`);
    const claim = text(r.claim).trim();
    const quote = text(r.quote).trim();
    if (claim.length === 0 || quote.length === 0) throw new Error(`${id}: claim and quote must be non-empty`);
    return {
      id,
      status: status as EvidenceStatus,
      account: text(r.account),
      need,
      claim,
      quote,
      source: text(r.source),
      extracted: text(r.extracted),
    };
  });

  return { sources, entries };
}

/** Approved entries must still match the accounts file: fail loudly rather than drop the user's decisions. */
export function checkAgainstAccounts(file: NeedEvidenceFile, accounts: Account[]): void {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const stale = new Map<string, string[]>();
  for (const e of file.entries) {
    if (e.status !== "approved") continue;
    const account = byId.get(e.account);
    if (account === undefined) throw new Error(`${e.id} names unknown account "${e.account}"`);
    if (!(account.needs as readonly string[]).includes(e.need)) {
      const key = `${e.account} no longer declares ${e.need}`;
      stale.set(key, [...(stale.get(key) ?? []), e.id]);
    }
  }
  for (const [problem, ids] of stale) throw new Error(`${problem}: reject or re-approve ${ids.join(", ")}`);
}

/**
 * Fold a run's result into the file as it is on disk now: the user may have
 * approved entries while the run went on. Their entries win; the run only
 * adds entries whose id is new, and the documents it processed.
 */
/**
 * The run folded into the file's text as it is on disk now: new entries are
 * appended and sources updated; existing entries, comments and extra fields stay.
 */
export function mergeNeedEvidenceText(onDisk: string, fromRun: NeedEvidenceFile): string {
  const current = parseNeedEvidence(onDisk);
  const known = new Set(current.entries.map((e) => e.id));
  const merged = mergeNeedEvidence(current, fromRun);
  return appendProposals(onDisk, HEADER, merged.sources, merged.entries.filter((e) => !known.has(e.id)));
}

export function mergeNeedEvidence(onDisk: NeedEvidenceFile, fromRun: NeedEvidenceFile): NeedEvidenceFile {
  const known = new Set(onDisk.entries.map((e) => e.id));
  return {
    sources: { ...onDisk.sources, ...fromRun.sources },
    entries: [...onDisk.entries.map((e) => ({ ...e })), ...fromRun.entries.filter((e) => !known.has(e.id))],
  };
}

export function renderNeedEvidence(file: NeedEvidenceFile): string {
  return HEADER + stringify({ sources: file.sources, entries: file.entries }, { lineWidth: 0 });
}

export function needEvidenceToGraphFacts(file: NeedEvidenceFile): { facts: GraphFacts; line: string } {
  const approved = file.entries.filter((e) => e.status === "approved");
  const nodes: GraphNode[] = approved.map((e, order) => ({
    label: "Evidence",
    id: e.id,
    // `order` keeps file order: the answer shows the first entries per need.
    properties: { kind: "reference", claim: e.claim, quote: e.quote, source: e.source, order },
  }));
  const relationships: GraphRelationship[] = approved.map((e) => ({
    type: "SUPPORTS",
    from: e.id,
    to: e.account,
    properties: { url: `${e.source}#${e.id}`, need: e.need },
  }));

  const perAccount = new Map<string, number>();
  for (const e of approved) perAccount.set(e.account, (perAccount.get(e.account) ?? 0) + 1);
  const breakdown = [...perAccount].sort(([a], [b]) => a.localeCompare(b)).map(([a, n]) => `${a} ${n}`);
  const count = (status: EvidenceStatus) => file.entries.filter((e) => e.status === status).length;
  const line =
    `${"need-evidence.local.yaml".padEnd(28)} -> ${approved.length} approved` +
    (breakdown.length > 0 ? ` (${breakdown.join(", ")})` : "") +
    `, ${count("proposed")} proposed, ${count("rejected")} rejected`;

  return { facts: { nodes, relationships }, line };
}
