// Remove one source from every store that can serve or rebuild it.
//
// A source reaches three places: ChromaDB (which chat reads first), the
// in-memory index file (read when ChromaDB misses) and data/raw_documents/ (read
// by every rebuild). Removing it from fewer than all three brings it back.
// Dry run unless `apply` is set.
//
// The running app holds the index in memory and writes it back on its next
// save, so after applying, the app must reload the index file before it next
// ingests anything. scripts/remove-source.ts says so.

import { readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { countChromaSource, deleteChromaSource } from "./chromadb-store.js";
import { activeIndexPath, parseIndexFile, serializeIndex } from "./knowledge-store.js";
import { RAW_DOCUMENTS_DIR, rawDocumentFilename } from "./raw-documents.js";

export interface RemoveSourceDeps {
  readIndex: () => Promise<string | null>;
  writeIndex: (text: string) => Promise<void>;
  rawDocumentExists: (source: string) => Promise<boolean>;
  deleteRawDocument: (source: string) => Promise<void>;
  countChroma: (source: string) => Promise<number>;
  deleteChroma: (source: string) => Promise<void>;
}

export interface RemoveSourceReport {
  source: string;
  indexChunks: number;
  rawDocument: boolean;
  chromaChunks: number;
  applied: boolean;
}

const rawPath = (source: string) => join(RAW_DOCUMENTS_DIR, rawDocumentFilename(source));

const defaultDeps: RemoveSourceDeps = {
  readIndex: async () => (existsSync(activeIndexPath()) ? readFile(activeIndexPath(), "utf-8") : null),
  writeIndex: (text) => writeFile(activeIndexPath(), text, "utf-8"),
  rawDocumentExists: async (source) => existsSync(rawPath(source)),
  deleteRawDocument: (source) => unlink(rawPath(source)),
  countChroma: countChromaSource,
  deleteChroma: deleteChromaSource,
};

export async function removeSource(
  source: string,
  apply: boolean,
  deps: RemoveSourceDeps = defaultDeps,
): Promise<RemoveSourceReport> {
  if (source.trim() === "") throw new Error("A source is required; an empty one would match nothing useful");

  const indexText = await deps.readIndex();
  const index = indexText === null ? null : parseIndexFile(JSON.parse(indexText));
  const kept = index ? index.chunks.filter((c) => c.source !== source) : [];
  const indexChunks = index ? index.chunks.length - kept.length : 0;
  const rawDocument = await deps.rawDocumentExists(source);
  const chromaChunks = await deps.countChroma(source);

  if (apply) {
    if (indexChunks > 0 && index) {
      if (!index.meta) throw new Error("The index file has no metadata; rebuild it instead of editing it");
      await deps.writeIndex(serializeIndex(index.meta, kept, index.complete));
    }
    if (rawDocument) await deps.deleteRawDocument(source);
    if (chromaChunks > 0) await deps.deleteChroma(source);
  }

  return { source, indexChunks, rawDocument, chromaChunks, applied: apply };
}
