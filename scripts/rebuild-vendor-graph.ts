// Rebuild the vendor-intelligence graph from knowledge/vendors/*.md,
// config/needs.yaml, config/accounts.local.yaml and data/watchlist.db (evidence).
//
// Usage:
//   npx tsx scripts/rebuild-vendor-graph.ts          dry run, prints the plan
//   npx tsx scripts/rebuild-vendor-graph.ts --apply  merge into the graph
//   npx tsx scripts/rebuild-vendor-graph.ts --apply --rebuild
//                                                    WIPE the graph, then write (one transaction)
//
// POST /api/graph/rebuild does the same as --apply --rebuild.
// --rebuild is destructive. Export first: scripts/export-graph.ts
import neo4j from "neo4j-driver";
import { join } from "node:path";
import { serviceUrl } from "../src/platform/host-config.js";
import { watchlistEvidence } from "../src/services/graph-evidence.js";
import { writeGraphFacts, type GraphWriter } from "../src/services/graph-writer.js";
import {
  collectVendorGraphFacts,
  neo4jWriteTransaction,
  rebuildVendorGraph,
} from "../src/services/vendor-graph-rebuild.js";

const apply = process.argv.includes("--apply");
const rebuild = process.argv.includes("--rebuild");
const sources = { root: process.cwd(), evidence: watchlistEvidence(join(process.cwd(), "data", "watchlist.db")) };

if (!apply) {
  const { batch, lines } = collectVendorGraphFacts(sources);
  for (const line of lines) console.log(line);
  // Still runs the whole validation and dedupe path, just against a writer that
  // records instead of writing -- a dry run that skipped it would prove nothing.
  const counted = { nodes: 0, relationships: 0 };
  const noop: GraphWriter = {
    async clear() {},
    async mergeNode() {
      counted.nodes++;
    },
    async mergeRelationship() {
      counted.relationships++;
    },
  };
  await writeGraphFacts(batch, noop);
  console.log(`\nDRY RUN — would write ${counted.nodes} nodes and ${counted.relationships} relationships`);
  console.log("pass --apply to write, add --rebuild to wipe the graph first");
  process.exit(0);
}

const driver = neo4j.driver(
  serviceUrl("neo4j"),
  neo4j.auth.basic(process.env.NEO4J_USER ?? "neo4j", process.env.NEO4J_PASSWORD ?? "pharma2024"),
);

try {
  if (rebuild) console.log("WIPING the graph before writing (--rebuild), in the same transaction");
  const result = await rebuildVendorGraph(sources, neo4jWriteTransaction(driver), { rebuild });
  for (const line of result.lines) console.log(line);
  console.log(`\nAPPLIED — ${result.nodes} nodes, ${result.relationships} relationships`);

  const session = driver.session({ defaultAccessMode: neo4j.session.READ });
  try {
    const check = await session.run(
      "MATCH (n) WITH count(n) AS nodes MATCH ()-[r]->() RETURN nodes, count(r) AS rels, count(DISTINCT type(r)) AS types",
    );
    const row = check.records[0];
    console.log(
      `graph now holds ${row.get("nodes")} nodes, ${row.get("rels")} relationships, ` +
        `${row.get("types")} distinct relationship types`,
    );
  } finally {
    await session.close();
  }
} finally {
  await driver.close();
}
