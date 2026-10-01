/**
 * Seed Neo4j with real pharma cyber attack chains and vendor/product nodes.
 * Creates: ThreatActor → PERPETRATED → Attack → TARGETED → Company
 *          Vendor → OFFERS → Product → PROTECTS_AGAINST → AttackVector
 */

import { serviceUrl } from "../src/platform/host-config.js";
import neo4j from "neo4j-driver";

const NEO4J_URI = serviceUrl("neo4j");
const NEO4J_USER = process.env.NEO4J_USER ?? "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD ?? "pharma2024";

const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));

async function run(cypher: string, params: Record<string, unknown> = {}): Promise<void> {
  const session = driver.session();
  try {
    await session.run(cypher, params);
  } finally {
    await session.close();
  }
}

async function seed(): Promise<void> {
  console.log("Seeding Neo4j with pharma cyber attack chains...\n");

  // ──────────────────────────────────────────────
  // 1. THREAT ACTORS
  // ──────────────────────────────────────────────
  console.log("Creating threat actors...");
  const threatActors = [
    { name: "Sandworm", origin: "Russia", type: "Nation-state APT", aliases: "Unit 74455, Voodoo Bear" },
    { name: "Lazarus Group", origin: "North Korea", type: "Nation-state APT", aliases: "Hidden Cobra, APT38" },
    { name: "APT10", origin: "China", type: "Nation-state APT", aliases: "Stone Panda, MenuPass" },
    { name: "Winnti Group", origin: "China", type: "Nation-state APT", aliases: "APT41, Barium" },
    { name: "Deep Panda", origin: "China", type: "Nation-state APT", aliases: "APT19, Shell Crew" },
    { name: "ALPHV/BlackCat", origin: "Russia", type: "Ransomware-as-a-Service", aliases: "BlackCat, Noberus" },
    { name: "REvil", origin: "Russia", type: "Ransomware-as-a-Service", aliases: "Sodinokibi" },
    { name: "Conti", origin: "Russia", type: "Ransomware-as-a-Service", aliases: "Wizard Spider" },
    { name: "CLOP", origin: "Russia", type: "Ransomware-as-a-Service", aliases: "TA505, FIN11" },
    { name: "Ryuk", origin: "Russia", type: "Ransomware-as-a-Service", aliases: "Wizard Spider" },
    { name: "Maze", origin: "Unknown", type: "Ransomware-as-a-Service", aliases: "ChaCha" },
    { name: "Hive", origin: "Unknown", type: "Ransomware-as-a-Service", aliases: "" },
    { name: "Money Message", origin: "Unknown", type: "Ransomware", aliases: "" },
    { name: "Hunters International", origin: "Unknown", type: "Ransomware-as-a-Service", aliases: "Hive successor" },
    { name: "Black Basta", origin: "Russia", type: "Ransomware-as-a-Service", aliases: "Conti spinoff" },
    { name: "Qilin", origin: "Russia", type: "Ransomware-as-a-Service", aliases: "Agenda" },
    { name: "Rhysida", origin: "Unknown", type: "Ransomware-as-a-Service", aliases: "" },
    { name: "Snake/EKANS", origin: "Unknown", type: "ICS-targeting ransomware", aliases: "EKANS" },
    { name: "Industrial Spy", origin: "Unknown", type: "Data broker/extortion", aliases: "" },
    { name: "SamSam", origin: "Iran", type: "Ransomware", aliases: "" },
  ];

  for (const actor of threatActors) {
    await run(
      `MERGE (t:ThreatActor {name: $name})
       SET t.origin = $origin, t.type = $type, t.aliases = $aliases`,
      actor
    );
  }
  console.log(`  Created ${threatActors.length} threat actors`);

  // ──────────────────────────────────────────────
  // 2. ATTACK VECTORS
  // ──────────────────────────────────────────────
  console.log("Creating attack vectors...");
  const attackVectors = [
    { name: "Ransomware", description: "Encrypts systems and demands payment for decryption" },
    { name: "Supply Chain Compromise", description: "Infects trusted software updates to reach targets" },
    { name: "Spear-Phishing", description: "Targeted phishing with social engineering" },
    { name: "Credential Compromise", description: "Stolen or brute-forced authentication credentials" },
    { name: "Zero-Day Exploit", description: "Exploitation of previously unknown vulnerability" },
    { name: "APT Espionage", description: "Long-term stealthy access for intelligence gathering" },
    { name: "Data Exfiltration", description: "Unauthorized extraction of sensitive data" },
    { name: "Cloud Misconfiguration", description: "Exposed data due to incorrect cloud security settings" },
    { name: "Business Email Compromise", description: "Impersonation via compromised email accounts" },
    { name: "File Transfer Exploit", description: "Exploitation of file transfer software vulnerabilities" },
  ];

  for (const vec of attackVectors) {
    await run(
      `MERGE (v:AttackVector {name: $name}) SET v.description = $description`,
      vec
    );
  }
  console.log(`  Created ${attackVectors.length} attack vectors`);

  // ──────────────────────────────────────────────
  // 3. ATTACKS with full chains
  // ──────────────────────────────────────────────
  console.log("Creating attacks and linking chains...");

  interface AttackData {
    attack: string;
    company: string;
    year: number;
    vector: string;
    actor: string;
    impact: string;
    cost_usd: number | null;
    records_affected: number | null;
  }

  const attacks: AttackData[] = [
    // === MAJOR PHARMA ATTACKS ===
    {
      attack: "NotPetya Attack on Merck",
      company: "Merck",
      year: 2017,
      vector: "Supply Chain Compromise",
      actor: "Sandworm",
      impact: "40,000+ computers destroyed, manufacturing halted for weeks, unable to fulfill Gardasil orders",
      cost_usd: 1_400_000_000,
      records_affected: null,
    },
    {
      attack: "Change Healthcare Breach",
      company: "Change Healthcare",
      year: 2024,
      vector: "Credential Compromise",
      actor: "ALPHV/BlackCat",
      impact: "Largest US healthcare breach, 100M+ records, pharmacy claims processing down nationwide for weeks",
      cost_usd: 2_870_000_000,
      records_affected: 100_000_000,
    },
    {
      attack: "AstraZeneca COVID Vaccine Espionage",
      company: "AstraZeneca",
      year: 2020,
      vector: "Spear-Phishing",
      actor: "Lazarus Group",
      impact: "LinkedIn recruitment impersonation targeting COVID-19 vaccine research, attack detected and blocked",
      cost_usd: null,
      records_affected: null,
    },
    {
      attack: "Novartis Industrial Spy Breach",
      company: "Novartis",
      year: 2022,
      vector: "Data Exfiltration",
      actor: "Industrial Spy",
      impact: "Manufacturing and laboratory data stolen and offered on dark web",
      cost_usd: 75_000_000,
      records_affected: null,
    },
    {
      attack: "Bayer Winnti Espionage",
      company: "Bayer",
      year: 2019,
      vector: "APT Espionage",
      actor: "Winnti Group",
      impact: "Long-term espionage, systems compromised for months, Winnti malware planted since 2018",
      cost_usd: null,
      records_affected: null,
    },
    {
      attack: "Roche Winnti Espionage",
      company: "Roche",
      year: 2019,
      vector: "APT Espionage",
      actor: "Winnti Group",
      impact: "Systems compromised, extent of data access unclear",
      cost_usd: null,
      records_affected: null,
    },
    {
      attack: "Moderna COVID Research Targeting",
      company: "Moderna",
      year: 2020,
      vector: "APT Espionage",
      actor: "APT10",
      impact: "Chinese government-linked hackers targeted COVID-19 vaccine research, DOJ indictment July 2020",
      cost_usd: null,
      records_affected: null,
    },
    {
      attack: "Pfizer/BioNTech EMA Vaccine Data Theft",
      company: "Pfizer",
      year: 2020,
      vector: "Data Exfiltration",
      actor: "APT10",
      impact: "COVID-19 vaccine regulatory documents stolen from EMA and leaked, some manipulated before release",
      cost_usd: null,
      records_affected: null,
    },
    {
      attack: "Hoya Hunters International Ransomware",
      company: "Hoya Corporation",
      year: 2024,
      vector: "Ransomware",
      actor: "Hunters International",
      impact: "Production halted at several factories, ordering systems down for 8+ weeks",
      cost_usd: 75_000_000,
      records_affected: null,
    },
    {
      attack: "Sun Pharma ALPHV Ransomware",
      company: "Sun Pharmaceutical Industries",
      year: 2023,
      vector: "Ransomware",
      actor: "ALPHV/BlackCat",
      impact: "File systems breached, data exfiltrated, revenue impacted by business disruption",
      cost_usd: 62_500_000,
      records_affected: null,
    },
    {
      attack: "Dr. Reddy's Ransomware",
      company: "Dr. Reddy's Laboratories",
      year: 2020,
      vector: "Ransomware",
      actor: "Lazarus Group",
      impact: "Plants shut down in Brazil, India, Russia, UK, US after Sputnik V vaccine approval",
      cost_usd: 35_000_000,
      records_affected: null,
    },
    {
      attack: "ExecuPharm CLOP Ransomware",
      company: "ExecuPharm",
      year: 2020,
      vector: "Ransomware",
      actor: "CLOP",
      impact: "Financial records, documents, user data exfiltrated and published online",
      cost_usd: 15_000_000,
      records_affected: null,
    },
    {
      attack: "Fresenius Snake Ransomware",
      company: "Fresenius Group",
      year: 2020,
      vector: "Ransomware",
      actor: "Snake/EKANS",
      impact: "IT systems across multiple divisions affected, ICS-targeting ransomware variant",
      cost_usd: 75_000_000,
      records_affected: null,
    },
    {
      attack: "Eisai Ransomware",
      company: "Eisai",
      year: 2023,
      vector: "Ransomware",
      actor: "ALPHV/BlackCat",
      impact: "Servers encrypted, logistics in Japan and overseas disrupted, websites and email down",
      cost_usd: 40_000_000,
      records_affected: null,
    },
    {
      attack: "PharMerica Money Message Breach",
      company: "PharMerica",
      year: 2023,
      vector: "Ransomware",
      actor: "Money Message",
      impact: "5.8M patient records compromised — names, SSNs, medications, health insurance data",
      cost_usd: 75_000_000,
      records_affected: 5_800_000,
    },
    {
      attack: "Cencora Patient Data Breach",
      company: "Cencora",
      year: 2024,
      vector: "Data Exfiltration",
      actor: "ALPHV/BlackCat",
      impact: "Personal data stolen from patient support programs for AbbVie, Bayer, Pfizer, Regeneron, Novartis",
      cost_usd: 100_000_000,
      records_affected: null,
    },
    {
      attack: "IQVIA MOVEit Breach",
      company: "IQVIA",
      year: 2023,
      vector: "File Transfer Exploit",
      actor: "CLOP",
      impact: "Largest CRO affected, clinical trial data exposed via MOVEit vulnerability",
      cost_usd: null,
      records_affected: null,
    },
    {
      attack: "HSE Ireland Conti Ransomware",
      company: "Health Service Executive Ireland",
      year: 2021,
      vector: "Ransomware",
      actor: "Conti",
      impact: "Pharmacy services across Ireland disrupted for months",
      cost_usd: 600_000_000,
      records_affected: null,
    },
    {
      attack: "NHS WannaCry Attack",
      company: "NHS",
      year: 2017,
      vector: "Ransomware",
      actor: "Lazarus Group",
      impact: "80+ trusts affected, pharmacy dispensing disrupted nationwide via EternalBlue exploit",
      cost_usd: 120_000_000,
      records_affected: null,
    },
    {
      attack: "Anthem APT Data Breach",
      company: "Anthem",
      year: 2015,
      vector: "APT Espionage",
      actor: "Deep Panda",
      impact: "78.8M records stolen including names, SSNs, medical IDs, pharma benefit claims",
      cost_usd: 375_000_000,
      records_affected: 78_800_000,
    },
    {
      attack: "Ascension Black Basta Ransomware",
      company: "Ascension Health",
      year: 2024,
      vector: "Ransomware",
      actor: "Black Basta",
      impact: "Pharmacy operations severely disrupted at 140 hospitals",
      cost_usd: null,
      records_affected: null,
    },
    {
      attack: "Synnovis Qilin Ransomware",
      company: "Synnovis",
      year: 2024,
      vector: "Ransomware",
      actor: "Qilin",
      impact: "London hospital pathology and pharmacy services crippled for months",
      cost_usd: null,
      records_affected: null,
    },
    {
      attack: "Hammersmith Maze Ransomware",
      company: "Hammersmith Medicines Research",
      year: 2020,
      vector: "Ransomware",
      actor: "Maze",
      impact: "COVID vaccine trial site compromised, patient data published",
      cost_usd: null,
      records_affected: null,
    },
    {
      attack: "Supernus Hive Ransomware",
      company: "Supernus Pharmaceuticals",
      year: 2021,
      vector: "Ransomware",
      actor: "Hive",
      impact: "Internal documents stolen",
      cost_usd: null,
      records_affected: null,
    },
    {
      attack: "Prospect Medical Rhysida Ransomware",
      company: "Prospect Medical Holdings",
      year: 2023,
      vector: "Ransomware",
      actor: "Rhysida",
      impact: "16+ hospitals affected, pharmacies reverted to paper",
      cost_usd: null,
      records_affected: null,
    },
    {
      attack: "Henry Schein BlackCat Ransomware",
      company: "Henry Schein",
      year: 2023,
      vector: "Ransomware",
      actor: "ALPHV/BlackCat",
      impact: "Multiple attacks in 2023-2024, pharma distribution disrupted",
      cost_usd: 50_000_000,
      records_affected: null,
    },
    {
      attack: "Covance SamSam Ransomware",
      company: "Covance",
      year: 2019,
      vector: "Ransomware",
      actor: "SamSam",
      impact: "Clinical testing operations affected",
      cost_usd: null,
      records_affected: null,
    },
    {
      attack: "Sanofi Credential Breach",
      company: "Sanofi",
      year: 2023,
      vector: "Credential Compromise",
      actor: "ALPHV/BlackCat",
      impact: "Research data potentially accessed via compromised credentials",
      cost_usd: null,
      records_affected: null,
    },
    {
      attack: "Octapharma Ransomware",
      company: "Octapharma Plasma",
      year: 2024,
      vector: "Ransomware",
      actor: "Black Basta",
      impact: "190+ plasma donation centers closed temporarily",
      cost_usd: null,
      records_affected: null,
    },
  ];

  for (const a of attacks) {
    // Create Attack node
    await run(
      `MERGE (atk:Attack {name: $attack})
       SET atk.year = $year, atk.impact = $impact,
           atk.cost_usd = $cost_usd, atk.records_affected = $records_affected`,
      { attack: a.attack, year: a.year, impact: a.impact, cost_usd: a.cost_usd, records_affected: a.records_affected }
    );

    // Create Company if not exists
    await run(`MERGE (c:Company {name: $company})`, { company: a.company });

    // Attack → TARGETED → Company
    await run(
      `MATCH (atk:Attack {name: $attack}), (c:Company {name: $company})
       MERGE (atk)-[:TARGETED]->(c)`,
      { attack: a.attack, company: a.company }
    );

    // ThreatActor → PERPETRATED → Attack
    await run(
      `MATCH (t:ThreatActor {name: $actor}), (atk:Attack {name: $attack})
       MERGE (t)-[:PERPETRATED]->(atk)`,
      { actor: a.actor, attack: a.attack }
    );

    // Attack → USED_VECTOR → AttackVector
    await run(
      `MATCH (atk:Attack {name: $attack}), (v:AttackVector {name: $vector})
       MERGE (atk)-[:USED_VECTOR]->(v)`,
      { attack: a.attack, vector: a.vector }
    );
  }
  console.log(`  Created ${attacks.length} attack chains (ThreatActor → Attack → Company)`);

  // ──────────────────────────────────────────────
  // 4. VENDORS AND PRODUCTS
  // ──────────────────────────────────────────────
  console.log("Creating vendors and products...");

  interface VendorProduct {
    vendor: string;
    product: string;
    category: string;
    description: string;
    protects_against: string[];
  }

  const vendorProducts: VendorProduct[] = [
    // Dell
    {
      vendor: "Dell Technologies",
      product: "PowerProtect Cyber Recovery",
      category: "Data Vaulting",
      description: "Air-gapped vault with CyberSense AI analytics, 99.99% ransomware detection confidence",
      protects_against: ["Ransomware", "Data Exfiltration"],
    },
    {
      vendor: "Dell Technologies",
      product: "Secureworks Taegis XDR",
      category: "Managed Detection & Response",
      description: "Cloud-native XDR platform with 24/7 SOC, Counter Threat Unit intelligence",
      protects_against: ["APT Espionage", "Ransomware", "Spear-Phishing", "Credential Compromise"],
    },
    {
      vendor: "Dell Technologies",
      product: "Dell Trusted Device",
      category: "Endpoint Hardware Security",
      description: "SafeBIOS firmware verification, SafeID hardware credential isolation, SafeSupplyChain",
      protects_against: ["Supply Chain Compromise", "APT Espionage"],
    },
    {
      vendor: "Dell Technologies",
      product: "Dell Encryption Enterprise",
      category: "Data Loss Prevention",
      description: "Endpoint encryption, USB encryption, file-level encryption with centralized key management",
      protects_against: ["Data Exfiltration"],
    },
    {
      vendor: "Dell Technologies",
      product: "PowerScale with SmartLock WORM",
      category: "Secure Storage",
      description: "Scale-out NAS with WORM compliance, FIPS 140-2 encryption, anomaly detection",
      protects_against: ["Ransomware", "Data Exfiltration", "Cloud Misconfiguration"],
    },
    {
      vendor: "Dell Technologies",
      product: "VxRail with NSX Microsegmentation",
      category: "Zero Trust Infrastructure",
      description: "HCI with VM-level network segmentation, encrypted vMotion, hardware-attested boot",
      protects_against: ["Ransomware", "APT Espionage", "Credential Compromise"],
    },
    // CrowdStrike
    {
      vendor: "CrowdStrike",
      product: "Falcon XDR",
      category: "Endpoint Detection & Response",
      description: "AI-native endpoint protection with threat hunting and real-time response",
      protects_against: ["Ransomware", "APT Espionage", "Spear-Phishing", "Credential Compromise"],
    },
    {
      vendor: "CrowdStrike",
      product: "Falcon Identity Protection",
      category: "Identity Security",
      description: "Real-time identity threat detection, MFA enforcement, lateral movement prevention",
      protects_against: ["Credential Compromise", "APT Espionage"],
    },
    // Splunk
    {
      vendor: "Splunk",
      product: "Splunk Enterprise Security",
      category: "SIEM",
      description: "Security information and event management with pharma-specific correlation rules",
      protects_against: ["Ransomware", "APT Espionage", "Data Exfiltration", "Credential Compromise"],
    },
    // Palo Alto Networks
    {
      vendor: "Palo Alto Networks",
      product: "Cortex XDR",
      category: "Extended Detection & Response",
      description: "Integrated endpoint, network, and cloud threat detection and response",
      protects_against: ["Ransomware", "APT Espionage", "Zero-Day Exploit", "Spear-Phishing"],
    },
    // NetApp
    {
      vendor: "NetApp",
      product: "NetApp ONTAP Autonomous Ransomware Protection",
      category: "Storage Security",
      description: "AI-driven ransomware detection at the storage layer with automatic snapshots",
      protects_against: ["Ransomware"],
    },
    // Pure Storage / Everpure
    {
      vendor: "Everpure",
      product: "SafeMode Snapshots",
      category: "Immutable Storage",
      description: "Immutable snapshots that cannot be deleted even by administrators",
      protects_against: ["Ransomware", "Data Exfiltration"],
    },
    // HPE
    {
      vendor: "HPE",
      product: "HPE GreenLake for Backup and Recovery",
      category: "Data Protection",
      description: "Cloud-based backup with air-gapped recovery and ransomware detection",
      protects_against: ["Ransomware"],
    },
    // SAP
    {
      vendor: "SAP",
      product: "SAP Enterprise Threat Detection",
      category: "Application Security",
      description: "Real-time threat detection for SAP ERP systems, monitors transactions and user behavior",
      protects_against: ["Credential Compromise", "Data Exfiltration", "APT Espionage"],
    },
  ];

  for (const vp of vendorProducts) {
    // Create Vendor
    await run(`MERGE (v:Vendor {name: $vendor})`, { vendor: vp.vendor });

    // Create Product
    await run(
      `MERGE (p:Product {name: $product})
       SET p.category = $category, p.description = $description`,
      { product: vp.product, category: vp.category, description: vp.description }
    );

    // Vendor → OFFERS → Product
    await run(
      `MATCH (v:Vendor {name: $vendor}), (p:Product {name: $product})
       MERGE (v)-[:OFFERS]->(p)`,
      { vendor: vp.vendor, product: vp.product }
    );

    // Product → PROTECTS_AGAINST → AttackVector
    for (const vecName of vp.protects_against) {
      await run(
        `MATCH (p:Product {name: $product}), (vec:AttackVector {name: $vec})
         MERGE (p)-[:PROTECTS_AGAINST]->(vec)`,
        { product: vp.product, vec: vecName }
      );
    }
  }
  console.log(`  Created ${vendorProducts.length} vendor-product mappings`);

  // ──────────────────────────────────────────────
  // 5. SUMMARY STATS
  // ──────────────────────────────────────────────
  const session = driver.session();
  try {
    const nodeCount = await session.run("MATCH (n) RETURN count(n) AS c");
    const relCount = await session.run("MATCH ()-[r]->() RETURN count(r) AS c");
    const nodes = neo4j.integer.toNumber(nodeCount.records[0].get("c"));
    const rels = neo4j.integer.toNumber(relCount.records[0].get("c"));
    console.log(`\nDone! Neo4j now has ${nodes} nodes and ${rels} relationships.`);

    // Show sample chain
    console.log("\nSample attack chain:");
    const sample = await session.run(
      `MATCH (t:ThreatActor)-[:PERPETRATED]->(a:Attack)-[:TARGETED]->(c:Company)
       WHERE a.cost_usd IS NOT NULL
       RETURN t.name AS actor, a.name AS attack, c.name AS company, a.cost_usd AS cost
       ORDER BY a.cost_usd DESC LIMIT 5`
    );
    for (const record of sample.records) {
      const cost = record.get("cost");
      const costStr = cost ? `$${(Number(cost) / 1_000_000).toFixed(0)}M` : "N/A";
      console.log(`  ${record.get("actor")} → ${record.get("attack")} → ${record.get("company")} (${costStr})`);
    }

    // Show vendor coverage
    console.log("\nVendor product coverage:");
    const vendors = await session.run(
      `MATCH (v:Vendor)-[:OFFERS]->(p:Product)-[:PROTECTS_AGAINST]->(vec:AttackVector)
       RETURN v.name AS vendor, count(DISTINCT p) AS products, count(DISTINCT vec) AS vectors
       ORDER BY products DESC`
    );
    for (const record of vendors.records) {
      console.log(`  ${record.get("vendor")}: ${record.get("products")} products, covers ${record.get("vectors")} attack vectors`);
    }
  } finally {
    await session.close();
  }

  await driver.close();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
