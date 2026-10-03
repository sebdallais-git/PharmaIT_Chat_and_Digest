// Give every ChromaDB chunk stored before dates existed its date (chunk-date.ts),
// without re-embedding: a metadata-only update by id. Idempotent.
//
// Usage:
//   npx tsx scripts/backfill-chunk-dates.ts           dry run: counts per kind, undatable sources
//   npx tsx scripts/backfill-chunk-dates.ts --apply   write the dates
//
// Covers every knowledge_base_* collection present (one per index family). New
// chunks are dated at write time; the in-memory index fills its own at startup.
import { CHROMA_BASE } from "../src/services/chromadb-store.js";
import { planDateBackfill } from "../src/services/chunk-date.js";
import { liveDateResolver } from "../src/services/date-sources-live.js";

const apply = process.argv.includes("--apply");
const PAGE = 1000;

interface Collection {
  id: string;
  name: string;
}

async function chroma<T>(path: string, body?: unknown): Promise<T> {
  const resp = await fetch(`${CHROMA_BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`ChromaDB ${path}: ${resp.status} ${await resp.text()}`);
  return (await resp.json()) as T;
}

const resolve = await liveDateResolver();
const collections = (await chroma<Collection[]>("")).filter((c) => c.name.startsWith("knowledge_base_"));

for (const collection of collections) {
  const rows: Array<{ id: string; metadata: Record<string, unknown> }> = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await chroma<{ ids: string[]; metadatas: Array<Record<string, unknown> | null> }>(`/${collection.id}/get`, {
      limit: PAGE,
      offset,
      include: ["metadatas"],
    });
    page.ids.forEach((id, i) => rows.push({ id, metadata: page.metadatas[i] ?? {} }));
    if (page.ids.length < PAGE) break;
  }

  const plan = planDateBackfill(rows, resolve);
  console.log(
    `${collection.name}: ${rows.length} chunks — to date: ${plan.counts.published} published, ` +
      `${plan.counts.retrieved} retrieved, ${plan.counts.document} document; ` +
      `already dated ${plan.counts.alreadyDated}; undatable ${plan.counts.unknown}`,
  );
  if (plan.unknownSources.length > 0) console.log(`  undatable sources: ${plan.unknownSources.slice(0, 10).join(", ")}`);

  if (apply) {
    for (let i = 0; i < plan.updates.length; i += PAGE) {
      const batch = plan.updates.slice(i, i + PAGE);
      await chroma(`/${collection.id}/update`, { ids: batch.map((u) => u.id), metadatas: batch.map((u) => u.metadata) });
    }
    console.log(`  APPLIED: ${plan.updates.length} chunks dated`);
  }
}

if (!apply) console.log("\nDRY RUN — pass --apply to write the dates");
