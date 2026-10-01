// Neo4j graph store for entity-relationship queries

import neo4j from "neo4j-driver";
import type { Driver } from "neo4j-driver";
import { serviceUrl } from "../platform/host-config.js";

const NEO4J_URI = serviceUrl("neo4j");
const NEO4J_USER = process.env.NEO4J_USER ?? "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD ?? "pharma2024";

let driver: Driver | null = null;

export function getDriver(): Driver {
  if (!driver) {
    driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
  }
  return driver;
}

const VALID_LABELS = new Set([
  "Company", "Subsidiary", "Drug", "TherapeuticArea",
  "ManufacturingSite", "Country", "RegulatoryBody", "Regulation",
  "ThreatActor", "Attack", "AttackVector", "Vendor", "Product", "Technology",
]);

function sanitizeLabel(raw: string): string | null {
  const cleaned = raw.replace(/[^a-zA-Z0-9]/g, "");
  if (!cleaned || !VALID_LABELS.has(cleaned)) return null;
  return cleaned;
}

export async function isNeo4jAvailable(): Promise<boolean> {
  try {
    const d = getDriver();
    const info = await d.getServerInfo();
    return !!info;
  } catch {
    return false;
  }
}

export async function getNeo4jStats(): Promise<{
  nodeCount: number;
  relationshipCount: number;
  nodesByLabel: Record<string, number>;
  relationshipsByType: Record<string, number>;
}> {
  const session = getDriver().session();
  try {
    const nodeResult = await session.run("MATCH (n) RETURN count(n) AS count");
    const nodeCount = neo4j.integer.toNumber(nodeResult.records[0]?.get("count"));

    const relResult = await session.run("MATCH ()-[r]->() RETURN count(r) AS count");
    const relCount = neo4j.integer.toNumber(relResult.records[0]?.get("count"));

    const labelResult = await session.run(
      "MATCH (n) UNWIND labels(n) AS label RETURN label, count(*) AS count ORDER BY count DESC"
    );
    const nodesByLabel: Record<string, number> = {};
    for (const record of labelResult.records) {
      nodesByLabel[record.get("label") as string] = neo4j.integer.toNumber(record.get("count"));
    }

    const typeResult = await session.run(
      "MATCH ()-[r]->() RETURN type(r) AS type, count(*) AS count ORDER BY count DESC"
    );
    const relationshipsByType: Record<string, number> = {};
    for (const record of typeResult.records) {
      relationshipsByType[record.get("type") as string] = neo4j.integer.toNumber(record.get("count"));
    }

    return { nodeCount, relationshipCount: relCount, nodesByLabel, relationshipsByType };
  } finally {
    await session.close();
  }
}

export interface GraphEntity {
  type: string;
  name: string;
  properties: Record<string, unknown>;
}

export interface GraphRelationship {
  from: string;
  to: string;
  fromType: string;
  toType: string;
  type: string;
  properties: Record<string, unknown>;
}

export async function writeEntities(
  entities: GraphEntity[],
  relationships: GraphRelationship[]
): Promise<{ nodesProcessed: number; relsProcessed: number }> {
  const session = getDriver().session();
  let nodesProcessed = 0;
  let relsProcessed = 0;

  try {
    for (const entity of entities) {
      const label = sanitizeLabel(entity.type);
      if (!label) continue;
      await session.run(
        `MERGE (n:${label} {name: $name}) SET n += $props`,
        { name: entity.name, props: entity.properties }
      );
      nodesProcessed++;
    }

    for (const rel of relationships) {
      const fromLabel = sanitizeLabel(rel.fromType);
      const toLabel = sanitizeLabel(rel.toType);
      if (!fromLabel || !toLabel) continue;
      const relType = rel.type.replace(/[^a-zA-Z0-9_]/g, "_").toUpperCase();
      if (!relType) continue;
      await session.run(
        `MATCH (a:${fromLabel} {name: $from}), (b:${toLabel} {name: $to})
         MERGE (a)-[r:${relType}]->(b) SET r += $props`,
        { from: rel.from, to: rel.to, props: rel.properties }
      );
      relsProcessed++;
    }

    return { nodesProcessed, relsProcessed };
  } finally {
    await session.close();
  }
}

export async function queryGraphForChat(keywords: string[]): Promise<string> {
  if (keywords.length === 0) return "";

  const session = getDriver().session();
  try {
    const whereClauses = keywords.map((_, i) => `toLower(n.name) CONTAINS toLower($kw${i})`).join(" OR ");
    const params: Record<string, string> = {};
    keywords.forEach((kw, i) => { params[`kw${i}`] = kw; });

    const result = await session.run(
      `MATCH (n)
       WHERE ${whereClauses}
       OPTIONAL MATCH (n)-[r1]-(hop1)
       OPTIONAL MATCH (hop1)-[r2]-(hop2)
       WHERE hop2 <> n
       WITH n, labels(n) AS nLabels,
            collect(DISTINCT {rel: type(r1), target: hop1.name, targetType: labels(hop1)[0]}) AS direct,
            collect(DISTINCT {rel1: type(r1), mid: hop1.name, rel2: type(r2), target: hop2.name, targetType: labels(hop2)[0]}) AS twoHop
       RETURN n.name AS name, nLabels, properties(n) AS props, direct, twoHop
       LIMIT 5`,
      params
    );

    if (result.records.length === 0) return "";

    const lines: string[] = ["[Graph Context]"];
    for (const record of result.records) {
      const name = record.get("name") as string;
      const labels = record.get("nLabels") as string[];
      const props = record.get("props") as Record<string, unknown>;
      const direct = record.get("direct") as Array<{ rel: string | null; target: string | null; targetType: string | null }>;

      lines.push(`- ${name} (${labels[0] ?? "Entity"})`);

      for (const [key, val] of Object.entries(props)) {
        if (key !== "name" && val !== null && val !== undefined && String(val).length < 200) {
          lines.push(`  ${key}: ${String(val)}`);
        }
      }

      const seen = new Set<string>();
      for (const d of direct) {
        if (d.rel && d.target) {
          const key = `${d.rel}-${d.target}`;
          if (!seen.has(key)) {
            seen.add(key);
            lines.push(`  --${d.rel.toLowerCase().replace(/_/g, " ")}--> ${d.target} (${d.targetType ?? "?"})`);
          }
        }
      }
    }

    return lines.join("\n");
  } finally {
    await session.close();
  }
}

export async function clearGraph(): Promise<void> {
  const session = getDriver().session();
  try {
    await session.run("MATCH (n) DETACH DELETE n");
  } finally {
    await session.close();
  }
}

export async function closeNeo4j(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
  }
}
