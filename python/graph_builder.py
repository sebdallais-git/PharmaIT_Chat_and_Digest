"""Extract entities and relationships from PharmaLLM knowledge base and populate Neo4j.

Usage:
    python python/graph_builder.py                  # Process all .md files
    python python/graph_builder.py knowledge/pharma-business.md  # Single file

Requires: NEO4J_URI and OLLAMA_URL in the environment (POST /api/graph/rebuild passes them from config/host.yaml)
"""

import json
import os
import re
import sys
import time
from pathlib import Path

import requests
from neo4j import GraphDatabase

# Configuration
NEO4J_URI = os.environ.get("NEO4J_URI") or sys.exit("graph_builder: NEO4J_URI is not set (run it through POST /api/graph/rebuild)")
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "pharma2024")
OLLAMA_URL = os.environ.get("OLLAMA_URL") or sys.exit("graph_builder: OLLAMA_URL is not set (run it through POST /api/graph/rebuild)")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "mistral-small:24b")
KNOWLEDGE_DIR = Path(__file__).resolve().parents[1] / "knowledge"

ENTITY_TYPES = [
    "Company", "Subsidiary", "Drug", "TherapeuticArea",
    "ManufacturingSite", "Country", "RegulatoryBody", "Regulation",
    "ThreatActor", "Attack", "AttackVector", "Vendor", "Product", "Technology",
]

RELATIONSHIP_TYPES = [
    "ACQUIRED", "HEADQUARTERED_IN", "PARTNERS_WITH",
    "OPERATES_SITE", "LOCATED_IN", "PRODUCES",
    "MANUFACTURES", "TREATS", "USES_TECHNOLOGY",
    "OVERSEES", "APPLIES_TO", "APPROVED_BY",
    "TARGETED", "ATTRIBUTED_TO", "USED_VECTOR", "HIT_SITE", "OPERATES_FROM",
    "USES_VENDOR", "PROVIDES", "PROTECTS_AGAINST",
]

EXTRACTION_PROMPT = """You are an entity extraction engine for a pharmaceutical cybersecurity knowledge base.

Given the following document, extract ALL entities and relationships.

ENTITY TYPES: {entity_types}

RELATIONSHIP TYPES: {relationship_types}

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{{
  "entities": [
    {{"type": "Company", "name": "Pfizer", "properties": {{"headquarters": "New York", "revenue_2024": "$59B"}}}}
  ],
  "relationships": [
    {{"from": "Pfizer", "fromType": "Company", "to": "Seagen", "toType": "Subsidiary", "type": "ACQUIRED", "properties": {{"year": 2023, "price": "$43B"}}}}
  ]
}}

Rules:
- Use the EXACT entity type names from the list above.
- Use the EXACT relationship type names from the list above.
- Entity names should be canonical: "Merck & Co" not "Merck & Co (MSD)".
- For each entity, include all relevant properties found in the text.
- Include ALL entities and relationships you can find, not just the main ones.
- Properties should have string or number values only.
- Return empty arrays if no entities/relationships found.

DOCUMENT:
{document}"""


def call_ollama(prompt: str) -> str:
    """Call Ollama generate endpoint."""
    resp = requests.post(
        f"{OLLAMA_URL}/api/generate",
        json={
            "model": OLLAMA_MODEL,
            "prompt": prompt,
            "stream": False,
            "options": {"temperature": 0.1, "num_ctx": 8192},
        },
        timeout=300,
    )
    resp.raise_for_status()
    return resp.json().get("response", "")


def parse_extraction(response: str) -> dict:
    """Parse JSON from Ollama response, handling common issues."""
    json_match = re.search(r"\{[\s\S]*\}", response)
    if not json_match:
        return {"entities": [], "relationships": []}

    try:
        data = json.loads(json_match.group())
        if "entities" not in data:
            data["entities"] = []
        if "relationships" not in data:
            data["relationships"] = []
        return data
    except json.JSONDecodeError:
        print("  WARNING: Failed to parse JSON from response")
        return {"entities": [], "relationships": []}


def clean_entity_name(name: str) -> str:
    """Normalize entity names for deduplication."""
    name = re.sub(r"\s*\(.*?\)\s*$", "", name).strip()
    name = name.rstrip(".,;:")
    return name


def write_to_neo4j(driver, entities: list[dict], relationships: list[dict]) -> tuple[int, int]:
    """Write extracted entities and relationships to Neo4j."""
    nodes_written = 0
    rels_written = 0

    with driver.session() as session:
        # Create uniqueness constraints (idempotent)
        for entity_type in ENTITY_TYPES:
            try:
                session.run(
                    f"CREATE CONSTRAINT IF NOT EXISTS FOR (n:{entity_type}) REQUIRE n.name IS UNIQUE"
                )
            except Exception:
                pass

        # Upsert entities
        for entity in entities:
            label = entity.get("type", "Entity").replace(" ", "")
            name = clean_entity_name(entity.get("name", ""))
            if not name or label not in ENTITY_TYPES:
                continue

            props = entity.get("properties", {})
            clean_props = {k: v for k, v in props.items() if isinstance(v, (str, int, float)) and k != "name"}

            session.run(
                f"MERGE (n:{label} {{name: $name}}) SET n += $props",
                name=name, props=clean_props,
            )
            nodes_written += 1

        # Upsert relationships
        for rel in relationships:
            from_name = clean_entity_name(rel.get("from", ""))
            to_name = clean_entity_name(rel.get("to", ""))
            from_type = rel.get("fromType", "Entity").replace(" ", "")
            to_type = rel.get("toType", "Entity").replace(" ", "")
            rel_type = rel.get("type", "RELATED_TO").replace(" ", "_").upper()

            if not from_name or not to_name:
                continue
            if from_type not in ENTITY_TYPES or to_type not in ENTITY_TYPES:
                continue

            props = rel.get("properties", {})
            clean_props = {k: v for k, v in props.items() if isinstance(v, (str, int, float))}

            try:
                session.run(
                    f"""MATCH (a:{from_type} {{name: $from_name}}), (b:{to_type} {{name: $to_name}})
                        MERGE (a)-[r:{rel_type}]->(b) SET r += $props""",
                    from_name=from_name, to_name=to_name, props=clean_props,
                )
                rels_written += 1
            except Exception as exc:
                print(f"  WARNING: Failed to create relationship {from_name}-[{rel_type}]->{to_name}: {exc}")

    return nodes_written, rels_written


def process_file(driver, filepath: Path) -> tuple[int, int]:
    """Process a single knowledge file: extract entities and write to Neo4j."""
    text = filepath.read_text(encoding="utf-8")

    if len(text) < 100:
        print(f"  Skipping {filepath.name}: too short")
        return 0, 0

    # Truncate very long files to fit context window
    if len(text) > 24000:
        text = text[:24000] + "\n\n[TRUNCATED]"

    prompt = EXTRACTION_PROMPT.format(
        entity_types=", ".join(ENTITY_TYPES),
        relationship_types=", ".join(RELATIONSHIP_TYPES),
        document=text,
    )

    print(f"  Extracting entities from {filepath.name}...")
    start = time.time()
    response = call_ollama(prompt)
    elapsed = time.time() - start
    print(f"  Ollama responded in {elapsed:.1f}s")

    data = parse_extraction(response)
    entities = data.get("entities", [])
    relationships = data.get("relationships", [])
    print(f"  Found {len(entities)} entities, {len(relationships)} relationships")

    if entities or relationships:
        nodes, rels = write_to_neo4j(driver, entities, relationships)
        return nodes, rels

    return 0, 0


def main():
    """Process all knowledge base files or a specific file."""
    if len(sys.argv) > 1:
        files = [Path(f) for f in sys.argv[1:] if Path(f).exists()]
    else:
        files = sorted(KNOWLEDGE_DIR.glob("*.md"))

    if not files:
        print("No files to process.")
        return

    print(f"Connecting to Neo4j at {NEO4J_URI}...")
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    driver.verify_connectivity()
    print("Connected to Neo4j.\n")

    # Process files in order: companies/countries first, then cyber, then vendors
    priority_order = [
        "pharma-basics", "pharma-business", "pharma-top20-revenue",
        "pharma-top20-market-cap", "pharma-top20-reputation",
        "pharma-regulation", "pharma-science",
        "pharma-manufacturing-plants", "pharma-drug-market-value-forecasts",
        "pharma-phase3-pipeline", "pharma-news",
    ]

    def sort_key(f: Path) -> int:
        stem = f.stem
        for i, prefix in enumerate(priority_order):
            if stem.startswith(prefix):
                return i
        if stem.startswith("cyber"):
            return 100
        if stem.startswith("vendor"):
            return 200
        return 300

    files.sort(key=sort_key)

    total_nodes = 0
    total_rels = 0
    total_start = time.time()

    for i, filepath in enumerate(files):
        print(f"\n[{i + 1}/{len(files)}] {filepath.name}")
        try:
            nodes, rels = process_file(driver, filepath)
            total_nodes += nodes
            total_rels += rels
        except Exception as exc:
            print(f"  ERROR: {exc}")

    total_elapsed = time.time() - total_start
    print(f"\n{'='*60}")
    print(f"Graph build complete in {total_elapsed:.0f}s")
    print(f"Total nodes: {total_nodes}")
    print(f"Total relationships: {total_rels}")
    print(f"Files processed: {len(files)}")

    driver.close()


if __name__ == "__main__":
    main()
