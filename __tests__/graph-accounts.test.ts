import { readFileSync } from "node:fs";
import { describe, expect, it } from "@jest/globals";
import { NEEDS } from "../src/services/graph-schema.js";
import {
  parseAccounts,
  accountToGraphFacts,
  parseNeedsMap,
  needsMapToGraphFacts,
} from "../src/services/graph-accounts.js";

const yaml = (body: string) => `accounts:\n${body}`;

const roche = yaml(`  roche:
    name: Roche
    aliases: [Genentech]
    needs: [rnd-compute, gxp-compliance]
    incumbents:
      storage-file: [dell]
      compute-standard: [hpe, lenovo]
`);

describe("parseAccounts", () => {
  it("reads accounts, needs and incumbents", () => {
    const [account] = parseAccounts(roche);

    expect(account.id).toBe("roche");
    expect(account.name).toBe("Roche");
    expect(account.needs).toEqual(["rnd-compute", "gxp-compliance"]);
    expect(account.incumbents).toEqual({ "storage-file": ["dell"], "compute-standard": ["hpe", "lenovo"] });
  });

  it("rejects an incumbency in a segment outside the closed set", () => {
    const bad = yaml(`  roche:
    name: Roche
    needs: []
    incumbents:
      storage: [dell]
`);
    expect(() => parseAccounts(bad)).toThrow(/storage/);
  });

  it("rejects a need outside the closed set", () => {
    const bad = yaml(`  roche:
    name: Roche
    needs: [world-peace]
    incumbents: {}
`);
    expect(() => parseAccounts(bad)).toThrow(/world-peace/);
  });

  it("accepts an account with no incumbents recorded yet", () => {
    // Blank is the honest default: a guessed incumbent flips defend into
    // displace while sounding just as confident.
    const blank = yaml(`  sandoz:
    name: Sandoz
    needs: [cost-optimisation]
    incumbents: {}
`);
    expect(parseAccounts(blank)[0].incumbents).toEqual({});
  });

  it("keeps a segment declared with an empty list: nobody installed, not unknown", () => {
    const empty = yaml(`  novartis:
    name: Novartis
    needs: [ai-factory]
    incumbents:
      compute-ai: []
`);
    expect(parseAccounts(empty)[0].incumbents).toEqual({ "compute-ai": [] });
  });

  // A bare key could mean "nobody installed" or "not known yet". Reading it as
  // [] would answer greenfield for a segment the user may not know at all, so
  // it is refused, naming both honest spellings.
  it("refuses a segment key with no list rather than guessing what it means", () => {
    const bare = yaml(`  roche:
    name: Roche
    needs: []
    incumbents:
      compute-ai:
`);
    expect(() => parseAccounts(bare)).toThrow(
      "roche: incumbents.compute-ai must be a list of vendors — [] if nobody is installed, or omit the segment if unknown",
    );
  });

  it("refuses a scalar where a list of vendors belongs", () => {
    const scalar = yaml(`  roche:
    name: Roche
    needs: []
    incumbents:
      compute-ai: unknown
`);
    expect(() => parseAccounts(scalar)).toThrow("roche: incumbents.compute-ai must be a list of vendors");
  });

  const withTriggers = (triggers: string, incumbents = "      storage-block: [everpure]\n") =>
    yaml(`  roche:
    name: Roche
    needs: []
    incumbents:
${incumbents}    triggers:
${triggers}`);

  it("reads a trigger on a segment held by a rival, trimmed", () => {
    const account = parseAccounts(withTriggers('      storage-block: "  everpure arrays reach end of support 2027-03 "\n'))[0];
    expect(account.triggers).toEqual({ "storage-block": "everpure arrays reach end of support 2027-03" });
  });

  it("reads no triggers when the key is absent", () => {
    expect(parseAccounts(roche)[0].triggers).toEqual({});
  });

  it("refuses a trigger on a segment outside the closed set", () => {
    expect(() => parseAccounts(withTriggers('      time-machine: "x"\n'))).toThrow(
      "roche: triggers.time-machine is not a segment",
    );
  });

  it("refuses an empty or non-text trigger", () => {
    const message = "roche: triggers.storage-block must be a non-empty description of the install-base event";
    expect(() => parseAccounts(withTriggers('      storage-block: "  "\n'))).toThrow(message);
    expect(() => parseAccounts(withTriggers("      storage-block: [a, b]\n"))).toThrow(message);
  });

  it("refuses a trigger on a segment with no declared incumbents, empty or omitted", () => {
    const message = "roche: triggers.storage-block opens a segment held by a rival; declare its incumbents first";
    expect(() => parseAccounts(withTriggers('      storage-block: "x"\n', "      storage-block: []\n"))).toThrow(message);
    expect(() => parseAccounts(withTriggers('      storage-block: "x"\n', "      storage-file: [netapp]\n"))).toThrow(message);
  });

  it("refuses a trigger longer than one line of install-base fact", () => {
    // Triggers are never trimmed from answers: an unbounded one would eat the budget.
    expect(() => parseAccounts(withTriggers(`      storage-block: "${"x".repeat(201)}"\n`))).toThrow(
      "roche: triggers.storage-block is longer than 200 characters: an install-base fact fits one line",
    );
  });

  it("refuses triggers written as a list or a scalar", () => {
    const message = "roche: triggers must be a map of segment to description";
    expect(() => parseAccounts(withTriggers("      - storage-block\n"))).toThrow(message);
    const scalar = yaml(`  roche:
    name: Roche
    needs: []
    triggers: soon
`);
    expect(() => parseAccounts(scalar)).toThrow(message);
  });
});

describe("config/accounts.example.yaml", () => {
  // The file users copy is the documentation of omitted vs declared-empty
  // segments; it has to parse, or the first rebuild fails on the example.
  it("shows a trigger on a segment with declared incumbents", () => {
    const roche = parseAccounts(readFileSync("config/accounts.example.yaml", "utf8")).find((a) => a.id === "roche");
    expect(roche?.triggers["storage-block"]).toBe("PowerMax arrays reach end of support 2027-03");
  });

  it("parses, and shows both an omitted and a declared-empty segment", () => {
    const accounts = parseAccounts(readFileSync("config/accounts.example.yaml", "utf8"));
    const roche = accounts.find((a) => a.id === "roche");
    const novartis = accounts.find((a) => a.id === "novartis");

    expect(roche?.incumbents["compute-ai"]).toBeUndefined();
    expect(novartis?.incumbents["compute-ai"]).toEqual([]);
  });
});

describe("accountToGraphFacts", () => {
  it("emits the account, its needs and a USES edge per incumbent", () => {
    const facts = accountToGraphFacts(parseAccounts(roche)[0]);

    expect(facts.nodes.filter((n) => n.label === "Account")).toHaveLength(1);
    expect(facts.nodes.filter((n) => n.label === "Need")).toHaveLength(2);
    expect(facts.relationships.filter((r) => r.type === "HAS_NEED")).toHaveLength(2);
    expect(facts.relationships.filter((r) => r.type === "USES")).toHaveLength(3);
  });

  it("materialises a Vendor node for an incumbent with no brief", () => {
    // Deliberately unlike a competitor named in a brief, which stays a claim.
    // An incumbent is observed reality at the account and must exist whether or
    // not anyone has researched that vendor -- lenovo has no brief.
    const facts = accountToGraphFacts(parseAccounts(roche)[0]);

    expect(facts.nodes.filter((n) => n.label === "Vendor").map((n) => n.id).sort()).toEqual([
      "dell",
      "hpe",
      "lenovo",
    ]);
  });

  it("stores triggers on the account as JSON, quotes and newlines intact, and nothing when there are none", () => {
    const account = parseAccounts(
      yaml(`  roche:
    name: Roche
    needs: []
    incumbents:
      storage-file: [netapp]
      storage-block: [everpure]
    triggers:
      storage-file: "NetApp \\"ONTAP 9\\": renewal 2027-01\\nsecond line"
      storage-block: "end of support"
`),
    )[0];
    const node = accountToGraphFacts(account).nodes.find((n) => n.label === "Account");
    expect(node?.properties.triggers).toBe(
      JSON.stringify({ "storage-block": "end of support", "storage-file": 'NetApp "ONTAP 9": renewal 2027-01\nsecond line' }),
    );
    expect(accountToGraphFacts({ ...account, triggers: {} }).nodes[0].properties).not.toHaveProperty("triggers");
  });

  it("records every declared segment on the account, including an empty one", () => {
    // An omitted segment means "incumbent unknown", a declared empty list
    // "nobody installed". Neither leaves a USES edge, so the account node has to
    // say which segments were declared or both would read as greenfield.
    const account = parseAccounts(
      yaml(`  roche:
    name: Roche
    needs: []
    incumbents:
      storage-file: [netapp]
      compute-ai: []
`),
    )[0];
    const node = accountToGraphFacts(account).nodes.find((n) => n.label === "Account");

    expect(node?.properties.declaredSegments).toBe("compute-ai,storage-file");
    expect(accountToGraphFacts({ ...account, incumbents: {} }).nodes[0].properties.declaredSegments).toBe("");
  });

  it("puts the segment on the USES edge so incumbency is per segment", () => {
    const facts = accountToGraphFacts(parseAccounts(roche)[0]);
    const uses = facts.relationships.filter((r) => r.type === "USES");

    expect(uses.find((r) => r.to === "dell")?.properties.segment).toBe("storage-file");
    expect(uses.filter((r) => r.properties.segment === "compute-standard").map((r) => r.to).sort()).toEqual([
      "hpe",
      "lenovo",
    ]);
  });
});

describe("parseNeedsMap", () => {
  it("maps needs onto the segments that address them", () => {
    const map = parseNeedsMap("needs:\n  rnd-compute: [compute-ai, storage-file]\n");

    expect(map["rnd-compute"]).toEqual(["compute-ai", "storage-file"]);
  });

  it("rejects a segment outside the closed set", () => {
    expect(() => parseNeedsMap("needs:\n  rnd-compute: [storage]\n")).toThrow(/storage/);
  });

  it("rejects a need outside the closed set", () => {
    expect(() => parseNeedsMap("needs:\n  world-peace: [services]\n")).toThrow(/world-peace/);
  });

  it("emits one ADDRESSED_BY edge per need-segment pair", () => {
    const facts = needsMapToGraphFacts(parseNeedsMap("needs:\n  rnd-compute: [compute-ai, storage-file]\n"));

    expect(facts.relationships.filter((r) => r.type === "ADDRESSED_BY")).toHaveLength(2);
    expect(facts.nodes.map((n) => n.label).sort()).toEqual(["Need", "Segment", "Segment"]);
  });
});

describe("the landing page and the model agree", () => {
  // The page advertised six use cases while the model held eight differently
  // named needs, so a visitor asking about SAP or Multi Cloud hit a traversal
  // with nothing to traverse. This keeps the two vocabularies from drifting.
  it("has a need for every use case the page advertises", () => {
    const html = readFileSync("public/index.html", "utf8");
    const line = /<strong>Use cases<\/strong>:\s*([^<]+)</.exec(html);
    expect(line).not.toBeNull();

    const slugs = line![1]
      .split(",")
      .map((s) => s.trim().toLowerCase().replace(/\s+/g, "-"))
      .filter(Boolean);
    expect(slugs.length).toBeGreaterThan(0);

    const missing = slugs.filter((s) => !(NEEDS as readonly string[]).includes(s));
    expect(missing).toEqual([]);
  });
});
