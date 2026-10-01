// Rebuilds the vendor-intelligence graph from its three deterministic sources:
// knowledge/vendors/*.md, config/needs.yaml and config/accounts.local.yaml.
// Shared by scripts/rebuild-vendor-graph.ts and POST /api/graph/rebuild.
//
// No model is involved, so a rebuild works on every stack -- the Python builder
// this replaces called Ollama directly and was refused (409) on the other three.
// The wipe and the writes share one transaction: a failure part-way leaves the
// previous graph in place instead of a half-written one.
import type { Driver } from "neo4j-driver";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { accountToGraphFacts, needsMapToGraphFacts, parseAccounts, parseNeedsMap } from "./graph-accounts.js";
import { briefToGraphFacts, parseVendorBrief, type GraphFacts } from "./graph-schema.js";
import { writeGraphFacts, type GraphWriter } from "./graph-writer.js";

export interface RebuildSources {
  root: string;
  readDir?: (dir: string) => string[];
  readFile?: (path: string) => string;
}

export interface CollectedFacts {
  batch: GraphFacts[];
  lines: string[];
}

function isMissingFile(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}

/**
 * Read an optional source. A missing file is skipped and reported; a present
 * file that fails to parse throws. The difference matters for a wipe-and-write
 * rebuild: skipping a broken accounts file would silently delete every account.
 */
function optionalSource(
  name: string,
  path: string,
  readFile: (path: string) => string,
  lines: string[],
  toFacts: (text: string) => GraphFacts[],
): GraphFacts[] {
  let text: string;
  try {
    text = readFile(path);
  } catch (err) {
    if (isMissingFile(err)) {
      lines.push(`${name.padEnd(28)} -> skipped (no such file)`);
      return [];
    }
    throw err;
  }
  try {
    return toFacts(text);
  } catch (err) {
    throw new Error(`${name}: ${(err as Error).message}`);
  }
}

export function collectVendorGraphFacts(sources: RebuildSources): CollectedFacts {
  const readDir = sources.readDir ?? ((dir: string) => readdirSync(dir));
  const readFile = sources.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const briefsDir = join(sources.root, "knowledge", "vendors");
  const batch: GraphFacts[] = [];
  const lines: string[] = [];

  for (const file of readDir(briefsDir).filter((f) => f.endsWith(".md")).sort()) {
    // A bad brief throws: a rebuild without it would silently drop that vendor's position.
    let facts: GraphFacts;
    let label: string;
    try {
      const brief = parseVendorBrief(readFile(join(briefsDir, file)));
      facts = briefToGraphFacts(brief);
      label = `${brief.vendor}/${brief.segment} ${brief.position}/${brief.confidence}`;
    } catch (err) {
      throw new Error(`${file}: ${(err as Error).message}`);
    }
    batch.push(facts);
    lines.push(`${file.padEnd(28)} ${label} -> ${facts.nodes.length} nodes, ${facts.relationships.length} rels`);
  }

  batch.push(
    ...optionalSource("needs.yaml", join(sources.root, "config", "needs.yaml"), readFile, lines, (text) => {
      const facts = needsMapToGraphFacts(parseNeedsMap(text));
      lines.push(`${"needs.yaml".padEnd(28)} -> ${facts.relationships.length} ADDRESSED_BY edges`);
      return [facts];
    }),
  );

  batch.push(
    ...optionalSource("accounts.local.yaml", join(sources.root, "config", "accounts.local.yaml"), readFile, lines, (text) =>
      parseAccounts(text).map((account) => {
        const facts = accountToGraphFacts(account);
        lines.push(
          `${`${account.id}.account`.padEnd(28)} ${account.needs.length} needs, ` +
            `${Object.keys(account.incumbents).length} segment(s) with a known incumbent -> ${facts.relationships.length} rels`,
        );
        return facts;
      }),
    ),
  );

  return { batch, lines };
}

export interface CypherRunner {
  run(query: string, params?: Record<string, unknown>): PromiseLike<unknown>;
}

export function cypherGraphWriter(runner: CypherRunner): GraphWriter {
  return {
    async clear() {
      await runner.run("MATCH (n) DETACH DELETE n");
    },
    async mergeNode(label, id, properties) {
      // The label is interpolated because Cypher cannot parameterise it; it is
      // safe only because writeGraphFacts has already checked it against the
      // closed set. Never relax that check.
      await runner.run(`MERGE (n:${label} {id: $id}) SET n += $properties`, { id, properties });
    },
    async mergeRelationship(type, from, to, properties, identity) {
      // Identity properties belong in the MERGE pattern: without them, two USES
      // edges for different segments collapse into one and a segment is lost.
      const pattern = identity.length ? `{${identity.map((k) => `${k}: $id_${k}`).join(", ")}}` : "";
      const idParams = Object.fromEntries(identity.map((k) => [`id_${k}`, properties[k]]));
      await runner.run(
        `MATCH (a {id: $from}), (b {id: $to}) MERGE (a)-[r:${type} ${pattern}]->(b) SET r += $properties`,
        { from, to, properties, ...idParams },
      );
    },
  };
}

export type WriteTransaction = <T>(work: (runner: CypherRunner) => Promise<T>) => Promise<T>;

export function neo4jWriteTransaction(driver: Driver): WriteTransaction {
  return async (work) => {
    const session = driver.session();
    try {
      return await session.executeWrite((tx) => work(tx));
    } finally {
      await session.close();
    }
  };
}

export interface RebuildResult {
  nodes: number;
  relationships: number;
  lines: string[];
}

/** Validate every source, then (by default) wipe and rewrite the graph in one transaction. */
export async function rebuildVendorGraph(
  sources: RebuildSources,
  inTransaction: WriteTransaction,
  options: { rebuild?: boolean } = {},
): Promise<RebuildResult> {
  const { batch, lines } = collectVendorGraphFacts(sources);
  const written = await inTransaction((runner) =>
    writeGraphFacts(batch, cypherGraphWriter(runner), { rebuild: options.rebuild ?? true }),
  );
  return { ...written, lines };
}
