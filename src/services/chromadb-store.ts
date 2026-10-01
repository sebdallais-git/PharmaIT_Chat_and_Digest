// ChromaDB vector store client for RAG
// Connects to a running ChromaDB server via its REST API. Each LLM stack uses its own collection.

import { getActiveStack } from "../config/llm-stacks.js";
import { getLlmClient } from "./llm-client.js";
import { assertIndexUsable, expectedIndexMeta, indexMetaFromChroma, indexMetaToChroma } from "./index-guard.js";
import type { IndexMeta } from "./index-guard.js";
import { serviceUrl } from "../platform/host-config.js";
import { toBatches } from "../utils/batches.js";

const CHROMADB_URL = serviceUrl("chromadb");
const TENANT = "default_tenant";
const DATABASE = "default_database";
const EMBED_BATCH_SIZE = 32;
const UPSERT_BATCH_SIZE = 500;

export const CHROMA_BASE = `${CHROMADB_URL}/api/v2/tenants/${TENANT}/databases/${DATABASE}/collections`;
const BASE = CHROMA_BASE;

interface ChromaCollection {
  id: string;
  name: string;
  metadata?: Record<string, unknown> | null;
}

interface ChromaQueryResult {
  id: string;
  document: string;
  metadata: Record<string, unknown>;
  distance: number;
}

export interface ChromaEntry {
  id: string;
  document: string;
  metadata: Record<string, unknown>;
}

export interface ChromaCollectionInfo {
  meta: IndexMeta | null;
  complete: boolean;
  count: number;
}

// Collection metadata key set once a reindex has run to the end
const INDEX_COMPLETE_KEY = "index_complete";

// Cached collection ID, keyed by name so a different stack never reuses it
let cachedCollection: { name: string; id: string } | null = null;

function collectionName(): string {
  return getActiveStack().chromaCollection;
}

/** The collection the current process would read or write, for scripts that must say so before acting. */
export function getActiveStackCollectionName(): string {
  return collectionName();
}

async function findCollection(): Promise<ChromaCollection | null> {
  const resp = await fetch(BASE);
  if (!resp.ok) {
    throw new Error(`ChromaDB: failed to list collections (${resp.status})`);
  }
  const collections = (await resp.json()) as ChromaCollection[];
  return collections.find((c) => c.name === collectionName()) ?? null;
}

// Resolve the active stack's collection ID, creating the collection with index metadata if needed
export async function getCollectionId(): Promise<string> {
  const name = collectionName();
  if (cachedCollection?.name === name) return cachedCollection.id;

  const existing = await findCollection();
  if (existing) {
    cachedCollection = { name, id: existing.id };
    return existing.id;
  }

  const createResp = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      metadata: {
        "hnsw:space": "cosine",
        ...indexMetaToChroma(expectedIndexMeta(getActiveStack())),
      },
    }),
  });
  if (!createResp.ok) {
    throw new Error(`ChromaDB: failed to create collection (${createResp.status})`);
  }
  const created = (await createResp.json()) as ChromaCollection;
  cachedCollection = { name, id: created.id };
  return created.id;
}

// Split text into chunks of roughly ~500 tokens (≈ 2000 chars)
function chunkText(text: string, charLimit: number = 2000): string[] {
  const paragraphs = text.split(/\n\s*\n/);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    if (current.length + trimmed.length + 2 > charLimit && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }

    // Split oversized paragraphs on sentence boundaries
    if (trimmed.length > charLimit) {
      const sentences = trimmed.split(/(?<=\.)\s+/);
      for (const sentence of sentences) {
        if (current.length + sentence.length + 1 > charLimit && current.length > 0) {
          chunks.push(current.trim());
          current = "";
        }
        current += (current ? " " : "") + sentence;
      }
    } else {
      current += (current ? "\n\n" : "") + trimmed;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

// Generate a short deterministic ID from text
function makeId(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36).padStart(8, "0");
}

// Chroma rejects duplicate IDs inside one upsert, and identical chunks hash to the same ID
export function dedupeEntries(entries: ChromaEntry[]): ChromaEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}

/**
 * Query ChromaDB for the most relevant chunks.
 * Accepts an optional pre-computed embedding to avoid a redundant embedding call.
 */
export async function searchChromaDB(
  query: string,
  topK: number = 5,
  precomputedEmbedding?: number[]
): Promise<ChromaQueryResult[]> {
  assertIndexUsable();
  const id = await getCollectionId();
  const queryEmbedding = precomputedEmbedding ?? await getLlmClient().embed(query, "query");

  const resp = await fetch(`${BASE}/${id}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query_embeddings: [queryEmbedding],
      n_results: topK,
      include: ["documents", "metadatas", "distances"],
    }),
  });

  if (!resp.ok) {
    throw new Error(`ChromaDB query failed (${resp.status})`);
  }

  const data = (await resp.json()) as {
    ids: string[][];
    documents: string[][];
    metadatas: Record<string, unknown>[][];
    distances: number[][];
  };

  if (!data.ids[0] || data.ids[0].length === 0) return [];

  const results: ChromaQueryResult[] = [];
  for (let i = 0; i < data.ids[0].length; i++) {
    results.push({
      id: data.ids[0][i],
      document: data.documents[0][i],
      metadata: data.metadatas[0][i],
      distance: data.distances[0][i],
    });
  }

  return results;
}

/**
 * Chunk texts, embed them on the active stack in batches, and upsert into ChromaDB.
 */
export async function addToChromaDB(
  texts: string[],
  metadatas: Record<string, unknown>[]
): Promise<number> {
  const id = await getCollectionId();
  const addedAt = new Date().toISOString();

  const entries: ChromaEntry[] = [];
  texts.forEach((text, t) => {
    const chunks = chunkText(text);
    chunks.forEach((chunk, i) => {
      entries.push({
        id: makeId(chunk),
        document: chunk,
        metadata: { ...metadatas[t], chunk_index: i, total_chunks: chunks.length, added_at: addedAt },
      });
    });
  });

  const unique = dedupeEntries(entries);
  if (unique.length === 0) return 0;

  const client = getLlmClient();
  const embeddings: number[][] = [];
  for (const batch of toBatches(unique, EMBED_BATCH_SIZE)) {
    embeddings.push(...(await client.embedMany(batch.map((e) => e.document), "document")));
  }

  let offset = 0;
  for (const batch of toBatches(unique, UPSERT_BATCH_SIZE)) {
    const resp = await fetch(`${BASE}/${id}/upsert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ids: batch.map((e) => e.id),
        documents: batch.map((e) => e.document),
        embeddings: embeddings.slice(offset, offset + batch.length),
        metadatas: batch.map((e) => e.metadata),
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`ChromaDB upsert failed (${resp.status}): ${body}`);
    }
    offset += batch.length;
  }

  return unique.length;
}

// Where-filter for the chunks of exactly one source
export function chromaSourceFilter(source: string): { where: { source: string } } {
  return { where: { source } };
}

// How many chunks ChromaDB holds for a source
export async function countChromaSource(source: string): Promise<number> {
  const id = await getCollectionId();
  const resp = await fetch(`${BASE}/${id}/get`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...chromaSourceFilter(source), include: [] }),
  });
  if (!resp.ok) throw new Error(`ChromaDB get failed (${resp.status})`);
  return ((await resp.json()) as { ids: string[] }).ids.length;
}

// Delete every chunk of a source from the active stack's collection
export async function deleteChromaSource(source: string): Promise<void> {
  const id = await getCollectionId();
  const resp = await fetch(`${BASE}/${id}/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(chromaSourceFilter(source)),
  });
  if (!resp.ok) throw new Error(`ChromaDB delete failed (${resp.status})`);
}

// Request body for the documents stored under any of `sources`
export function sourceLookupBody(sources: string[], limit: number): Record<string, unknown> {
  return {
    where: { source: { $in: sources } },
    limit,
    include: ["documents", "metadatas"],
  };
}

/**
 * The chunks stored under the given sources, whatever their similarity to any
 * query. The gap-resolution check uses this to see what the loop just stored.
 */
export async function getChromaChunksBySource(
  sources: string[],
  limit: number = 10
): Promise<{ document: string; metadata: Record<string, unknown> }[]> {
  if (sources.length === 0) return [];
  assertIndexUsable();
  const id = await getCollectionId();

  const resp = await fetch(`${BASE}/${id}/get`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sourceLookupBody(sources, limit)),
  });

  if (!resp.ok) {
    throw new Error(`ChromaDB get failed (${resp.status})`);
  }

  const data = (await resp.json()) as { documents: (string | null)[]; metadatas: (Record<string, unknown> | null)[] };
  return data.documents.flatMap((document, i) =>
    document === null ? [] : [{ document, metadata: data.metadatas[i] ?? {} }]
  );
}

/**
 * Check if a source URL already has chunks in ChromaDB.
 */
export async function chromaDocumentExists(source: string): Promise<boolean> {
  const id = await getCollectionId();

  const resp = await fetch(`${BASE}/${id}/get`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      where: { source },
      limit: 1,
      include: [],
    }),
  });

  if (!resp.ok) return false;

  const data = (await resp.json()) as { ids: string[] };
  return data.ids.length > 0;
}

/**
 * Metadata and size of the active stack's collection, or null if it doesn't exist.
 * Unlike the other functions, this never creates the collection.
 */
export async function getChromaCollectionInfo(): Promise<ChromaCollectionInfo | null> {
  const collection = await findCollection();
  if (!collection) return null;

  const countResp = await fetch(`${BASE}/${collection.id}/count`);
  const count = countResp.ok ? ((await countResp.json()) as number) : 0;
  return {
    meta: indexMetaFromChroma(collection.metadata),
    complete: collection.metadata?.[INDEX_COMPLETE_KEY] === true,
    count,
  };
}

/**
 * Metadata for marking a collection complete. ChromaDB replaces the whole metadata map on update,
 * so existing keys are carried over; "hnsw:*" keys are left out because the distance function
 * can't be changed after creation (it stays in the collection's configuration).
 */
export function completeCollectionMetadata(
  metadata: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const kept = Object.entries(metadata ?? {}).filter(([key]) => !key.startsWith("hnsw:"));
  return { ...Object.fromEntries(kept), [INDEX_COMPLETE_KEY]: true };
}

/**
 * Mark the active stack's collection as fully rebuilt (PUT .../collections/{id} with new_metadata).
 */
export async function markChromaCollectionComplete(): Promise<void> {
  const collection = await findCollection();
  if (!collection) {
    throw new Error("ChromaDB: collection missing, cannot mark the rebuild complete");
  }

  const resp = await fetch(`${BASE}/${collection.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ new_metadata: completeCollectionMetadata(collection.metadata) }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`ChromaDB: failed to mark collection complete (${resp.status}): ${body.slice(0, 300)}`);
  }
}

/**
 * Return stats about the ChromaDB knowledge base.
 */
export async function getChromaStatus(): Promise<{
  totalChunks: number;
  sources: string[];
  lastAdded: string | null;
}> {
  const id = await getCollectionId();

  // Get count
  const countResp = await fetch(`${BASE}/${id}/count`, { method: "GET" });
  const totalChunks = countResp.ok ? ((await countResp.json()) as number) : 0;

  // Get all metadatas to extract sources and timestamps
  let sources: string[] = [];
  let lastAdded: string | null = null;

  if (totalChunks > 0) {
    const getResp = await fetch(`${BASE}/${id}/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ include: ["metadatas"] }),
    });

    if (getResp.ok) {
      const data = (await getResp.json()) as { metadatas: Record<string, unknown>[] };
      const sourceSet = new Set<string>();

      for (const meta of data.metadatas) {
        if (typeof meta.source === "string") sourceSet.add(meta.source);
        if (typeof meta.added_at === "string") {
          if (!lastAdded || meta.added_at > lastAdded) {
            lastAdded = meta.added_at;
          }
        }
      }
      sources = [...sourceSet].sort();
    }
  }

  return { totalChunks, sources, lastAdded };
}

/**
 * Check if the ChromaDB server is reachable.
 */
export async function isChromaDBAvailable(): Promise<boolean> {
  try {
    const resp = await fetch(`${CHROMADB_URL}/api/v2/heartbeat`, {
      signal: AbortSignal.timeout(2000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Delete the active stack's collection and reset the cached ID.
 */
export async function deleteChromaCollection(): Promise<void> {
  cachedCollection = null;
  const existing = await findCollection();
  if (!existing) return;

  const resp = await fetch(`${BASE}/${encodeURIComponent(existing.name)}`, { method: "DELETE" });
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`ChromaDB: failed to delete collection (${resp.status})`);
  }
}

/**
 * Delete and recreate the active stack's collection (empty, with index metadata).
 */
export async function recreateChromaCollection(): Promise<void> {
  await deleteChromaCollection();
  await getCollectionId();
}

export type { ChromaQueryResult };
