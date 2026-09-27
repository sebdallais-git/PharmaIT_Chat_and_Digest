import { afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The jev scorer moved from :8000 to :8010 (config/decide.yaml, run-jev.sh),
// and :8000 now belongs to the Splash stack, but check-services.sh still
// probed 8000: with Splash up and the scorer down it reported the scorer up.
// The port now comes from config/decide.yaml, so the two cannot drift.

const script = readFileSync(join(process.cwd(), "scripts", "check-services.sh"), "utf-8");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function jevPort(decideYaml: string | null): string {
  const project = mkdtempSync(join(tmpdir(), "check-services-"));
  dirs.push(project);
  if (decideYaml !== null) {
    mkdirSync(join(project, "config"));
    writeFileSync(join(project, "config", "decide.yaml"), decideYaml);
  }
  const fn = script.slice(script.indexOf("jev_port() {"), script.indexOf("\n}\n", script.indexOf("jev_port() {")) + 3);
  const result = spawnSync("bash", ["-c", `PROJECT_DIR="$1"\n${fn}\njev_port`, "bash", project], { encoding: "utf-8" });
  return result.stdout.trim();
}

describe("check-services.sh jev scorer port", () => {
  it("reads the port from config/decide.yaml", () => {
    expect(jevPort("model: jev-latest\nbase_url: http://127.0.0.1:8123\ntimeout_ms: 15000\n")).toBe("8123");
  });

  it("matches the port the repo's config actually uses", () => {
    const committed = readFileSync(join(process.cwd(), "config", "decide.yaml"), "utf-8");
    const port = committed.match(/^base_url:\s*http:\/\/[^:]+:(\d+)/m)?.[1];
    expect(port).toBe("8010");
    expect(jevPort(committed)).toBe(port);
  });

  it("falls back to 8010 without a config", () => {
    expect(jevPort(null)).toBe("8010");
  });

  it("probes the scorer on that port, not a fixed one", () => {
    const line = script.split("\n").find((l) => /check_port .*"jev scorer"/.test(l)) ?? "";
    expect(line).toContain("$(jev_port)");
    expect(line).not.toMatch(/check_port 80\d\d /);
  });
});
