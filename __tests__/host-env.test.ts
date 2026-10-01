import { afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_FIXTURE, hostTestEnv } from "./helpers/host-env.js";

const hostSh = join(process.cwd(), "scripts", "lib", "host.sh");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sourceHost(env: Record<string, string>, print: string[]) {
  const echo = print.map((name) => `echo "${name}=\${${name}-<unset>}"`).join("\n");
  return spawnSync("bash", ["-c", `set -euo pipefail\nsource "$1"\n${echo}`, "bash", hostSh], {
    encoding: "utf-8",
    env: { PATH: "/usr/bin:/bin", HOME: tmpdir(), ...env },
  });
}

describe("scripts/lib/host.sh", () => {
  it("exports ports and resource limits from the host profile", () => {
    const result = sourceHost(hostTestEnv(), ["APP_PORT", "MLX_CHAT_PORT", "JEV_HOST", "JEV_PORT", "MLX_CACHE_LIMIT", "OMLX_CACHE_MAX_GB", "PHARMAITCHAT_HOST_NAME"]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "APP_PORT=3000",
      "MLX_CHAT_PORT=8080",
      "JEV_HOST=127.0.0.1",
      "JEV_PORT=8010",
      "MLX_CACHE_LIMIT=2147483648",
      "OMLX_CACHE_MAX_GB=20",
      "PHARMAITCHAT_HOST_NAME=test-host",
    ]);
  });

  it("keeps a value already set in the environment", () => {
    const result = sourceHost({ ...hostTestEnv(), MLX_CACHE_LIMIT: "123" }, ["MLX_CACHE_LIMIT"]);
    expect(result.stdout.trim()).toBe("MLX_CACHE_LIMIT=123");
  });

  it("exits non-zero and lists the problems when the profile is invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "host-sh-"));
    dirs.push(dir);
    const bad = join(dir, "host.yaml");
    writeFileSync(bad, readFileSync(HOST_FIXTURE, "utf-8").replace("{ port: 8100 }", "{ port: 0 }"));
    const result = sourceHost({ ...hostTestEnv(), PHARMAITCHAT_HOST_CONFIG: bad }, ["APP_PORT"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("endpoints.chromadb.port");
    expect(result.stdout).not.toContain("APP_PORT=");
  });

  it("fails loudly without node", () => {
    const result = sourceHost({ PHARMAITCHAT_HOST_CONFIG: HOST_FIXTURE }, ["APP_PORT"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/node not found/);
  });

  it("works from any working directory", () => {
    const result = spawnSync("bash", ["-c", `cd /\nsource "$1"\necho "$CHROMADB_PORT"`, "bash", hostSh], {
      encoding: "utf-8",
      env: { PATH: "/usr/bin:/bin", HOME: tmpdir(), ...hostTestEnv() },
    });
    expect(result.stdout.trim()).toBe("8100");
  });
});
