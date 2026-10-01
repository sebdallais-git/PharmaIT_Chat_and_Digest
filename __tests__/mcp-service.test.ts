import { afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostTestEnv } from "./helpers/host-env.js";

const projectDir = process.cwd();
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

// A stub that records its environment, arguments and working directory instead of starting the service
function writeStub(dir: string): string {
  const stub = join(dir, "stub-server");
  writeFileSync(
    stub,
    ["#!/bin/bash", 'env > "$STUB_OUT"', 'echo "ARGC=$#" >> "$STUB_OUT"', 'echo "PWD=$(pwd)" >> "$STUB_OUT"'].join("\n")
  );
  chmodSync(stub, 0o755);
  return stub;
}

function runMcp(dir: string, extraEnv: Record<string, string> = {}) {
  const out = join(dir, "stub.out");
  const result = spawnSync("bash", [join(projectDir, "scripts", "run-mcp.sh")], {
    encoding: "utf-8",
    env: {
      ...hostTestEnv(),
      PATH: "/usr/bin:/bin",
      HOME: dir,
      PHARMALLM_RUN_DIR: join(dir, "run"),
      RUN_MCP_EXEC: writeStub(dir),
      STUB_OUT: out,
      ...extraEnv,
    },
  });
  return { result, out: existsSync(out) ? readFileSync(out, "utf-8") : "" };
}

describe("run-mcp.sh", () => {
  it("passes both tokens through the environment only and starts in mcp/", () => {
    const dir = tempDir("run-mcp-");
    mkdirSync(join(dir, "run"));
    writeFileSync(join(dir, "run", "api-token"), "api-secret-123\n");
    writeFileSync(join(dir, "run", "mcp-token"), "mcp-secret-456\n");

    const { result, out } = runMcp(dir);

    expect(result.status).toBe(0);
    expect(out).toContain("PHARMALLM_API_TOKEN=api-secret-123");
    expect(out).toContain("MCP_TOKEN=mcp-secret-456");
    expect(out).toContain("MCP_HOST=127.0.0.1");
    expect(out).toContain("MCP_PORT=3200");
    expect(out).toContain("PHARMALLM_URL=http://localhost:3000");
    expect(out).toContain("ARGC=0");
    expect(out).toContain(`PWD=${join(projectDir, "mcp")}`);
    expect(result.stdout + result.stderr).not.toContain("secret");
  });

  it("refuses a non-loopback host without an MCP token", () => {
    const dir = tempDir("run-mcp-");
    mkdirSync(join(dir, "run"));

    const { result, out } = runMcp(dir, { MCP_HOST: "0.0.0.0" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refusing to listen on 0.0.0.0");
    expect(out).toBe("");
  });

  it("starts on loopback without token files", () => {
    const dir = tempDir("run-mcp-");

    const { result, out } = runMcp(dir);

    expect(result.status).toBe(0);
    expect(out).toContain("MCP_TOKEN=\n");
    expect(out).toContain("PHARMALLM_API_TOKEN=\n");
  });
});

describe("switch-stack.sh mcp commands", () => {
  it("creates a private MCP token once and never overwrites it", () => {
    const dir = tempDir("mcp-token-");
    const run = () =>
      spawnSync("bash", [join(projectDir, "scripts", "switch-stack.sh"), "mcp-token"], {
        encoding: "utf-8",
        env: { ...hostTestEnv(), PATH: "/usr/bin:/bin", HOME: dir, PHARMALLM_RUN_DIR: join(dir, "run") },
      });

    const first = run();
    const tokenFile = join(dir, "run", "mcp-token");
    const token = readFileSync(tokenFile, "utf-8").trim();
    const second = run();

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(tokenFile, "utf-8").trim()).toBe(token);
    expect(first.stdout + second.stdout).not.toContain(token);
  });

  it("manages the launchd service by label and checks its health endpoint", () => {
    const script = readFileSync(join(projectDir, "scripts", "switch-stack.sh"), "utf-8");
    expect(script).toContain('MCP_LABEL="com.pharmaitchat.mcp"');
    expect(script).toContain('launchctl bootstrap "$domain" "$MCP_PLIST"');
    expect(script).toContain('launchctl bootout "$domain/$MCP_LABEL"');
    expect(script).toContain('"http://127.0.0.1:$MCP_PORT/healthz"');
    expect(script).toContain("mcp-token) ensure_mcp_token ;;");
    expect(script).toContain('mcp) mcp_service "${2:-}" ;;');
  });

  it("ships a plist template that runs run-mcp.sh with no secrets", () => {
    const template = readFileSync(join(projectDir, "hermes", "com.pharmaitchat.mcp.plist.template"), "utf-8");
    expect(template).toContain("<string>com.pharmaitchat.mcp</string>");
    expect(template).toContain("<string>__PROJECT_DIR__/scripts/run-mcp.sh</string>");
    expect(template).toContain("<key>NODE_BIN</key><string>__NODE_BIN__</string>");
    // MCP_HOST lives in the plist, not in `launchctl setenv`, so a LAN move survives a reboot
    expect(template).toContain("<key>MCP_HOST</key><string>__MCP_HOST__</string>");
    expect(template).toContain("<key>KeepAlive</key><true/>");
    expect(template).not.toMatch(/TOKEN/);

    const dir = tempDir("plist-");
    const rendered = join(dir, "com.pharmaitchat.mcp.plist");
    writeFileSync(
      rendered,
      template
        .replaceAll("__PROJECT_DIR__", "/tmp/project")
        .replaceAll("__NODE_BIN__", "/tmp/node")
        .replaceAll("__MCP_HOST__", "127.0.0.1")
        .replaceAll("__PATH__", "/usr/bin:/bin")
    );
    const lint = spawnSync("/usr/bin/plutil", ["-lint", rendered], { encoding: "utf-8" });
    expect(lint.status).toBe(0);
  });
});
