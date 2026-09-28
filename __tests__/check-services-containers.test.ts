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

// The app, the model servers, ChromaDB and the scorer are started by
// start-services.sh from the com.pharmaitchat.stack launchd job (RunAtLoad,
// KeepAlive); the heading still said "nothing restarts these".
describe("check-services.sh section for the app and models", () => {
  it("names the launchd job that starts them", () => {
    const header = lines.find((l) => /^echo "started by scripts\/start-services\.sh/.test(l)) ?? "";
    expect(header).toContain("com.pharmaitchat.stack");
    expect(script).not.toContain("nothing restarts these");
  });
});
