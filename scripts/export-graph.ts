// Dump the whole Neo4j graph to JSON before anything destructive touches it.
// Read-only: no CREATE, MERGE, SET or DELETE. The schema rebuild wipes 880 nodes
// whose provenance is unknown, and a running container's state is not something
// to trust a filesystem backup with.
//
// Usage: npx tsx scripts/export-graph.ts [outfile]
import { serviceUrl } from "../src/platform/host-config.js";
import { writeFileSync } from "node:fs";
import neo4j from "neo4j-driver";

const URI = serviceUrl("neo4j");
const USER = process.env.NEO4J_USER ?? "neo4j";
const PASSWORD = process.env.NEO4J_PASSWORD ?? "pharma2024";

const out = process.argv[2] ?? `data/graph-export-${new Date().toISOString().slice(0, 10)}.json`;

const driver = neo4j.driver(URI, neo4j.auth.basic(USER, PASSWORD));
const session = driver.session({ defaultAccessMode: neo4j.session.READ });

try {
  const nodeResult = await session.run(
    "MATCH (n) RETURN id(n) AS id, labels(n) AS labels, properties(n) AS properties",
  );
  const relResult = await session.run(
    "MATCH (a)-[r]->(b) RETURN id(a) AS from, id(b) AS to, type(r) AS type, properties(r) AS properties",
  );

  const nodes = nodeResult.records.map((r) => ({
    id: r.get("id").toString(),
    labels: r.get("labels") as string[],
    properties: r.get("properties") as Record<string, unknown>,
  }));
  const relationships = relResult.records.map((r) => ({
    from: r.get("from").toString(),
    to: r.get("to").toString(),
    type: r.get("type") as string,
    properties: r.get("properties") as Record<string, unknown>,
  }));

  writeFileSync(out, JSON.stringify({ exportedAt: new Date().toISOString(), nodes, relationships }, null, 2));

  const labelCounts = new Map<string, number>();
  for (const node of nodes) for (const label of node.labels) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  const typeCounts = new Set(relationships.map((r) => r.type));

  console.log(`wrote ${out}`);
  console.log(`  ${nodes.length} nodes, ${relationships.length} relationships, ${typeCounts.size} distinct types`);
  console.log(
    `  labels: ${[...labelCounts.entries()].sort((a, b) => b[1] - a[1]).map(([l, c]) => `${l}=${c}`).join(" ")}`,
  );
} finally {
  await session.close();
  await driver.close();
}
