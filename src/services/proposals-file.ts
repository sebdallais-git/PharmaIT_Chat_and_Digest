// The shape shared by the gitignored proposals files the 27B writes and the
// user reviews: config/need-evidence.local.yaml and
// config/install-history.local.yaml. `sources` maps an input to the hash it
// was last read at; `entries` is a list of proposals, each with an id.
//
// The user edits these files by hand (approve by changing `status`, notes in
// comments), so a malformed file fails loudly instead of reading as empty, and
// a run appends to the parsed document instead of re-rendering it: comments
// and extra fields on existing entries survive.

import { isMap, isSeq, parse, parseDocument, stringify, type Document } from "yaml";

export interface ProposalsDocument {
  sources: Record<string, string>;
  entries: Array<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The file's sources and raw entries, its shape and ids checked; field checks are the caller's. */
export function proposalsDocument(yaml: string): ProposalsDocument {
  const doc: unknown = parse(yaml) ?? {};
  if (!isRecord(doc)) throw new Error("the file must be a mapping with sources and entries");

  const sources: Record<string, string> = {};
  if (isRecord(doc.sources)) {
    for (const [path, hash] of Object.entries(doc.sources)) sources[path] = String(hash ?? "");
  }

  const raw = doc.entries ?? [];
  if (!Array.isArray(raw)) throw new Error("entries must be a list");
  const seen = new Set<string>();
  const entries = raw.map((entry: unknown, i) => {
    if (!isRecord(entry)) throw new Error(`entry ${i + 1} must be a mapping`);
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (id === "") throw new Error(`entry ${i + 1} has no id`);
    if (seen.has(id)) throw new Error(`duplicate id ${id}`);
    seen.add(id);
    return entry;
  });
  return { sources, entries };
}

/**
 * The on-disk text with `sources` replaced and `added` appended to `entries`,
 * everything else (comments, extra fields, the user's edits) left as it was.
 */
export function appendProposals(onDisk: string, header: string, sources: Record<string, string>, added: object[]): string {
  if (onDisk.trim() === "") return header + stringify({ sources, entries: added }, { lineWidth: 0 });
  // Widened from Document.Parsed: an only-comments file gets new contents below
  const doc: Document = parseDocument(onDisk);
  // Only comments (the user cleared the entries): build on them, keeping them
  if (doc.contents === null) doc.contents = doc.createNode({ sources, entries: [] });
  if (!isMap(doc.contents)) throw new Error("the file must be a mapping with sources and entries");
  doc.set("sources", doc.createNode(sources));
  const entries = doc.get("entries", true);
  if (isSeq(entries)) {
    for (const entry of added) entries.add(doc.createNode(entry));
    // An empty list is written as `entries: []`, a flow list: entries appended
    // to it later would all land on that one line, unreadable to review
    if (entries.items.length > 0) entries.flow = false;
  } else {
    doc.set("entries", doc.createNode(added));
  }
  return doc.toString({ lineWidth: 0 });
}
