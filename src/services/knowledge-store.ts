// Knowledge store with vector embeddings for semantic search (RAG)
// Each LLM stack keeps its own index file, so vectors from different embedding models never mix.

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getActiveStack } from "../config/llm-stacks.js";
import { getLlmClient } from "./llm-client.js";
import { assertIndexUsable, expectedIndexMeta } from "./index-guard.js";
import type { IndexMeta } from "./index-guard.js";
import { parseFile, isSupportedFile } from "./file-parser.js";
import { toBatches } from "../utils/batches.js";
import type { ChunkDate } from "./chunk-date.js";

interface KnowledgeChunk {
  id: string;
  source: string;
  content: string;
  embedding: Float32Array;
  /** When the content was true or published (chunk-date.ts); absent on chunks stored before dates. */
  date?: ChunkDate;
}

interface StoredChunk {
  id: string;
  source: string;
  content: string;
  embedding: string; // base64 Float32
  date?: ChunkDate;
}

interface IndexFile {
  version: 2;
  meta: IndexMeta | null;
  // Set only by a rebuild that ran to the end; an interrupted rebuild leaves it out
  complete?: boolean;
  chunks: StoredChunk[];
}

export interface ParsedIndex {
  meta: IndexMeta | null;
  complete: boolean;
  chunks: KnowledgeChunk[];
}

export interface IndexSummary {
  meta: IndexMeta | null;
  complete: boolean;
  chunkCount: number;
}

export interface TextItem {
  text: string;
  source: string;
  date?: ChunkDate;
}

export interface KnowledgeFile {
  name: string;
  path: string;
}

const KNOWLEDGE_DIR = join(process.cwd(), "knowledge");
const EMBED_BATCH_SIZE = 32;

let chunks: KnowledgeChunk[] = [];
let indexMeta: IndexMeta | null = null;
let indexComplete = false;

// The active stack's index file, for tools that edit it outside the running app
export function activeIndexPath(): string {
  return indexPath();
}

function indexPath(): string {
  return join(KNOWLEDGE_DIR, getActiveStack().indexFile);
}

// Split text into reasonably sized chunks
function chunkText(text: string, maxChunkSize: number = 800): string[] {
  const paragraphs = text.split(/\n\s*\n/);
  const result: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    if (current.length + trimmed.length > maxChunkSize && current.length > 0) {
      result.push(current.trim());
      current = "";
    }
    current += (current ? "\n\n" : "") + trimmed;
  }

  if (current.trim()) {
    result.push(current.trim());
  }

  return result;
}

// Cosine similarity between two vectors
function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

// Keyword match score: fraction of query words found in content
function keywordScore(query: string, content: string): number {
  const contentLower = content.toLowerCase();
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) return 0;
  const matches = words.filter((w) => contentLower.includes(w)).length;
  return matches / words.length;
}

// Embeddings are stored as base64 Float32 to keep the index file small and fast to parse
export function encodeEmbedding(values: ArrayLike<number>): string {
  const floats = Float32Array.from(values);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).toString("base64");
}

export function decodeEmbedding(encoded: string): Float32Array {
  const bytes = Buffer.from(encoded, "base64");
  // Copy into a fresh buffer: pooled Buffers may start at an offset Float32Array can't use
  const aligned = new Uint8Array(bytes.byteLength);
  aligned.set(bytes);
  return new Float32Array(aligned.buffer);
}

export function parseIndexFile(raw: unknown): ParsedIndex {
  // Legacy indexes (plain arrays) predate the stack switch and can't be trusted
  if (Array.isArray(raw)) return { meta: null, complete: false, chunks: [] };

  const file = raw as Partial<IndexFile>;
  if (file.version !== 2 || !Array.isArray(file.chunks)) return { meta: null, complete: false, chunks: [] };

  return {
    meta: file.meta ?? null,
    complete: file.complete === true,
    chunks: file.chunks.map((c) => ({
      id: c.id,
      source: c.source,
      content: c.content,
      embedding: decodeEmbedding(c.embedding),
      ...(c.date !== undefined ? { date: c.date } : {}),
    })),
  };
}

export function serializeIndex(meta: IndexMeta, items: KnowledgeChunk[], complete: boolean = false): string {
  const file: IndexFile = {
    version: 2,
    meta,
    ...(complete ? { complete: true } : {}),
    chunks: items.map((c) => ({
      id: c.id,
      source: c.source,
      content: c.content,
      embedding: encodeEmbedding(c.embedding),
      ...(c.date !== undefined ? { date: c.date } : {}),
    })),
  };
  return JSON.stringify(file);
}

// Hybrid search: vector similarity + keyword boost
// Accepts an optional pre-computed embedding to avoid a redundant embedding call.
export async function searchKnowledge(query: string, topK: number = 5, precomputedEmbedding?: number[]): Promise<KnowledgeChunk[]> {
  assertIndexUsable();
  if (chunks.length === 0) return [];

  const queryEmbedding = precomputedEmbedding ?? await getLlmClient().embed(query, "query");

  const scored = chunks
    .map((chunk) => {
      const vectorScore = cosineSimilarity(queryEmbedding, chunk.embedding);
      const kwScore = keywordScore(query, chunk.content);
      // Hybrid: 70% vector + 30% keyword
      const combined = vectorScore * 0.7 + kwScore * 0.3;
      return { chunk, score: combined };
    })
    .filter((item) => item.score > 0.2)
    .sort((a, b) => b.score - a.score);

  // Deduplicate by content prefix
  const seen = new Set<string>();
  const results: KnowledgeChunk[] = [];
  for (const item of scored) {
    const key = item.chunk.content.slice(0, 100);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(item.chunk);
    if (results.length >= topK) break;
  }

  return results;
}

// Ingest a file (any supported format) into the knowledge base
export async function ingestFile(filePath: string, sourceName: string): Promise<number> {
  const content = await parseFile(filePath);
  return ingestText(content, sourceName);
}

// Ingest several texts, embedding their chunks in batches
export async function ingestTexts(items: TextItem[]): Promise<number> {
  const pending = items.flatMap((item) =>
    chunkText(item.text).map((content) => ({ source: item.source, content, date: item.date }))
  );
  const client = getLlmClient();

  for (const batch of toBatches(pending, EMBED_BATCH_SIZE)) {
    const embeddings = await client.embedMany(batch.map((p) => p.content), "document");
    batch.forEach((p, i) => {
      chunks.push({
        id: `${p.source}-${chunks.length}`,
        source: p.source,
        content: p.content,
        embedding: Float32Array.from(embeddings[i]),
        ...(p.date !== undefined ? { date: p.date } : {}),
      });
    });
  }

  return pending.length;
}

// Ingest raw text into the knowledge base
export async function ingestText(text: string, sourceName: string): Promise<number> {
  return ingestTexts([{ text, source: sourceName }]);
}

// Start an empty index for the active stack. Only a reindex calls this: it is the one place metadata is stamped.
export function resetIndex(): void {
  chunks = [];
  indexMeta = expectedIndexMeta(getActiveStack());
  indexComplete = false;
}

// Called by a reindex that ran to the end, before its final save
export function markIndexComplete(): void {
  indexComplete = true;
}

export function getIndexMeta(): IndexMeta | null {
  return indexMeta;
}

// Whether the currently loaded in-memory index carries the marker of a rebuild that ran to the end
export function isIndexComplete(): boolean {
  return indexComplete;
}

// Save the index to disk
export async function saveIndex(): Promise<void> {
  if (indexMeta === null) {
    throw new Error("Refusing to save an index without stack metadata — run scripts/reindex-stack.ts");
  }
  await mkdir(KNOWLEDGE_DIR, { recursive: true });
  await writeFile(indexPath(), serializeIndex(indexMeta, chunks, indexComplete), "utf-8");
}

// Load the active stack's index from disk
export async function loadIndex(path: string = indexPath()): Promise<void> {
  let data: string;
  try {
    data = await readFile(path, "utf-8");
  } catch {
    // No metadata: the startup guard refuses search until a reindex builds this stack's index
    chunks = [];
    indexMeta = null;
    indexComplete = false;
    console.log(`No index at ${path} — run scripts/reindex-stack.ts`);
    return;
  }

  const parsed = parseIndexFile(JSON.parse(data) as unknown);
  chunks = parsed.chunks;
  indexMeta = parsed.meta;
  indexComplete = parsed.complete;
  console.log(`Index loaded: ${chunks.length} chunks (${path})`);
}

/**
 * Give chunks stored before dates existed the date their source resolves to.
 * Stamped dates are kept. Returns how many chunks were filled.
 */
export function fillChunkDates(items: KnowledgeChunk[], resolve: (source: string) => ChunkDate | null): number {
  let filled = 0;
  for (const chunk of items) {
    if (chunk.date !== undefined) continue;
    const date = resolve(chunk.source);
    if (date !== null) {
      chunk.date = date;
      filled++;
    }
  }
  return filled;
}

/** fillChunkDates on the loaded index: run at startup, persisted by the next save. */
export function fillLoadedChunkDates(resolve: (source: string) => ChunkDate | null): number {
  return fillChunkDates(chunks, resolve);
}

// Read the index file's metadata and size without decoding embeddings
export async function readIndexSummary(): Promise<IndexSummary | null> {
  try {
    const raw = JSON.parse(await readFile(indexPath(), "utf-8")) as unknown;
    if (Array.isArray(raw)) return { meta: null, complete: false, chunkCount: raw.length };
    const file = raw as Partial<IndexFile>;
    const isV2 = file.version === 2;
    return {
      meta: isV2 ? file.meta ?? null : null,
      complete: isV2 && file.complete === true,
      chunkCount: Array.isArray(file.chunks) ? file.chunks.length : 0,
    };
  } catch {
    return null;
  }
}

// Supported files in knowledge/, skipping dotfiles such as the index files
export async function listKnowledgeFiles(): Promise<KnowledgeFile[]> {
  await mkdir(KNOWLEDGE_DIR, { recursive: true });
  const files = await readdir(KNOWLEDGE_DIR);
  return files
    .filter((file) => !file.startsWith(".") && isSupportedFile(file))
    .sort()
    .map((name) => ({ name, path: join(KNOWLEDGE_DIR, name) }));
}

// Ingest supported files from knowledge/ that aren't indexed yet
export async function ingestKnowledgeDir(): Promise<number> {
  let total = 0;
  const indexedSources = new Set(chunks.map((c) => c.source));

  try {
    for (const file of await listKnowledgeFiles()) {
      if (indexedSources.has(file.name)) {
        console.log(`  Skipped: ${file.name} (already indexed)`);
        continue;
      }
      const added = await ingestFile(file.path, file.name);
      total += added;
      console.log(`  Ingested: ${file.name} (${added} chunks)`);
    }
  } catch (err) {
    console.log(`knowledge/ ingestion stopped: ${err instanceof Error ? err.message : String(err)}`);
  }

  return total;
}

// Return knowledge base stats
export function getStats(): { totalChunks: number; sources: string[] } {
  const sources = [...new Set(chunks.map((c) => c.source))];
  return { totalChunks: chunks.length, sources };
}

export type { KnowledgeChunk };
