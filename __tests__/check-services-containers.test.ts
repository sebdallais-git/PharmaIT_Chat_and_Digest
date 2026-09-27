import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Neo4j and SearXNG moved from Docker Desktop to colima, which the stack's
// launchd job starts (ensure_containers in scripts/lib/services.sh). The
// health check still said the containers "return only if Docker Desktop
// starts at login" and hinted a bare `docker start`, which fails while colima
// is down -- pointing whoever reads it at the wrong runtime.

const script = readFileSync(join(process.cwd(), "scripts", "check-services.sh"), "utf-8");
const lines = script.split("\n");

describe("check-services.sh container section", () => {
  it("names colima, not Docker Desktop", () => {
    const header = lines.find((l) => /^echo "docker containers/.test(l)) ?? "";
    expect(header).toContain("colima");
    expect(script).not.toContain("Docker Desktop");
  });

  it.each(["Neo4j", "SearXNG"])("hints starting colima before the %s container", (name) => {
    const line = lines.find((l) => l.includes(`"${name}"`) && l.startsWith("check_port")) ?? "";
    expect(line).toMatch(/colima start && docker start (neo4j|searxng)/);
  });
});
