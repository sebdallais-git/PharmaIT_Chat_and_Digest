import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

// With Splash the default stack (2026-09-29), check-services.sh reported
// "MLX chat (:8080) DOWN" and "something is down": it probed MLX's chat port
// whatever stack was active. It now asks switch-stack.sh where the active
// stack serves chat, and checks MLX's embedder only for stacks that use it.
describe("check-services.sh model servers follow the active stack", () => {
  function modelPorts(stack: string): string[] {
    const dir = mkdtempSync(join(tmpdir(), "check-stack-"));
    try {
      mkdirSync(join(dir, "data", "run"), { recursive: true });
      mkdirSync(join(dir, "scripts"));
      writeFileSync(join(dir, "data", "run", "active-stack"), `${stack}\n`);
      writeFileSync(join(dir, "scripts", "switch-stack.sh"), `#!/bin/bash
case "$2" in mlx) echo "http://localhost:8080 m" ;; splash) echo "http://localhost:8000 s" ;; ollama) echo "http://localhost:11434 o" ;; omlx) echo "http://localhost:8090 x" ;; esac
`);
      const fn = script.slice(script.indexOf("model_server_checks() {"), script.indexOf("\n}\n", script.indexOf("model_server_checks() {")) + 3);
      const result = spawnSync("bash", ["-c", `PROJECT_DIR="$1"\n${fn}\nmodel_server_checks`, "bash", dir], { encoding: "utf-8" });
      return result.stdout.trim().split("\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("checks Splash's chat port and the MLX embedder it borrows, not MLX chat", () => {
    expect(modelPorts("splash")).toEqual(["8000 splash chat", "8081 MLX embed"]);
  });

  it("checks MLX chat and embed on the MLX stack", () => {
    expect(modelPorts("mlx")).toEqual(["8080 mlx chat", "8081 MLX embed"]);
  });

  it("checks only the one server for stacks that serve their own embeddings", () => {
    expect(modelPorts("ollama")).toEqual(["11434 ollama chat"]);
    expect(modelPorts("omlx")).toEqual(["8090 omlx chat"]);
  });

  it("no longer probes MLX chat unconditionally", () => {
    expect(script).not.toMatch(/check_port 8080 "MLX chat"/);
  });
});
