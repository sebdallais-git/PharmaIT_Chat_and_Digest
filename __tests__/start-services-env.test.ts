import { afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Two scripts start the app: switch-stack.sh (after a stack switch) and
// start-services.sh (at login, from the com.pharmaitchat.stack launchd job).
// Each lists the app's environment by hand, and they drifted: only
// switch-stack.sh passed the Telegram credentials. Once launchd became what
// starts the app, the UI's stack selector went dead ("telegram_configured":
// false) from 2026-09-27 06:27 until this fix.

const scriptsDir = join(process.cwd(), "scripts");
const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stub(path: string, body: string): void {
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
}

// Runs start-services.sh with every service stubbed out; the fake npx prints
// what the app would have been given instead of starting it
function startServices(files: Record<string, string>): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), "start-services-env-"));
  tempDirs.push(root);
  const scripts = join(root, "scripts");
  const bin = join(root, "bin");
  const run = join(root, "data", "run");
  for (const dir of [join(scripts, "lib"), bin, run]) mkdirSync(dir, { recursive: true });
  copyFileSync(join(scriptsDir, "start-services.sh"), join(scripts, "start-services.sh"));
  writeFileSync(join(scripts, "lib", "services.sh"), 'CHROMA_URL="http://localhost:8100"\nN8N_PORT=5678\nPHARMAITCHAT_HOST_ADDRESS=localhost\nlog() { :; }\nensure_chromadb() { :; }\nensure_containers() { :; }\n');
  stub(join(scripts, "switch-stack.sh"), "exit 0");
  stub(join(bin, "npx"), 'echo "BOT=${TELEGRAM_BOT_TOKEN-<unset>}"\necho "CHAT=${TELEGRAM_CHAT_ID-<unset>}"');
  writeFileSync(join(run, "active-stack"), "mlx\n");
  for (const [name, body] of Object.entries(files)) writeFileSync(join(run, name), body);
  const result = spawnSync("bash", [join(scripts, "start-services.sh")], {
    encoding: "utf-8",
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root },
  });
  expect(result.status).toBe(0);
  return Object.fromEntries(
    result.stdout.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

describe("start-services.sh gives the app its Telegram credentials", () => {
  it("reads them from data/run, as switch-stack.sh does, trimming the newline", () => {
    const env = startServices({ "telegram-bot-token": "123:abc\n", "telegram-chat-id": "42\n" });
    expect(env.BOT).toBe("123:abc");
    expect(env.CHAT).toBe("42");
  });

  it("still starts the app on a machine with no Telegram set up", () => {
    const env = startServices({});
    expect(env.BOT).toBe("<unset>");
    expect(env.CHAT).toBe("<unset>");
  });
});

describe("both app launchers give the app the same environment", () => {
  // The variables switch-stack.sh's start_app sets on the app's command line
  function switchStackVars(): string[] {
    const script = readFileSync(join(scriptsDir, "switch-stack.sh"), "utf-8");
    const body = script.slice(script.indexOf("start_app() {"), script.indexOf("nohup npx tsx src/server.ts"));
    return [...body.matchAll(/\b([A-Z][A-Z0-9_]+)="/g)].map((m) => m[1]);
  }

  it("start-services.sh exports every variable switch-stack.sh passes", () => {
    const startServicesScript = readFileSync(join(scriptsDir, "start-services.sh"), "utf-8");
    const vars = switchStackVars();
    expect(vars).toEqual(expect.arrayContaining(["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "N8N_WEBHOOK_URL"]));
    for (const name of vars) {
      expect({ name, exported: new RegExp(`export ${name}=`).test(startServicesScript) }).toEqual({ name, exported: true });
    }
  });
});

// The health check said "all good" for the whole time the selector was dead:
// it now asks the app whether a UI stack switch could go through, and why not
describe("check-services.sh reports whether a UI stack switch can go through", () => {
  const script = readFileSync(join(scriptsDir, "check-services.sh"), "utf-8");

  it("asks /api/stack/status and names the result", () => {
    expect(script).toContain("/api/stack/status");
    expect(script).toMatch(/"UI stack switch/);
    expect(script).toMatch(/telegram_configured/);
    expect(script).toMatch(/hermes_ready/);
  });

  // A token on a command line is readable by every process on the machine
  it("sends the API token on stdin, never as a curl argument", () => {
    for (const line of script.split("\n").filter((l) => l.includes("Authorization: Bearer"))) {
      expect(line).not.toMatch(/-H "Authorization/);
    }
  });
});
