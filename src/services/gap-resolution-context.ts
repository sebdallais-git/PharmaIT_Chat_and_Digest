// Context for re-answering a knowledge gap after the gap-fill loop stored its findings.
//
// The check used to search ChromaDB for the top 5 chunks only. Against ~9,400
// chunks, what the loop had stored seconds earlier routinely lost to older,
// more generic chunks (gap #77 on 2026-09-26), so the check could not see the
// loop's own findings. The loop now passes the sources it stored, and those
// chunks always lead the context.

import { getChromaChunksBySource, isChromaDBAvailable, searchChromaDB } from "./chromadb-store.js";
import { searchKnowledge } from "./knowledge-store.js";

export interface ContextChunk {
  document: string;
  metadata: Record<string, unknown>;
}

export interface ResolutionContextDeps {
  isChromaDBAvailable: () => Promise<boolean>;
  searchChromaDB: (query: string, topK: number) => Promise<ContextChunk[]>;
  getChromaChunksBySource: (sources: string[]) => Promise<ContextChunk[]>;
  searchKnowledge: (query: string, topK: number) => Promise<{ source: string; content: string }[]>;
}

const defaultDeps: ResolutionContextDeps = {
  isChromaDBAvailable,
  searchChromaDB: (query, topK) => searchChromaDB(query, topK),
  getChromaChunksBySource: (sources) => getChromaChunksBySource(sources),
  searchKnowledge: (query, topK) => searchKnowledge(query, topK),
};

const HEADER = "\n\nRelevant context from the knowledge base:\n";

function format(entries: { source: string; text: string }[]): string {
  if (entries.length === 0) return "";
  return HEADER + entries.map((e) => `[Source: ${e.source}]\n${e.text}`).join("\n\n---\n\n");
}

async function fromChroma(query: string, storedSources: string[], deps: ResolutionContextDeps): Promise<string> {
  if (!(await deps.isChromaDBAvailable())) return "";
  const stored = storedSources.length > 0 ? await deps.getChromaChunksBySource(storedSources) : [];
  const searched = await deps.searchChromaDB(query, 5);

  const seen = new Set<string>();
  const entries: { source: string; text: string }[] = [];
  for (const chunk of [...stored, ...searched]) {
    if (seen.has(chunk.document)) continue;
    seen.add(chunk.document);
    entries.push({ source: String(chunk.metadata.source ?? "unknown"), text: chunk.document });
  }
  return format(entries);
}

export async function buildResolutionContext(
  query: string,
  storedSources: string[],
  deps: ResolutionContextDeps = defaultDeps,
): Promise<string> {
  let context = "";
  try {
    context = await fromChroma(query, storedSources, deps);
  } catch {
    // Fall back to the in-memory index
  }
  if (context) return context;

  const memory = await deps.searchKnowledge(query, 8);
  return format(memory.map((c) => ({ source: c.source, text: c.content })));
}
