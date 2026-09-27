// Remove one source from ChromaDB, the in-memory index file and data/raw_documents/.
//
// Usage: npx tsx scripts/remove-source.ts <source> [--apply]
// Without --apply it only reports what it would remove.
import { removeSource } from "../src/services/remove-source.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const source = args.find((a) => a !== "--apply");

if (!source) {
  console.error("Usage: npx tsx scripts/remove-source.ts <source> [--apply]");
  process.exit(2);
}

const report = await removeSource(source, apply);
console.log(`${apply ? "Removed" : "Would remove"} "${report.source}":`);
console.log(`  in-memory index : ${report.indexChunks} chunk(s)`);
console.log(`  raw document    : ${report.rawDocument ? "yes" : "none"}`);
console.log(`  ChromaDB        : ${report.chromaChunks} chunk(s)`);
if (!apply) {
  console.log("Dry run. Re-run with --apply to remove.");
} else if (report.indexChunks > 0) {
  console.log("Restart the app now: it still holds the old index in memory and would write it back on its next save.");
}
