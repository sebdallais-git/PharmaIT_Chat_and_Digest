// Rebuild or inspect the active stack's search indexes
// Usage:
//   LLM_PROVIDER=mlx npx tsx scripts/reindex-stack.ts            rebuild (PharmaITChat must be stopped)
//   LLM_PROVIDER=mlx npx tsx scripts/reindex-stack.ts --check    exit 0 if ready, 2 if a rebuild is needed
//   LLM_PROVIDER=mlx npx tsx scripts/reindex-stack.ts --status   print index metadata and counts

import { serviceUrl } from "../src/platform/host-config.js";
import { getActiveStack } from "../src/config/llm-stacks.js";
import { isChromaDBAvailable } from "../src/services/chromadb-store.js";
import { indexesReady, inspectIndexes, reindexActiveStack } from "../src/services/reindex.js";

const APP_URL = process.env.APP_URL ?? serviceUrl("app");

// A running app keeps its own copy of the in-memory index and would overwrite the rebuilt file
async function appIsRunning(): Promise<boolean> {
  try {
    await fetch(`${APP_URL}/api/health`, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "--rebuild";
  const stack = getActiveStack();

  if (!(await isChromaDBAvailable())) {
    console.error("ChromaDB is not reachable. Start it first.");
    process.exit(1);
  }

  if (mode === "--check" || mode === "--status") {
    const state = await inspectIndexes();
    if (mode === "--status") {
      const describe = (check: { ok: boolean; reason: string }, complete: boolean): string =>
        !check.ok ? check.reason : complete ? "ok" : "incomplete rebuild";
      console.log(
        `${stack.name}: in-memory ${state.memory.chunkCount} chunks (${describe(state.memory.check, state.memory.complete)}), ` +
        `ChromaDB ${state.chroma.count} chunks (${describe(state.chroma.check, state.chroma.complete)})`
      );
      return;
    }
    process.exit(indexesReady(state) ? 0 : 2);
  }

  if (mode !== "--rebuild") {
    console.error(`Unknown option ${mode}`);
    process.exit(1);
  }

  if (await appIsRunning()) {
    console.error(`PharmaITChat is running at ${APP_URL}. Stop it first, or call POST /api/knowledge/reindex.`);
    process.exit(1);
  }

  const result = await reindexActiveStack();
  if (result.skippedRawDocuments > 0) {
    console.error(
      `Reindex finished but skipped ${result.skippedRawDocuments} raw documents (see the log above). ` +
      "The indexes are usable without them; fix the cause and rebuild to include them."
    );
    process.exit(3);
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
