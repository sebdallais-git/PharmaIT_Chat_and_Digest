import { afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStacks } from "../src/config/llm-stacks.js";

const scriptsDir = join(process.cwd(), "scripts");
const switchStack = readFileSync(join(scriptsDir, "switch-stack.sh"), "utf-8");

function shellVar(name: string): string {
  const match = switchStack.match(new RegExp(`^${name}="([^"]+)"$`, "m"));
  if (!match) throw new Error(`${name} not found in switch-stack.sh`);
  return match[1];
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "watchdog-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("switch-stack.sh chat-endpoint", () => {
  // Read-only: prints where a stack serves chat, so the watchdog probes the same
  // server the stack actually runs instead of a port it assumes.
  function chatEndpoint(stack: string) {
    return spawnSync("bash", [join(scriptsDir, "switch-stack.sh"), "chat-endpoint", stack], {
      encoding: "utf-8",
      env: { ...process.env, PHARMALLM_RUN_DIR: tempDir() },
    });
  }

  it("prints the port and model each stack serves chat on", () => {
    expect(chatEndpoint("mlx").stdout.trim()).toBe(
      `http://localhost:${shellVar("MLX_CHAT_PORT")} ${shellVar("MLX_CHAT_MODEL")}`,
    );
    expect(chatEndpoint("omlx").stdout.trim()).toBe(
      `http://localhost:${shellVar("OMLX_PORT")} ${shellVar("OMLX_CHAT_MODEL")}`,
    );
    const { splash } = buildStacks({});
    expect(chatEndpoint("splash").stdout.trim()).toBe(`${splash.chatBaseUrl} ${splash.chatModel}`);
    expect(chatEndpoint("ollama").stdout.trim()).toBe(
      `http://localhost:${shellVar("OLLAMA_PORT")} ${shellVar("OLLAMA_CHAT_MODEL")}`,
    );
  });

  it("rejects an unknown stack", () => {
    const result = chatEndpoint("nonsense");
    expect(result.status).not.toBe(0);
    expect(result.stdout.trim()).toBe("");
  });
});

describe("mlx-watchdog.sh", () => {
  // Runs a copy of the watchdog in a sandbox whose switch-stack.sh, curl, lsof,
  // kill and pgrep are recorders: no real port is probed, no process is killed
  // and no stack is started, even on the restart path.
  function runWatchdog(opts: { stack: string; httpCode: string; priorStrikes?: number; cpu?: string; lsof?: (root: string) => string }) {
    const root = tempDir();
    const scripts = join(root, "scripts");
    const bin = join(root, "bin");
    const run = join(root, "run");
    const calls = join(root, "calls.log");
    for (const dir of [scripts, bin, run]) mkdirSync(dir);
    copyFileSync(join(scriptsDir, "mlx-watchdog.sh"), join(scripts, "mlx-watchdog.sh"));
    writeFileSync(join(run, "active-stack"), `${opts.stack}\n`);
    if (opts.priorStrikes) writeFileSync(join(run, "mlx-watchdog.strikes"), `${opts.priorStrikes}\n`);

    const stub = (path: string, body: string) => {
      writeFileSync(path, `#!/bin/bash\n${body}\n`);
      chmodSync(path, 0o755);
    };
    stub(
      join(scripts, "switch-stack.sh"),
      `echo "switch-stack $*" >>"${calls}"
case "$1 $2" in
  "chat-endpoint mlx") echo "http://localhost:8080 mlx-chat-model" ;;
  "chat-endpoint omlx") echo "http://localhost:8090 omlx-chat-model" ;;
  "chat-endpoint ollama") echo "http://localhost:11434 ollama-chat-model" ;;
  chat-endpoint*) exit 1 ;;
esac`,
    );
    stub(join(bin, "curl"), `echo "curl $*" >>"${calls}"; printf '%s' "${opts.httpCode}"`);
    stub(join(bin, "lsof"), opts.lsof ? opts.lsof(root) : `echo "lsof $*" >>"${calls}"; exit 1`);
    stub(join(bin, "kill"), `echo "kill $*" >>"${calls}"; touch "${root}/killed"`);
    stub(join(bin, "pgrep"), "exit 1");
    // CPU of the chat server: 0 by default, i.e. idle, which is what wedged looks like
    stub(join(bin, "ps"), `printf '%s\\n' "${opts.cpu ?? "0.0"}"`);
    stub(join(bin, "sleep"), "exit 0");

    // kill is a bash builtin, so the stub above would never run and a real
    // process could be signalled. Disable the builtin before the script starts.
    const bashEnv = join(root, "bash-env");
    writeFileSync(bashEnv, "enable -n kill\n");

    const result = spawnSync("bash", [join(scripts, "mlx-watchdog.sh")], {
      encoding: "utf-8",
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, PHARMALLM_RUN_DIR: run, BASH_ENV: bashEnv },
    });
    const log = existsSync(calls) ? readFileSync(calls, "utf-8") : "";
    const strikesFile = join(run, "mlx-watchdog.strikes");
    const strikes = existsSync(strikesFile) ? readFileSync(strikesFile, "utf-8").trim() : "";
    return { result, calls: log.split("\n").filter(Boolean), strikes, root };
  }

  it("probes the omlx server where switch-stack says it serves chat, with its model", () => {
    const { result, calls } = runWatchdog({ stack: "omlx", httpCode: "200" });
    expect(result.status).toBe(0);
    const probe = calls.find((c) => c.startsWith("curl "));
    expect(probe).toContain("http://localhost:8090/v1/chat/completions");
    expect(probe).toContain('"model":"omlx-chat-model"');
  });

  it("still probes mlx on its own port", () => {
    const { calls } = runWatchdog({ stack: "mlx", httpCode: "200" });
    const probe = calls.find((c) => c.startsWith("curl "));
    expect(probe).toContain("http://localhost:8080/v1/chat/completions");
    expect(probe).toContain('"model":"mlx-chat-model"');
  });

  it("leaves ollama alone", () => {
    const { result, calls } = runWatchdog({ stack: "ollama", httpCode: "500", priorStrikes: 1 });
    expect(result.status).toBe(0);
    expect(calls).toEqual([]);
  });

  it("restarts the omlx server on its own port, not mlx's", () => {
    const { calls } = runWatchdog({ stack: "omlx", httpCode: "500", priorStrikes: 1 });
    const lsofPorts = calls.filter((c) => c.startsWith("lsof ")).map((c) => c.match(/:(\d+)/)?.[1]);
    expect(lsofPorts.length).toBeGreaterThan(0);
    expect(new Set(lsofPorts)).toEqual(new Set(["8090"]));
    expect(calls).toContain("switch-stack ensure-stack omlx");
  });

  it("kills the process listening on the chat port, not a client connected to it", () => {
    // A bare `lsof -ti :port` also lists clients such as the app (PID 222), and
    // lists it first here. Only the listener (PID 111) may be signalled, and it
    // counts as gone once it has been killed even though the client stays.
    const lsof = (root: string) => `echo "lsof $*" >>"${root}/calls.log"
case "$*" in
  *-sTCP:LISTEN*) [ -e "${root}/killed" ] && exit 1; echo 111 ;;
  *) printf '222\\n111\\n' ;;
esac`;
    const { calls } = runWatchdog({ stack: "mlx", httpCode: "000", priorStrikes: 1, lsof });
    const kills = calls.filter((c) => c.startsWith("kill "));
    expect(kills).toEqual(["kill -TERM 111"]);
  });

  it("does not count a strike while the chat server is busy generating", () => {
    // A long chat turn or export holds the single-request server; the probe
    // queues behind it and times out. High CPU means busy, not wedged.
    const lsof = (root: string) => `echo "lsof $*" >>"${root}/calls.log"; echo 111`;
    const { calls, strikes } = runWatchdog({ stack: "mlx", httpCode: "000", priorStrikes: 1, cpu: "87.5", lsof });
    expect(calls.some((c) => c.startsWith("kill ") || c.includes("ensure-stack"))).toBe(false);
    expect(strikes).toBe("1");
  });

  it("still restarts a server that fails the probe while idle on CPU", () => {
    const { calls } = runWatchdog({ stack: "mlx", httpCode: "000", priorStrikes: 1, cpu: "0.0" });
    expect(calls).toContain("switch-stack ensure-stack mlx");
  });

  it("does nothing when switch-stack cannot say where the stack serves chat", () => {
    const { result, calls } = runWatchdog({ stack: "unknown", httpCode: "500", priorStrikes: 1 });
    expect(result.status).toBe(0);
    expect(calls.some((c) => c.startsWith("curl ") || c.startsWith("lsof ") || c.includes("ensure-stack"))).toBe(false);
  });
});

describe("the mlx-watchdog launchd job", () => {
  // The watchdog restarts the chat server from inside its own launchd job, so
  // the new server lands in the job's process group. By default launchd kills
  // that whole group when the job exits: every restart died seconds later, and
  // on 2026-09-26 the watchdog restarted MLX 172 times while chat stayed down.
  it("leaves the chat server it restarted running when the job exits", () => {
    const template = readFileSync(join(process.cwd(), "hermes", "com.pharmaitchat.mlx-watchdog.plist.template"), "utf-8");
    expect(template).toMatch(/<key>AbandonProcessGroup<\/key>\s*<true\/>/);
  });
});
