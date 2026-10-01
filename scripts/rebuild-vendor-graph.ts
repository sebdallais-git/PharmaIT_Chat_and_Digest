// Rebuild the vendor-intelligence graph from knowledge/vendors/*.md.
//
// Usage:
//   npx tsx scripts/rebuild-vendor-graph.ts          dry run, prints the plan
//   npx tsx scripts/rebuild-vendor-graph.ts --apply  merge into the graph
//   npx tsx scripts/rebuild-vendor-graph.ts --apply --rebuild
//                                                    WIPE the graph, then write
//
// --rebuild is destructive. Export first: scripts/export-graph.ts
import { serviceUrl } from "../src/platform/host-config.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import neo4j from "neo4j-driver";
import { briefToGraphFacts, parseVendorBrief } from "../src/services/graph-schema.js";
import {
  accountToGraphFacts,
  needsMapToGraphFacts,
  parseAccounts,
  parseNeedsMap,
} from "../src/services/graph-accounts.js";
import { writeGraphFacts, type GraphWriter } from "../src/services/graph-writer.js";

const URI = serviceUrl("neo4j");
const USER = process.env.NEO4J_USER ?? "neo4j";
const PASSWORD = process.env.NEO4J_PASSWORD ?? "pharma2024";
const BRIEFS = join(process.cwd(), "knowledge", "vendors");

const apply = process.argv.includes("--apply");
const rebuild = process.argv.includes("--rebuild");

const batch = readdirSync(BRIEFS)
  .filter((f) => f.endsWith(".md"))
  .sort()
  .map((f) => {
    const brief = parseVendorBrief(readFileSync(join(BRIEFS, f), "utf8"));
    return { file: f, brief, facts: briefToGraphFacts(brief) };
  });

for (const { file, brief, facts } of batch) {
  console.log(
    `${file.padEnd(28)} ${brief.vendor}/${brief.segment} ${brief.position}/${brief.confidence}` +
      ` -> ${facts.nodes.length} nodes, ${facts.relationships.length} rels`,
  );
}

// Accounts are optional: the vendor half stands alone, and a missing local
// file must not stop a rebuild. Its absence is reported, not swallowed.
const extra = [];
const needsPath = join(process.cwd(), "config", "needs.yaml");
try {
  const facts = needsMapToGraphFacts(parseNeedsMap(readFileSync(needsPath, "utf8")));
  extra.push(facts);
  console.log(`\nneeds.yaml                   -> ${facts.relationships.length} ADDRESSED_BY edges`);
} catch (err) {
  console.log(`\nneeds.yaml                   -> skipped (${(err as Error).message})`);
}

const accountsPath = join(process.cwd(), "config", "accounts.local.yaml");
try {
  for (const account of parseAccounts(readFileSync(accountsPath, "utf8"))) {
    const facts = accountToGraphFacts(account);
    extra.push(facts);
    const held = Object.keys(account.incumbents).length;
    console.log(
      `${(account.id + ".account").padEnd(28)} ${account.needs.length} needs, ` +
        `${held} segment(s) with a known incumbent -> ${facts.relationships.length} rels`,
    );
  }
} catch (err) {
  console.log(`accounts.local.yaml          -> skipped (${(err as Error).message})`);
}

if (!apply) {
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
  await writeGraphFacts([...batch.map((b) => b.facts), ...extra], noop);
  console.log(`\nDRY RUN — would write ${counted.nodes} nodes and ${counted.relationships} relationships`);
  console.log("pass --apply to write, add --rebuild to wipe the graph first");
  process.exit(0);
}

const driver = neo4j.driver(URI, neo4j.auth.basic(USER, PASSWORD));
const session = driver.session();

const liveWriter: GraphWriter = {
  async clear() {
    await session.run("MATCH (n) DETACH DELETE n");
  },
  async mergeNode(label, id, properties) {
    // The label is interpolated because Cypher cannot parameterise it; it is
    // safe only because writeGraphFacts has already checked it against the
    // closed set. Never relax that check.
    await session.run(`MERGE (n:${label} {id: $id}) SET n += $properties`, { id, properties });
  },
  async mergeRelationship(type, from, to, properties, identity) {
    // Identity properties belong in the MERGE pattern: without them, two USES
    // edges for different segments collapse into one and a segment is lost.
    const pattern = identity.length
      ? `{${identity.map((k) => `${k}: $id_${k}`).join(", ")}}`
      : "";
    const idParams = Object.fromEntries(identity.map((k) => [`id_${k}`, properties[k]]));
    await session.run(
      `MATCH (a {id: $from}), (b {id: $to}) MERGE (a)-[r:${type} ${pattern}]->(b) SET r += $properties`,
      { from, to, properties, ...idParams },
    );
  },
};

try {
  if (rebuild) console.log("\nWIPING the graph before writing (--rebuild)");
  const written = await writeGraphFacts([...batch.map((b) => b.facts), ...extra], liveWriter, { rebuild });
  console.log(`\nAPPLIED — ${written.nodes} nodes, ${written.relationships} relationships`);

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
  await driver.close();
}
