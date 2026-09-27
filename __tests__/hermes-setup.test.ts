import { afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_INGEST_BUDGET_MS } from "../src/services/watchlist-ingest.js";

const projectDir = process.cwd();
// The timeout hermes/cron/jobs.json asks Hermes for, read from the file
// rather than restated, so the two can never drift.
const WATCHLIST_SCRIPT_TIMEOUT_SECONDS = (
  JSON.parse(readFileSync(join(projectDir, "hermes", "cron", "jobs.json"), "utf-8")) as Array<{
    name: string;
    script_timeout_seconds?: number;
  }>
).find((job) => job.name === "pharmaitchat-watchlist-ingest")?.script_timeout_seconds ?? 0;
const dirs: string[] = [];
const API_TOKEN = "api-token-value-1111";
const MCP_TOKEN = "mcp-token-value-2222";
const BOT_TOKEN = "123456:bot-token-value-3333";

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Sandbox {
  root: string;
  home: string;
  runDir: string;
  agentsDir: string;
  calls: string;
  jevDir: string;
}

// Temp HERMES_HOME, run dir with both PharmaITChat/MCP tokens, and stub hermes/launchctl
// that log their arguments. No open-jev venv and no hf-token: the scorer is an optional
// dependency (src/services/health.ts's CRITICAL_CHECKS, scripts/check-services.sh), and
// install_jev_service must SKIP it rather than abort install-services. Building the fixture
// into every sandbox would hide exactly that regression, so the jev prerequisites are opt-in
// via installJevVenv/installJevFixture below, used only by the tests that need the install path.
function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "hermes-setup-"));
  dirs.push(root);
  const home = join(root, "hermes-home");
  const runDir = join(root, "run");
  const agentsDir = join(root, "LaunchAgents");
  const calls = join(root, "calls.log");
  const jevDir = join(root, "open-jev");
  mkdirSync(runDir);
  writeFileSync(join(runDir, "api-token"), `${API_TOKEN}\n`);
  writeFileSync(join(runDir, "mcp-token"), `${MCP_TOKEN}\n`);
  for (const name of ["hermes", "launchctl"]) {
    writeStub(join(root, name), name);
  }
  return { root, home, runDir, agentsDir, calls, jevDir };
}

// Fakes an open-jev checkout: a venv with an executable openjev binary. On its own this is
// still not enough for install_jev_service to take the install path -- hf-token is separate.
function installJevVenv(box: Sandbox): void {
  mkdirSync(join(box.jevDir, ".venv", "bin"), { recursive: true });
  writeFileSync(join(box.jevDir, ".venv", "bin", "openjev"), "#!/bin/bash\nexit 0\n");
  chmodSync(join(box.jevDir, ".venv", "bin", "openjev"), 0o755);
}

// Both jev prerequisites present: install_jev_service takes the install path.
function installJevFixture(box: Sandbox): void {
  writeFileSync(join(box.runDir, "hf-token"), "hf-token-value\n");
  installJevVenv(box);
}

// Logs its arguments to $STUB_CALLS; extra lines let a test decide the exit status
function writeStub(path: string, name: string, extra: string[] = []): void {
  writeFileSync(
    path,
    [
      "#!/bin/bash",
      `printf '${name}' >> "$STUB_CALLS"`,
      `printf ' [%s]' "$@" >> "$STUB_CALLS"`,
      'echo >> "$STUB_CALLS"',
      ...extra,
    ].join("\n")
  );
  chmodSync(path, 0o755);
}

function setup(box: Sandbox, args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync("bash", [join(projectDir, "scripts", "hermes-setup.sh"), ...args], {
    encoding: "utf-8",
    input: "",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: box.root,
      HERMES_HOME: box.home,
      PHARMALLM_RUN_DIR: box.runDir,
      LAUNCH_AGENTS_DIR: box.agentsDir,
      HERMES_BIN: join(box.root, "hermes"),
      LAUNCHCTL_BIN: join(box.root, "launchctl"),
      MCP_HEALTH_URL: "http://127.0.0.1:9/healthz",
      STUB_CALLS: box.calls,
      JEV_DIR: box.jevDir,
      ...extraEnv,
    },
  });
}

function envFile(box: Sandbox): string {
  return readFileSync(join(box.home, ".env"), "utf-8");
}

// A curl that answers /healthz with `body`; the script finds it first via PATH (see stubPath)
function writeCurlStub(box: Sandbox, body: string): void {
  const path = join(box.root, "curl");
  writeFileSync(path, ["#!/bin/bash", "cat <<'HEALTHJSON'", body, "HEALTHJSON"].join("\n"));
  chmodSync(path, 0o755);
}

function stubPath(box: Sandbox): Record<string, string> {
  return { PATH: `${box.root}:/usr/bin:/bin` };
}

describe("hermes-setup.sh install-config", () => {
  it("installs config and SOUL.md and fills a private .env without printing secrets", () => {
    const box = sandbox();

    const result = setup(box, ["install-config"], { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USERS: "424242" });

    expect(result.status).toBe(0);
    expect(readFileSync(join(box.home, "config.yaml"), "utf-8")).toBe(
      readFileSync(join(projectDir, "hermes", "config.template.yaml"), "utf-8")
    );
    expect(existsSync(join(box.home, "SOUL.md"))).toBe(true);
    expect(statSync(join(box.home, ".env")).mode & 0o777).toBe(0o600);
    const env = envFile(box);
    expect(env).toContain(`PHARMAITCHAT_API_TOKEN=${API_TOKEN}`);
    // Legacy alias, kept fresh until the owner retires it: hermes/plugins/pharmaitchat-switch/tap.py
    // still reads only PHARMALLM_API_TOKEN, with no fallback of its own.
    expect(env).toContain(`PHARMALLM_API_TOKEN=${API_TOKEN}`);
    expect(env).toContain(`PHARMALLM_MCP_TOKEN=${MCP_TOKEN}`);
    expect(env).toContain("PHARMALLM_URL=http://localhost:3000");
    expect(env).toContain("PHARMALLM_MCP_URL=http://127.0.0.1:3200/mcp");
    expect(env).toContain("SEARXNG_URL=http://localhost:8888");
    expect(env).toContain(`TELEGRAM_BOT_TOKEN=${BOT_TOKEN}`);
    expect(env).toContain("TELEGRAM_ALLOWED_USERS=424242");
    expect(env).toContain("TELEGRAM_HOME_CHANNEL=424242");
    const output = result.stdout + result.stderr;
    for (const secret of [API_TOKEN, MCP_TOKEN, BOT_TOKEN]) expect(output).not.toContain(secret);
  });

  it("refreshes both the renamed and legacy API token keys on a second install-config (rotation)", () => {
    const box = sandbox();

    setup(box, ["install-config"], { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USERS: "424242" });
    expect(envFile(box)).toContain(`PHARMAITCHAT_API_TOKEN=${API_TOKEN}`);

    // Simulate `scripts/switch-stack.sh token` rotating the token file, then re-running install-config
    // -- the exact cycle the plugin's Telegram buttons depend on staying in sync across.
    const rotated = "rotated-token-value-9999";
    writeFileSync(join(box.runDir, "api-token"), `${rotated}\n`);
    const result = setup(box, ["install-config"], { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USERS: "424242" });

    expect(result.status).toBe(0);
    const env = envFile(box);
    expect(env).toContain(`PHARMAITCHAT_API_TOKEN=${rotated}`);
    expect(env).toContain(`PHARMALLM_API_TOKEN=${rotated}`);
    expect(env).not.toContain(API_TOKEN);
  });

  it("takes only the first allowed user as the home channel", () => {
    const box = sandbox();

    const result = setup(box, ["install-config"], { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USERS: "111,222" });

    expect(result.status).toBe(0);
    const env = envFile(box);
    expect(env).toContain("TELEGRAM_ALLOWED_USERS=111,222");
    expect(env).toContain("TELEGRAM_HOME_CHANNEL=111\n");
  });

  it("replaces .env atomically and leaves no temporary file behind", () => {
    const box = sandbox();

    const result = setup(box, ["install-config"], { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USERS: "424242" });

    expect(result.status).toBe(0);
    expect(readdirSync(box.home).filter((name) => name.startsWith(".env") && name !== ".env")).toEqual([]);
  });

  it("names the token helper when a PharmaITChat token is missing", () => {
    const box = sandbox();
    rmSync(join(box.runDir, "api-token"));

    const result = setup(box, ["install-config"], { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USERS: "424242" });

    expect(result.status).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toContain("Missing PHARMAITCHAT_API_TOKEN");
    expect(output).toContain("scripts/switch-stack.sh token");
  });

  it("keeps existing values on re-run and backs up a changed config", () => {
    const box = sandbox();
    setup(box, ["install-config"], { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USERS: "424242" });
    writeFileSync(join(box.home, "config.yaml"), "edited: true\n");

    const result = setup(box, ["install-config"]);

    expect(result.status).toBe(0);
    expect(envFile(box)).toContain(`TELEGRAM_BOT_TOKEN=${BOT_TOKEN}`);
    expect(envFile(box).match(/^TELEGRAM_BOT_TOKEN=/gm)).toHaveLength(1);
    const backups = readdirSync(box.home).filter((name) => name.startsWith("config.yaml.bak-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(box.home, backups[0]), "utf-8")).toBe("edited: true\n");
  });

  it("fails with instructions when Telegram values are missing and nobody can type them", () => {
    const box = sandbox();

    const result = setup(box, ["install-config"]);

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("Missing TELEGRAM_BOT_TOKEN");
  });
});

describe("hermes-setup.sh install-cron", () => {
  it("creates all five jobs when none exist", () => {
    const box = sandbox();

    const result = setup(box, ["install-cron"]);

    expect(result.status).toBe(0);
    const calls = readFileSync(box.calls, "utf-8").trim().split("\n");
    // 5 jobs plus the one `config set` the script-mode job needs (C1(b)).
    expect(calls).toHaveLength(6);
    expect(calls[0]).toContain("hermes [cron] [create] [0 6 * * *] [Scheduled job: morning news digest.");
    expect(calls[0]).toContain("[--name] [pharmaitchat-news-digest] [--deliver] [telegram]");
    expect(calls[2]).toContain("[--name] [pharmaitchat-health-watch]");
  });

  it("edits jobs that already exist by name instead of duplicating them", () => {
    const box = sandbox();
    mkdirSync(join(box.home, "cron"), { recursive: true });
    writeFileSync(
      join(box.home, "cron", "jobs.json"),
      JSON.stringify({ jobs: [{ id: "abc123", name: "pharmaitchat-health-watch", schedule: "0 9 * * *" }] })
    );

    const result = setup(box, ["install-cron"]);

    expect(result.status).toBe(0);
    const calls = readFileSync(box.calls, "utf-8");
    expect(calls).toContain("hermes [cron] [edit] [abc123] [--schedule] [0 9,19 * * *] [--prompt]");
    // 5 defined, 1 (health-watch) already exists and is edited: the other
    // 3 prompt-mode jobs plus the script-mode watchlist ingest are created.
    expect(calls.match(/\[create\]/g)).toHaveLength(4);
  });

  it("installs the watchlist ingest as a script-mode job: wrapper copied, no LLM step, --deliver local with a Telegram failure override", () => {
    const box = sandbox();

    const result = setup(box, ["install-cron"]);

    expect(result.status).toBe(0);

    // The wrapper is installed into ~/.hermes/scripts (not run from the repo
    // checkout: this file has no other way to find the repo once it lives
    // there), with __PROJECT_DIR__ baked in.
    const scriptPath = join(box.home, "scripts", "pharmaitchat-watchlist-ingest.sh");
    const installed = readFileSync(scriptPath, "utf-8");
    expect(installed).toContain(`PROJECT_DIR="${projectDir}"`);
    expect(installed).not.toContain("__PROJECT_DIR__");
    expect(statSync(scriptPath).mode & 0o111).toBeTruthy(); // executable

    const calls = readFileSync(box.calls, "utf-8").trim().split("\n");
    // No positional prompt, no LLM agent step: --no-agent plus --script,
    // --deliver local (quiet on a normal night) and --failure-deliver
    // telegram (the only case this job should ever speak up).
    expect(calls[5]).toBe(
      "hermes [cron] [create] [30 2 * * *] [--name] [pharmaitchat-watchlist-ingest] " +
        "[--script] [pharmaitchat-watchlist-ingest.sh] [--no-agent] [--deliver] [local] [--failure-deliver] [telegram]",
    );
  });

  // C1(b): Hermes kills a --no-agent script's process group at
  // cron.script_timeout_seconds (3600 s by default), which is inside the
  // nightly ingest's own working range -- the kill would land mid-run, skip
  // finishRun and leave an unfinished run row plus a nightly failure alert.
  // The config key is the mechanism that works: HERMES_CRON_SCRIPT_TIMEOUT is
  // read from the scheduler's environment, not the job's.
  it("raises Hermes' no-agent script timeout before installing the job, so the external kill sits far above our own budget", () => {
    const box = sandbox();

    const result = setup(box, ["install-cron"]);

    expect(result.status).toBe(0);
    const calls = readFileSync(box.calls, "utf-8").trim().split("\n");
    expect(calls[4]).toBe(`hermes [config] [set] [cron.script_timeout_seconds] [${WATCHLIST_SCRIPT_TIMEOUT_SECONDS}]`);
    // Set before the job is created, so the job never exists under the 3600 s default.
    expect(calls[5]).toContain("[--name] [pharmaitchat-watchlist-ingest]");
    expect(WATCHLIST_SCRIPT_TIMEOUT_SECONDS * 1000).toBeGreaterThan(DEFAULT_INGEST_BUDGET_MS);
  });
});

// I6: the wrapper Hermes actually runs. stdout must stay empty on a
// successful night -- that silence is what makes --no-agent report only
// failures -- but the run's own output (per-feed lines, anomalies, the stack
// name) has to survive somewhere, and on a successful run nothing else keeps
// it. The wrapper is exercised here for real, with a stub `npx` on PATH: no
// tsx, no model, no network, no ~/.hermes.
describe("hermes/scripts/pharmaitchat-watchlist-ingest.sh", () => {
  interface WrapperBox {
    tempProject: string;
    script: string;
    binDir: string;
  }

  // An `npx` that prints what the ingest would have printed and exits with
  // its status. Nothing else on PATH can reach tsx, a model or the network.
  function stubIngest(box: WrapperBox, stdout: string, exitCode: number): void {
    const npx = join(box.binDir, "npx");
    writeFileSync(npx, ["#!/bin/bash", "cat <<'INGESTOUT'", stdout, "INGESTOUT", `exit ${exitCode}`].join("\n"));
    chmodSync(npx, 0o755);
  }

  // Copies the wrapper into a temp project with __PROJECT_DIR__ baked in,
  // exactly as install-cron does, and stubs the `npx` it calls.
  function wrapperBox(stdout: string, exitCode: number): WrapperBox {
    const root = mkdtempSync(join(tmpdir(), "watchlist-wrapper-"));
    dirs.push(root);
    const tempProject = join(root, "project");
    const binDir = join(root, "bin");
    mkdirSync(tempProject);
    mkdirSync(binDir);

    const template = readFileSync(join(projectDir, "hermes", "scripts", "pharmaitchat-watchlist-ingest.sh"), "utf-8");
    const script = join(root, "pharmaitchat-watchlist-ingest.sh");
    writeFileSync(script, template.replace(/__PROJECT_DIR__/g, tempProject));

    const box: WrapperBox = { tempProject, script, binDir };
    stubIngest(box, stdout, exitCode);
    return box;
  }

  function runWrapper(box: WrapperBox) {
    return spawnSync("bash", [box.script], {
      encoding: "utf-8",
      env: { PATH: `${box.binDir}:/usr/bin:/bin`, HOME: box.tempProject },
    });
  }

  function logPath(box: WrapperBox): string {
    const today = new Date();
    const stamp = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, "0"),
      String(today.getDate()).padStart(2, "0"),
    ].join("-");
    return join(box.tempProject, "data", "logs", `watchlist-ingest-${stamp}.log`);
  }

  it("keeps the whole run in a dated log while staying silent on stdout", () => {
    const box = wrapperBox("Using stack: mlx\nRoche (rss): 3 items\nIngest run #7: fetched=3 stored=3", 0);

    const result = runWrapper(box);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(""); // --no-agent delivers stdout verbatim: silence means a quiet night
    const log = readFileSync(logPath(box), "utf-8");
    expect(log).toContain("Using stack: mlx");
    expect(log).toContain("Roche (rss): 3 items");
    expect(log).toContain("Ingest run #7: fetched=3 stored=3");
  });

  it("still reports a failed run on stdout, with the same lines kept in the log", () => {
    const box = wrapperBox("Using stack: mlx\nEvery feed failed (4/4) -- treating this run as a failure.", 1);

    const result = runWrapper(box);

    // pipefail, not tee's exit status: appending to the log must not turn a
    // failed run into a successful one.
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("watchlist ingest failed (exit 1)");
    expect(result.stdout).toContain("Every feed failed (4/4)");
    expect(readFileSync(logPath(box), "utf-8")).toContain("Every feed failed (4/4)");
  });

  it("appends to the day's log instead of overwriting it", () => {
    // Two runs on one day (a manual re-run after a failure, say) must both
    // be readable afterwards.
    const box = wrapperBox("first run output", 0);
    expect(runWrapper(box).status).toBe(0);

    stubIngest(box, "second run output", 0);
    expect(runWrapper(box).status).toBe(0);

    const log = readFileSync(logPath(box), "utf-8");
    expect(log).toContain("first run output");
    expect(log).toContain("second run output");
  });
});

describe("hermes-setup.sh install-services", () => {
  it("renders the MCP plist with node's path, loads it and installs the gateway", () => {
    const box = sandbox();
    installJevFixture(box);

    const result = setup(box, ["install-services"], { NODE_BIN: "/opt/fake/bin/node" });

    expect(result.status).toBe(0);
    const plist = readFileSync(join(box.agentsDir, "com.pharmaitchat.mcp.plist"), "utf-8");
    expect(plist).toContain("<key>NODE_BIN</key><string>/opt/fake/bin/node</string>");
    expect(plist).toContain(`<string>${projectDir}/scripts/run-mcp.sh</string>`);
    expect(plist).not.toContain("__");
    expect(plist).not.toContain(MCP_TOKEN);
    const jevPlist = readFileSync(join(box.agentsDir, "com.pharmaitchat.jev.plist"), "utf-8");
    expect(jevPlist).toContain(`<string>${projectDir}/scripts/run-jev.sh</string>`);
    expect(jevPlist).toContain(`<key>JEV_DIR</key><string>${box.jevDir}</string>`);
    expect(jevPlist).not.toContain("__");
    const calls = readFileSync(box.calls, "utf-8");
    expect(calls).toMatch(/launchctl \[bootstrap\] \[gui\/\d+\] \[.*com\.pharmaitchat\.mcp\.plist\]/);
    expect(calls).toMatch(/launchctl \[bootstrap\] \[gui\/\d+\] \[.*com\.pharmaitchat\.jev\.plist\]/);
    expect(calls).toContain("hermes [gateway] [install] [--force] [--start-now] [--start-on-login]");
  });

  // The skip paths return 0, but a failing bootstrap still called `exit 1`. It
  // runs before the gateway install, so a bad jev plist or a stuck launchd
  // teardown left Telegram uninstalled, for a scorer that is optional.
  it("installs the gateway even when the scorer's launchd job will not bootstrap", () => {
    const box = sandbox();
    installJevFixture(box);
    writeStub(join(box.root, "launchctl"), "launchctl", [
      'if [ "$1" = bootstrap ] && [[ "$3" == *com.pharmaitchat.jev.plist ]]; then exit 5; fi',
      "exit 0",
    ]);

    const result = setup(box, ["install-services"], { NODE_BIN: "/opt/fake/bin/node" });

    expect(result.status).toBe(0);
    const calls = readFileSync(box.calls, "utf-8");
    expect(calls).toContain("hermes [gateway] [install] [--force] [--start-now] [--start-on-login]");
    expect(result.stdout + result.stderr).toMatch(/jev.*optional|optional.*jev/i);
  }, 30000);

  // Regression test for the reported bug: install_jev_service used to `exit 1` here under
  // set -euo pipefail, so install-services installed MCP and n8n and then hard-aborted,
  // never reaching the Hermes gateway install. The scorer is optional (src/services/health.ts
  // keeps it out of CRITICAL_CHECKS, src/api/dashboard.ts:94, scripts/check-services.sh's
  // "chat is unaffected" hint) so a missing prerequisite must SKIP the scorer, not the installer.
  it("installs every other service, including the gateway, when open-jev is not checked out at all (regression: scorer is optional)", () => {
    const box = sandbox(); // no jev fixture: this is the machine's actual state

    const result = setup(box, ["install-services"], { NODE_BIN: "/opt/fake/bin/node" });

    expect(result.status).toBe(0);
    expect(existsSync(join(box.agentsDir, "com.pharmaitchat.jev.plist"))).toBe(false);
    const calls = readFileSync(box.calls, "utf-8");
    expect(calls).toMatch(/launchctl \[bootstrap\] \[gui\/\d+\] \[.*com\.pharmaitchat\.mcp\.plist\]/);
    expect(calls).toMatch(/launchctl \[bootstrap\] \[gui\/\d+\] \[.*com\.pharmaitchat\.n8n\.plist\]/);
    expect(calls).toContain("hermes [gateway] [install] [--force] [--start-now] [--start-on-login]");
    const output = result.stdout + result.stderr;
    expect(output).toContain(box.jevDir);
    expect(output).toContain("make setup");
  });

  it("skips the jev scorer but still installs the gateway when the Hugging Face token is missing", () => {
    const box = sandbox();
    installJevVenv(box); // open-jev checked out, but no hf-token

    const result = setup(box, ["install-services"], { NODE_BIN: "/opt/fake/bin/node" });

    expect(result.status).toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toContain("hf-token");
    expect(existsSync(join(box.agentsDir, "com.pharmaitchat.jev.plist"))).toBe(false);
    const calls = readFileSync(box.calls, "utf-8");
    expect(calls).toContain("hermes [gateway] [install]");
  });

  it("bakes MCP_HOST into the plist so a LAN move survives a reboot", () => {
    const box = sandbox();

    // launchctl setenv is domain-wide and lost on reboot; the plist is what persists
    const result = setup(box, ["install-services"], { NODE_BIN: "/opt/fake/bin/node", MCP_HOST: "0.0.0.0" });

    expect(result.status).toBe(0);
    const plist = readFileSync(join(box.agentsDir, "com.pharmaitchat.mcp.plist"), "utf-8");
    expect(plist).toContain("<key>MCP_HOST</key><string>0.0.0.0</string>");
    expect(plist).not.toContain("__");
  });

  it("defaults MCP_HOST to loopback when it is unset", () => {
    const box = sandbox();

    const result = setup(box, ["install-services"], { NODE_BIN: "/opt/fake/bin/node" });

    expect(result.status).toBe(0);
    const plist = readFileSync(join(box.agentsDir, "com.pharmaitchat.mcp.plist"), "utf-8");
    expect(plist).toContain("<key>MCP_HOST</key><string>127.0.0.1</string>");
  });

  it(
    "bootstraps the gateway itself when hermes' own installer left it unloaded",
    () => {
      const box = sandbox();
      // hermes gateway install bootstraps once and gives up, leaving an
      // unsupervised background process that nothing revives. `launchctl print`
      // failing for the gateway label is how this script detects that.
      writeStub(join(box.root, "launchctl"), "launchctl", [
        'case "$1 $2" in',
        '  "print "*ai.hermes.gateway) exit 1 ;;',
        "esac",
        "exit 0",
      ]);
      mkdirSync(box.agentsDir, { recursive: true });
      writeFileSync(join(box.agentsDir, "ai.hermes.gateway.plist"), "<plist/>");

      const result = setup(box, ["install-services"], { NODE_BIN: "/opt/fake/bin/node" });

      expect(result.status).toBe(0);
      const calls = readFileSync(box.calls, "utf-8");
      expect(calls).toMatch(/\[bootstrap\].*ai\.hermes\.gateway\.plist/);
      // The unsupervised process must be stopped first, or two gateways race
      // for the same Telegram token.
      expect(calls).toContain("hermes [gateway] [stop]");
    },
    30_000
  );

  it(
    "retries a bootstrap that fails right after bootout",
    () => {
      const box = sandbox();
      // launchd answers "Input/output error" on the first bootstraps after a bootout
      writeStub(join(box.root, "launchctl"), "launchctl", [
        'case "$1" in',
        '  bootstrap) [ "$(grep -c "\\[bootstrap\\]" "$STUB_CALLS")" -ge 3 ] || exit 1 ;;',
        "esac",
        "exit 0",
      ]);

      const result = setup(box, ["install-services"], { NODE_BIN: "/opt/fake/bin/node" });

      expect(result.status).toBe(0);
      const calls = readFileSync(box.calls, "utf-8");
      // Three bootstraps for the MCP plist -- two rejections then success --
      // plus one for the n8n plist, which is bootstrapped after it. Counted per
      // service rather than in total, so the retry still has to be a retry.
      expect(calls.match(/\[bootstrap\].*com\.pharmaitchat\.mcp\.plist/g)).toHaveLength(3);
      expect(calls.match(/\[bootstrap\].*com\.pharmaitchat\.n8n\.plist/g)).toHaveLength(1);
      expect(calls).toContain("hermes [gateway] [install]");
    },
    30_000
  );
});

describe("hermes-setup.sh all", () => {
  it("stops before touching services when install-config fails", () => {
    const box = sandbox();

    const result = setup(box, ["all"]);

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("Missing TELEGRAM_BOT_TOKEN");
    expect(existsSync(box.calls)).toBe(false);
  });
});

describe("hermes-setup.sh install-plugin", () => {
  it("copies only the plugin's own files, enables it and restarts the gateway", () => {
    const box = sandbox();

    const result = setup(box, ["install-plugin"]);

    expect(result.status).toBe(0);
    const dest = join(box.home, "plugins", "pharmaitchat-switch");
    expect(readdirSync(dest).sort()).toEqual(["__init__.py", "plugin.yaml", "tap.py"]);
    const calls = readFileSync(box.calls, "utf-8");
    // --no-allow-tool-override answers Hermes' y/N tool-override prompt, which would otherwise block
    expect(calls).toContain("hermes [plugins] [enable] [pharmaitchat-switch] [--no-allow-tool-override]");
    expect(calls).toContain("hermes [gateway] [restart]");
    expect(calls.indexOf("[plugins] [enable]")).toBeLessThan(calls.indexOf("[gateway] [restart]"));
  });
});

describe("hermes-setup.sh check: plugin", () => {
  function checkOutput(box: Sandbox): string {
    setup(box, ["install-config"], { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USERS: "424242" });
    const result = setup(box, ["check"]);
    return result.stdout + result.stderr;
  }

  it("reports the plugin as missing before install-plugin", () => {
    expect(checkOutput(sandbox())).toContain("plugin pharmaitchat-switch: missing");
  });

  function writeRecords(box: Sandbox, gateway: unknown, ready: unknown): void {
    mkdirSync(box.home, { recursive: true });
    writeFileSync(join(box.home, "gateway.pid"), JSON.stringify(gateway));
    writeFileSync(join(box.home, "pharmaitchat-switch.ready.json"), JSON.stringify(ready));
  }

  function isLive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error: unknown) {
      return error instanceof Error && "code" in error && error.code === "EPERM";
    }
  }

  it("reports a plugin loaded by the running gateway only when pid and start time both match", () => {
    const box = sandbox();
    setup(box, ["install-plugin"]);
    // check probes the pid, so it has to name a live process: Jest's own
    const pid = process.pid;
    writeRecords(box, { pid, start_time: 777, kind: "hermes-gateway" }, { pid, start_time: 777 });
    expect(checkOutput(box)).toContain("plugin pharmaitchat-switch: loaded by the running gateway");

    writeRecords(box, { pid, start_time: 777, kind: "hermes-gateway" }, { pid, start_time: 1 });
    expect(checkOutput(box)).toContain("plugin pharmaitchat-switch: installed, waiting for a gateway restart");
  });

  it("does not report a plugin loaded when the gateway process is gone", () => {
    const box = sandbox();
    setup(box, ["install-plugin"]);
    const pid = 999999999;
    expect(isLive(pid)).toBe(false);
    writeRecords(box, { pid, start_time: 777, kind: "hermes-gateway" }, { pid, start_time: 777 });
    expect(checkOutput(box)).toContain("plugin pharmaitchat-switch: installed, waiting for a gateway restart");
  });

  it("treats a ready file that is not a JSON object as not loaded, without a traceback", () => {
    const box = sandbox();
    setup(box, ["install-plugin"]);
    writeRecords(box, { pid: process.pid, start_time: 777, kind: "hermes-gateway" }, [process.pid, 777]);
    const output = checkOutput(box);
    expect(output).toContain("plugin pharmaitchat-switch: installed, waiting for a gateway restart");
    expect(output).not.toContain("Traceback");
  });
});

describe("hermes-setup.sh check", () => {
  it("reports variable names without printing their values", () => {
    const box = sandbox();
    setup(box, ["install-config"], { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USERS: "424242" });

    const result = setup(box, ["check"]);

    const output = result.stdout + result.stderr;
    expect(output).toContain("TELEGRAM_BOT_TOKEN: set");
    expect(output).toContain("PHARMAITCHAT_API_TOKEN: set");
    expect(output).toContain("PHARMALLM_MCP_TOKEN: set");
    expect(output).toContain(".env permissions: 600");
    for (const secret of [API_TOKEN, MCP_TOKEN, BOT_TOKEN, "424242"]) expect(output).not.toContain(secret);
  });

  it("finds services loaded in the user domain as well as gui", () => {
    const box = sandbox();
    // `hermes gateway install` loads ai.hermes.gateway in user/$UID, not gui/$UID
    writeStub(join(box.root, "launchctl"), "launchctl", ['case "${2:-}" in user/*) exit 0 ;; esac', "exit 1"]);
    setup(box, ["install-config"], { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USERS: "424242" });

    const result = setup(box, ["check"]);

    const output = result.stdout + result.stderr;
    expect(output).toContain("service com.pharmaitchat.mcp: loaded");
    expect(output).toContain("service ai.hermes.gateway: loaded");
    expect(output).not.toContain("not loaded");
  });

  it("calls the MCP service healthy only when PharmaITChat behind it answers", () => {
    const box = sandbox();
    setup(box, ["install-config"], { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USERS: "424242" });
    writeCurlStub(box, '{"ok":true,"pharmaitchat":true}');

    const result = setup(box, ["check"], stubPath(box));

    const output = result.stdout + result.stderr;
    expect(output).toContain("pharmaitchat-mcp: healthy");
    expect(output).not.toContain("PharmaITChat not reachable");
  });

  it("reports a problem when the MCP service is up but the app behind it is down", () => {
    const box = sandbox();
    setup(box, ["install-config"], { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USERS: "424242" });
    // /healthz answers 200 with pharmaitchat:false while the app is stopped — a 200 alone means nothing
    writeCurlStub(box, '{"ok":true,"pharmaitchat":false}');

    const result = setup(box, ["check"], stubPath(box));

    expect(result.status).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toContain("pharmaitchat-mcp: up, PharmaITChat not reachable");
    expect(output).not.toContain("pharmaitchat-mcp: healthy");
  });

  it("reports the MCP service as not answering when nothing listens", () => {
    const box = sandbox();
    setup(box, ["install-config"], { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USERS: "424242" });

    // MCP_HEALTH_URL points at port 9, which refuses the connection
    const result = setup(box, ["check"]);

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("pharmaitchat-mcp: not answering");
  });
});
