// Ingest a piece of text into every store chat retrieval reads.
//
// POST /api/knowledge/ingest-text used to write only the raw document and the
// in-memory index. Chat retrieval reads ChromaDB first and falls back to the
// in-memory index only when ChromaDB returns nothing, so text ingested here
// (everything the gap-fill loop finds) stayed invisible until the next full
// rebuild, and the loop's resolution check could never see what it had just
// stored.

import { addToChromaDB } from "./chromadb-store.js";
import { assertIndexUsable } from "./index-guard.js";
import { ingestText, saveIndex } from "./knowledge-store.js";
import { saveRawDocument } from "./raw-documents.js";

export interface IngestTextDeps {
  saveRawDocument: (source: string, text: string, metadata: Record<string, unknown>) => Promise<void>;
  assertIndexUsable: () => void;
  ingestText: (text: string, source: string) => Promise<number>;
  saveIndex: () => Promise<void>;
  addToChromaDB: (texts: string[], metadatas: Record<string, unknown>[]) => Promise<number>;
}

export interface IngestTextResult {
  // Chunks added to the in-memory index
  added: number;
  chromaAdded: number;
}

const defaultDeps: IngestTextDeps = {
  saveRawDocument: async (source, text, metadata) => {
    await saveRawDocument(source, text, metadata);
  },
  assertIndexUsable,
  ingestText,
  saveIndex,
  addToChromaDB,
};

export async function ingestTextDocument(
  text: string,
  source: string,
  deps: IngestTextDeps = defaultDeps,
): Promise<IngestTextResult> {
  const metadata = { type: "text" };

  // Raw document first, so the text is included in the next rebuild even if indexing fails now
  await deps.saveRawDocument(source, text, metadata);
  deps.assertIndexUsable();

  const added = await deps.ingestText(text, source);
  await deps.saveIndex();

  // Tagged exactly as a rebuild from raw documents tags it ({ source, ...metadata }),
  // so a live ingest and a rebuilt one are indistinguishable
  const chromaAdded = await deps.addToChromaDB([text], [{ source, ...metadata }]);

  return { added, chromaAdded };
}
