import { afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The gap loop has two halves that launchd starts separately: the app, which
// calls n8n's webhook when it finds a gap, and n8n, which calls the app's
// protected routes back. Under launchd neither half was told about the other,
// so from 2026-09-22 every gap was logged as "N8N_WEBHOOK_URL not set".

const scriptsDir = join(process.cwd(), "scripts");

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox(): { root: string; scripts: string; bin: string; run: string } {
  const root = mkdtempSync(join(tmpdir(), "n8n-wiring-test-"));
  tempDirs.push(root);
  const scripts = join(root, "scripts");
  const bin = join(root, "bin");
  const run = join(root, "data", "run");
  for (const dir of [scripts, join(scripts, "lib"), bin, run]) mkdirSync(dir, { recursive: true });
  return { root, scripts, bin, run };
}

function stub(path: string, body: string): void {
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
}

// Prints the variables under test instead of starting anything
const PRINT_ENV = `echo "ARGS=$*"
echo "TOKEN=\${PHARMALLM_API_TOKEN-<unset>}"
echo "BLOCK_ENV=\${N8N_BLOCK_ENV_ACCESS_IN_NODE-<unset>}"
echo "WEBHOOK=\${N8N_WEBHOOK_URL-<unset>}"`;

function lines(stdout: string): Record<string, string> {
  return Object.fromEntries(
    stdout.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

describe("run-n8n.sh", () => {
  function runN8n(token: string | null) {
    const box = sandbox();
    copyFileSync(join(scriptsDir, "run-n8n.sh"), join(box.scripts, "run-n8n.sh"));
    if (token !== null) writeFileSync(join(box.run, "api-token"), `${token}\n`);
    const n8n = join(box.bin, "n8n");
    stub(n8n, PRINT_ENV);
    const result = spawnSync("bash", [join(box.scripts, "run-n8n.sh")], {
      encoding: "utf-8",
      env: { PATH: "/usr/bin:/bin", HOME: box.root, N8N_BIN: n8n },
    });
    return { result, env: lines(result.stdout) };
  }

  it("hands n8n the app's API token through the environment, never as an argument", () => {
    const { result, env } = runN8n("tok-123");
    expect(result.status).toBe(0);
    expect(env.TOKEN).toBe("tok-123");
    expect(env.ARGS).toBe("start");
  });

  it("lets workflow expressions read it, which n8n 2.x blocks by default", () => {
    // The workflows send `Bearer {{ $env.PHARMALLM_API_TOKEN }}`; with env
    // access blocked that expression is empty and every call back is a 401.
    const { env } = runN8n("tok-123");
    expect(env.BLOCK_ENV).toBe("false");
  });

  it("still starts when no API token exists", () => {
    const { result, env } = runN8n(null);
    expect(result.status).toBe(0);
    expect(env.TOKEN).toBe("");
  });
});

describe("start-services.sh", () => {
  function startServices(extraEnv: Record<string, string> = {}) {
    const box = sandbox();
    copyFileSync(join(scriptsDir, "start-services.sh"), join(box.scripts, "start-services.sh"));
    // Stand-ins for everything it starts: no ChromaDB, no stack, no app
    writeFileSync(join(box.scripts, "lib", "services.sh"), 'CHROMA_URL="http://localhost:8100"\nlog() { :; }\nensure_chromadb() { :; }\nensure_containers() { :; }\n');
    stub(join(box.scripts, "switch-stack.sh"), "exit 0");
    stub(join(box.bin, "npx"), PRINT_ENV);
    writeFileSync(join(box.run, "active-stack"), "mlx\n");
    const result = spawnSync("bash", [join(box.scripts, "start-services.sh")], {
      encoding: "utf-8",
      env: { PATH: `${box.bin}:/usr/bin:/bin`, HOME: box.root, ...extraEnv },
    });
    return { result, env: lines(result.stdout) };
  }

  it("points the app's gap detector at the n8n webhook", () => {
    const { result, env } = startServices();
    expect(result.status).toBe(0);
    expect(env.WEBHOOK).toBe("http://localhost:5678/webhook/knowledge-gap");
  });

  it("keeps a webhook URL that was set explicitly", () => {
    const { env } = startServices({ N8N_WEBHOOK_URL: "http://elsewhere:9999/webhook/x" });
    expect(env.WEBHOOK).toBe("http://elsewhere:9999/webhook/x");
  });
});
