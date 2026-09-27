import { afterEach, describe, expect, it } from "@jest/globals";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { thinkingBody } from "../src/services/thinking.js";
import { buildStacks, STACK_NAMES } from "../src/config/llm-stacks.js";
import { parseProgress } from "../src/services/stack-switch.js";

const script = readFileSync(join(process.cwd(), "scripts", "switch-stack.sh"), "utf-8");
const modelfile = readFileSync(join(process.cwd(), "ollama", "qwen3.8-pharma.Modelfile"), "utf-8");

function shellVar(name: string): string {
  const match = script.match(new RegExp(`^${name}="([^"]+)"$`, "m"));
  if (!match) throw new Error(`${name} not found in switch-stack.sh`);
  return match[1];
}

// Extracts only the function definitions (everything before the CLI dispatch at the bottom of the
// file) so a harness can source them and stub out I/O-performing functions before calling into
// switch_to/write_switch_phase/notify_switch_result directly, without ever running the real
// service-control logic. SCRIPT_DIR/PROJECT_DIR are supplied via env instead of being recomputed
// from $0, since sourcing a copy would otherwise get $0 wrong.
function extractFuncs(): string {
  const dispatchIndex = script.split("\n").findIndex((line) => line.startsWith('case "${1:-}" in'));
  return script
    .split("\n")
    .slice(0, dispatchIndex)
    .filter((line) => !line.startsWith('SCRIPT_DIR="') && !line.startsWith('PROJECT_DIR="'))
    .join("\n");
}

describe("switch-stack.sh stays in sync with llm-stacks.ts", () => {
  const { ollama, mlx, omlx } = buildStacks({});

  it("uses the same model names", () => {
    expect(shellVar("OLLAMA_CHAT_MODEL")).toBe(ollama.chatModel);
    expect(shellVar("OLLAMA_EMBED_MODEL")).toBe(ollama.embeddingModel);
    expect(shellVar("MLX_CHAT_MODEL")).toBe(mlx.chatModel);
    expect(shellVar("MLX_EMBED_MODEL")).toBe(mlx.embeddingModel);
  });

  it("uses the same model names for omlx (warm_up must not hardcode ids that can drift)", () => {
    expect(shellVar("OMLX_CHAT_MODEL")).toBe(omlx.chatModel);
    expect(shellVar("OMLX_EMBED_MODEL")).toBe(omlx.embeddingModel);
    // warm_up and mlx-watchdog.sh both take the chat model from chat-endpoint
    const endpoint = spawnSync("bash", [join(process.cwd(), "scripts", "switch-stack.sh"), "chat-endpoint", "omlx"], {
      encoding: "utf-8",
      env: { ...process.env, PHARMALLM_RUN_DIR: mkdtempSync(join(tmpdir(), "chat-endpoint-")) },
    });
    expect(endpoint.stdout.trim()).toBe(`${omlx.chatBaseUrl} ${omlx.chatModel}`);
    expect(script).toContain('embed_model="$OMLX_EMBED_MODEL"');
  });

  it("uses the same ports", () => {
    expect(ollama.chatBaseUrl).toBe(`http://localhost:${shellVar("OLLAMA_PORT")}`);
    expect(mlx.chatBaseUrl).toBe(`http://localhost:${shellVar("MLX_CHAT_PORT")}`);
    expect(mlx.embedBaseUrl).toBe(`http://localhost:${shellVar("MLX_EMBED_PORT")}`);
    expect(omlx.chatBaseUrl).toBe(`http://localhost:${shellVar("OMLX_PORT")}`);
  });

  it("builds qwen3.8-pharma from the pulled base model with a 64k context", () => {
    expect(modelfile).toContain(`FROM ${shellVar("OLLAMA_BASE_MODEL")}`);
    expect(modelfile).toContain("PARAMETER num_ctx 65536");
  });

  it("warms up with the same thinking switch the client sends", () => {
    expect(script).toContain(`'"reasoning_effort":"none"'`);
    expect(script).toContain(`'"chat_template_kwargs":{"enable_thinking":false}'`);
    expect(JSON.stringify(thinkingBody(ollama, "off"))).toBe('{"reasoning_effort":"none"}');
    expect(JSON.stringify(thinkingBody(mlx, "off"))).toBe('{"chat_template_kwargs":{"enable_thinking":false}}');
  });

  // THE CRITICAL FINDING: warm_up's `extra` body for splash and thinkingBody()'s body for splash
  // live in different files, and nothing else compares them -- so giving splash mlx's
  // chat_template_kwargs in thinking.ts would pass warm_up (which builds its own literal body)
  // and only break real chat requests, which read thinkingBody. This extracts the actual `extra=`
  // assignment from the script's splash branch and checks it against thinkingBody(splash, "off"),
  // so the two can never drift silently again.
  it("splash's thinking-off body matches its own warm-up body, not mlx's chat_template_kwargs convention", () => {
    const { splash } = buildStacks({});
    const splashBranch = script.split('elif [ "$1" = "splash" ]')[1]?.split(/\belse\b/)[0] ?? "";
    const match = splashBranch.match(/extra='([^']+)'/);

    expect(match).not.toBeNull();
    expect(JSON.parse(`{${match![1]}}`)).toEqual(thinkingBody(splash, "off"));
    expect(thinkingBody(splash, "off")).not.toHaveProperty("chat_template_kwargs");
  });
});

describe("switch-stack.sh long-context settings", () => {
  it("caps the MLX prompt cache with an overridable byte limit", () => {
    expect(script).toContain('MLX_PROMPT_CACHE_BYTES="${MLX_PROMPT_CACHE_BYTES:-8589934592}"');
    expect(script).toContain('--prompt-cache-bytes "$MLX_PROMPT_CACHE_BYTES"');
    expect(script).toContain("start_ollama && ensure_ollama_ctx");
  });
});

describe("switch-stack.sh ollama-ctx", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // Runs the command with a stub `ollama` first on a PATH that cannot reach the real one
  function runWithStubOllama(currentCtx: string): string {
    const dir = mkdtempSync(join(tmpdir(), "ollama-ctx-"));
    dirs.push(dir);
    const log = join(dir, "ollama.log");
    const stub = join(dir, "ollama");
    writeFileSync(
      stub,
      [
        "#!/bin/bash",
        'echo "$*" >> "$STUB_LOG"',
        'if [ "$1" = "show" ]; then',
        "  printf 'min_p                          0\\nnum_ctx                        %s\\ntemperature                    1\\n' \"$STUB_CTX\"",
        "fi",
      ].join("\n")
    );
    chmodSync(stub, 0o755);
    const result = spawnSync("bash", [join(process.cwd(), "scripts", "switch-stack.sh"), "ollama-ctx"], {
      encoding: "utf-8",
      env: {
        PATH: `${dir}:/usr/bin:/bin`,
        HOME: dir,
        PHARMALLM_RUN_DIR: join(dir, "run"),
        STUB_LOG: log,
        STUB_CTX: currentCtx,
      },
    });
    expect(result.status).toBe(0);
    return readFileSync(log, "utf-8");
  }

  it("recreates qwen3.8-pharma when its context differs from the Modelfile", () => {
    const calls = runWithStubOllama("16384");
    expect(calls).toContain("show qwen3.8-pharma --parameters");
    expect(calls).toContain(`create qwen3.8-pharma -f ${join(process.cwd(), "ollama", "qwen3.8-pharma.Modelfile")}`);
  });

  it("leaves qwen3.8-pharma alone when the context already matches", () => {
    const calls = runWithStubOllama("65536");
    expect(calls).toContain("show qwen3.8-pharma --parameters");
    expect(calls).not.toContain("create");
  });
});

describe("switch-stack.sh omlx stack", () => {
  it("defines the venv, port and pinned version", () => {
    expect(script).toContain('OMLX_VENV="$PROJECT_DIR/python/omlx-venv"');
    expect(script).toContain('OMLX_PORT="8090"');
    expect(script).toMatch(/OMLX_VERSION="[0-9a-f]{7,40}"/);
  });

  it("builds the oMLX venv with its own interpreter, not MLX's", () => {
    // oMLX pins >=3.11,<3.14; this machine's python3 is 3.14, so sharing MLX_PYTHON
    // made `prepare` fail with "requires a different Python" after a 213 MB clone.
    expect(script).toContain('OMLX_PYTHON="${OMLX_PYTHON:-python3.11}"');
    expect(script).toContain('"$OMLX_PYTHON" -m venv "$OMLX_VENV"');
    expect(script).not.toContain('"$MLX_PYTHON" -m venv "$OMLX_VENV"');
    expect(script).toMatch(/command -v "\$OMLX_PYTHON"/);
  });

  it("starts oMLX with one server for chat and embeddings", () => {
    expect(script).toContain('"$OMLX_VENV/bin/omlx" serve --host 127.0.0.1 --port "$OMLX_PORT"');
    expect(script).toContain('--model-dir "$HF_CACHE"');
    expect(script).toContain('echo $! >"$RUN_DIR/omlx.pid"');
    expect(script).toContain('wait_http "http://localhost:$OMLX_PORT/v1/models" 180');
  });

  it("bounds the oMLX SSD cache with an overridable size", () => {
    expect(script).toContain('OMLX_CACHE_MAX_GB="${OMLX_CACHE_MAX_GB:-20}"');
    expect(script).toContain('--paged-ssd-cache-max-size "${OMLX_CACHE_MAX_GB}GB"');
  });

  it("stops every stack except the target instead of assuming two", () => {
    expect(script).toContain("stop_other_stacks()");
    expect(script).not.toContain("other_stack()");
    // F4: the literal list this used to pin moved into STACK_NAMES, checked against llm-stacks.ts
    // by the "stack list" suite below.
    expect(script).toContain('for other in "${STACK_NAMES[@]}"; do');
  });

  it("accepts omlx everywhere a stack name is taken", () => {
    expect(script).toContain("ollama|mlx|omlx|splash) ;;");
    expect(script).toContain("ollama|mlx|omlx|splash) switch_to");
  });

  it("prepares by stopping every other stack, not just MLX", () => {
    // Previously: a bare `stop_mlx` before the Ollama pulls, so an active omlx server kept
    // serving a 27B model on :8090 throughout `prepare` (breaking "exactly one active stack").
    expect(script).toContain("stop_other_stacks ollama\n  start_ollama");
    expect(script).not.toContain("\n  stop_mlx\n  start_ollama");
  });

  it("shows the omlx log when a switch to omlx fails", () => {
    expect(script).toContain(
      'for file in "$LOG_DIR/mlx-chat.log" "$LOG_DIR/mlx-embed.log" "$LOG_DIR/omlx.log" "$LOG_DIR/splash.log" "$LOG_DIR/app.log"; do'
    );
  });
});

describe("switch-stack.sh stop_other_stacks", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // Sources only the function definitions (everything before the CLI dispatch at the bottom of the
  // file), then overrides stop_ollama/stop_mlx/stop_omlx with stubs before calling stop_other_stacks,
  // so no real port/process/service logic ever runs. SCRIPT_DIR/PROJECT_DIR are supplied via env
  // instead of being recomputed from $0, since sourcing a copy would otherwise get $0 wrong.
  it("keeps stopping the remaining stacks after one stop fails, and aggregates the failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "stop-other-stacks-"));
    dirs.push(dir);
    const log = join(dir, "calls.log");

    const dispatchIndex = script.split("\n").findIndex((line) => line.startsWith('case "${1:-}" in'));
    const funcs = script
      .split("\n")
      .slice(0, dispatchIndex)
      .filter((line) => !line.startsWith('SCRIPT_DIR="') && !line.startsWith('PROJECT_DIR="'))
      .join("\n");
    const funcsFile = join(dir, "funcs.sh");
    writeFileSync(funcsFile, funcs);

    const harness = [
      "#!/bin/bash",
      "set -uo pipefail",
      'source "$FUNCS_FILE"',
      "",
      "# Stubs: replace the real stop_* implementations so no port/process/service logic runs.",
      'stop_ollama() { echo "stop_ollama" >>"$STUB_LOG"; return 1; }',
      'stop_mlx() { echo "stop_mlx" >>"$STUB_LOG"; return 0; }',
      'stop_omlx() { echo "stop_omlx" >>"$STUB_LOG"; return 0; }',
      "",
      "# funcs.sh carries `set -euo pipefail`; capture the return code via || so a nonzero",
      "# result doesn't make the whole harness exit before it's recorded.",
      "rc=0",
      "stop_other_stacks omlx || rc=$?",
      'echo "rc=$rc" >>"$STUB_LOG"',
    ].join("\n");
    const harnessFile = join(dir, "harness.sh");
    writeFileSync(harnessFile, harness);
    chmodSync(harnessFile, 0o755);

    const result = spawnSync("bash", [harnessFile], {
      encoding: "utf-8",
      env: {
        PATH: `${dir}:/usr/bin:/bin`,
        HOME: dir,
        PHARMALLM_RUN_DIR: join(dir, "run"),
        SCRIPT_DIR: join(process.cwd(), "scripts"),
        PROJECT_DIR: process.cwd(),
        FUNCS_FILE: funcsFile,
        STUB_LOG: log,
      },
    });

    expect(result.status).toBe(0);
    const calls = readFileSync(log, "utf-8");
    // ollama's stop fails, but the loop must still reach mlx (the bug this replaces would not,
    // if a duplicated case body were mis-ordered) — and must never touch the target, omlx.
    expect(calls).toContain("stop_ollama");
    expect(calls).toContain("stop_mlx");
    expect(calls).not.toContain("stop_omlx");
    expect(calls).toContain("rc=1");
  });
});

describe("switch-stack.sh omlx processes", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // Runs `omlx-ports` with a stub `omlx` and stub `lsof`/`nc` absent, so only the echo path is exercised
  it("reports the omlx port in status output", () => {
    const dir = mkdtempSync(join(tmpdir(), "omlx-status-"));
    dirs.push(dir);
    const result = spawnSync("bash", ["-c", `grep -c 'omlx:\\$OMLX_PORT' ${JSON.stringify(join(process.cwd(), "scripts", "switch-stack.sh"))}`], {
      encoding: "utf-8",
      env: { PATH: "/usr/bin:/bin", HOME: dir },
    });
    expect(Number(result.stdout.trim())).toBeGreaterThan(0);
  });
});

describe("switch-stack.sh switch progress", () => {
  it("writes every phase of a switch to the progress file", () => {
    expect(script).toContain('SWITCH_FILE="$RUN_DIR/stack-switch.json"');
    for (const phase of ["stopping", "starting", "warming", "indexing", "ready", "failed"]) {
      expect(script).toContain(`write_switch_phase ${phase}`);
    }
  });

  it("sends a Telegram completion message when the switch ends", () => {
    expect(script).toContain("notify_switch_result()");
    expect(script).toContain("api.telegram.org/bot");
    expect(script).toContain("notify_switch_result ready");
    expect(script).toContain("notify_switch_result failed");
  });

  it("passes the Telegram credentials to the app and no public URL", () => {
    expect(script).toContain('TELEGRAM_BOT_TOKEN="$(telegram_value bot-token)"');
    expect(script).toContain('TELEGRAM_CHAT_ID="$(telegram_value chat-id)"');
    expect(script).not.toContain("PHARMALLM_PUBLIC_URL");
    expect(script).not.toContain("public-url");
  });
});

describe("switch-stack.sh telegram command", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("stores both values with owner-only permissions and never prints them", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-"));
    dirs.push(dir);

    const result = spawnSync("bash", [join(process.cwd(), "scripts", "switch-stack.sh"), "telegram"], {
      encoding: "utf-8",
      env: {
        PATH: "/usr/bin:/bin",
        HOME: dir,
        PHARMALLM_RUN_DIR: join(dir, "run"),
        TELEGRAM_BOT_TOKEN: "123456:AA-secret",
        TELEGRAM_CHAT_ID: "424242",
      },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(join(dir, "run", "telegram-bot-token"), "utf-8").trim()).toBe("123456:AA-secret");
    expect(readFileSync(join(dir, "run", "telegram-chat-id"), "utf-8").trim()).toBe("424242");
    expect(statSync(join(dir, "run", "telegram-bot-token")).mode & 0o777).toBe(0o600);
    expect(result.stdout + result.stderr).not.toContain("123456:AA-secret");
  });

  it("never asks for or stores a public URL", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-url-"));
    dirs.push(dir);

    const result = spawnSync("bash", [join(process.cwd(), "scripts", "switch-stack.sh"), "telegram"], {
      encoding: "utf-8",
      env: {
        PATH: "/usr/bin:/bin",
        HOME: dir,
        PHARMALLM_RUN_DIR: join(dir, "run"),
        TELEGRAM_BOT_TOKEN: "123456:AA-secret",
        TELEGRAM_CHAT_ID: "424242",
      },
    });

    expect(result.status).toBe(0);
    expect(existsSync(join(dir, "run", "public-url"))).toBe(false);
    expect(result.stdout + result.stderr).not.toMatch(/public URL/i);
  });
});

describe("switch-stack.sh switch_to: a failed stop must not strand the UI", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // Sources only the function definitions, stubs models_ready/ensure_chromadb (no filesystem/network
  // dependency) and stop_app/stop_other_stacks per scenario, stubs curl so no real Telegram call is
  // ever made, then calls switch_to directly and inspects the progress file it leaves behind.
  function runWithStoppedStub(stopAppRc: number, stopOtherRc: number): { progress: unknown; curlLog: string; status: number | null } {
    const dir = mkdtempSync(join(tmpdir(), "switch-to-stop-"));
    dirs.push(dir);
    const runDir = join(dir, "run");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "telegram-bot-token"), "FAKE_TOKEN_XYZ\n");
    writeFileSync(join(runDir, "telegram-chat-id"), "424242\n");

    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    const curlLog = join(dir, "curl.log");
    writeFileSync(join(binDir, "curl"), ["#!/bin/bash", 'echo "curl_called: $*" >> "$STUB_CURL_LOG"', "exit 0"].join("\n"));
    chmodSync(join(binDir, "curl"), 0o755);

    const funcsFile = join(dir, "funcs.sh");
    writeFileSync(funcsFile, extractFuncs());

    const harness = [
      "#!/bin/bash",
      "set -uo pipefail",
      'source "$FUNCS_FILE"',
      "# Stubs: no real model check, no real ChromaDB, no real stop logic.",
      "models_ready() { return 0; }",
      "ensure_chromadb() { return 0; }",
      `stop_app() { return ${stopAppRc}; }`,
      `stop_other_stacks() { return ${stopOtherRc}; }`,
      "switch_to omlx",
    ].join("\n");
    const harnessFile = join(dir, "harness.sh");
    writeFileSync(harnessFile, harness);
    chmodSync(harnessFile, 0o755);

    const result = spawnSync("bash", [harnessFile], {
      encoding: "utf-8",
      env: {
        PATH: `${binDir}:/usr/bin:/bin`,
        HOME: dir,
        PHARMALLM_RUN_DIR: runDir,
        SCRIPT_DIR: join(process.cwd(), "scripts"),
        PROJECT_DIR: process.cwd(),
        FUNCS_FILE: funcsFile,
        STUB_CURL_LOG: curlLog,
      },
    });

    const progress = JSON.parse(readFileSync(join(runDir, "stack-switch.json"), "utf-8")) as unknown;
    let curlLogContent = "";
    try {
      curlLogContent = readFileSync(curlLog, "utf-8");
    } catch {
      // no curl call recorded
    }
    return { progress, curlLog: curlLogContent, status: result.status };
  }

  it("writes the failed phase with a specific error and still notifies when stop_app fails", () => {
    const { progress, curlLog, status } = runWithStoppedStub(1, 0);
    expect(status).not.toBe(0);
    expect((progress as { phase: string }).phase).toBe("failed");
    expect((progress as { error: string }).error).toBe("could not stop the current app");
    expect(curlLog).toContain("curl_called");
  });

  it("writes the failed phase with a specific error and still notifies when stop_other_stacks fails", () => {
    const { progress, curlLog, status } = runWithStoppedStub(0, 1);
    expect(status).not.toBe(0);
    expect((progress as { phase: string }).phase).toBe("failed");
    expect((progress as { error: string }).error).toBe("could not stop the other stacks");
    expect(curlLog).toContain("curl_called");
  });
});

describe("switch-stack.sh notify_switch_result keeps the bot token out of argv", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("never places ${token} directly on a curl invocation line", () => {
    const curlLines = script.split("\n").filter((line) => line.includes("curl"));
    for (const line of curlLines) {
      expect(line).not.toContain("${token}");
    }
    expect(script).toContain('printf \'url = "%s"\\n\' "https://api.telegram.org/bot${token}/sendMessage"');
    expect(script).toContain("curl -K -");
  });

  it("the stub curl receives no token in its arguments at runtime", () => {
    const dir = mkdtempSync(join(tmpdir(), "notify-token-"));
    dirs.push(dir);
    const runDir = join(dir, "run");
    mkdirSync(runDir, { recursive: true });
    const secretToken = "123456:AA-super-secret";
    writeFileSync(join(runDir, "telegram-bot-token"), `${secretToken}\n`);
    writeFileSync(join(runDir, "telegram-chat-id"), "424242\n");

    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    const curlLog = join(dir, "curl.log");
    // Logs argv only (never stdin, which is where the URL/token now travel) so a leak into argv
    // would show up here.
    writeFileSync(join(binDir, "curl"), ["#!/bin/bash", 'printf \'%s\\n\' "$@" >> "$STUB_CURL_LOG"', "exit 0"].join("\n"));
    chmodSync(join(binDir, "curl"), 0o755);

    const funcsFile = join(dir, "funcs.sh");
    writeFileSync(funcsFile, extractFuncs());

    const harness = [
      "#!/bin/bash",
      "set -uo pipefail",
      'source "$FUNCS_FILE"',
      "SWITCH_TARGET=omlx",
      "SWITCH_PREVIOUS=ollama",
      "SWITCH_STARTED=1700000000000",
      "notify_switch_result ready",
    ].join("\n");
    const harnessFile = join(dir, "harness.sh");
    writeFileSync(harnessFile, harness);
    chmodSync(harnessFile, 0o755);

    const result = spawnSync("bash", [harnessFile], {
      encoding: "utf-8",
      env: {
        PATH: `${binDir}:/usr/bin:/bin`,
        HOME: dir,
        PHARMALLM_RUN_DIR: runDir,
        SCRIPT_DIR: join(process.cwd(), "scripts"),
        PROJECT_DIR: process.cwd(),
        FUNCS_FILE: funcsFile,
        STUB_CURL_LOG: curlLog,
      },
    });

    expect(result.status).toBe(0);
    const curlArgs = readFileSync(curlLog, "utf-8");
    expect(curlArgs).not.toContain(secretToken);
    expect(result.stdout + result.stderr).not.toContain(secretToken);
  });
});

describe("switch-stack.sh write_switch_phase", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // Round-trips write_switch_phase's output through parseProgress (the same function
  // src/api/stack.ts uses to read the file back), for an in-flight phase and a terminal one.
  it("writes a progress file that parseProgress accepts, in flight and at a terminal phase", () => {
    const dir = mkdtempSync(join(tmpdir(), "write-phase-"));
    dirs.push(dir);
    const runDir = join(dir, "run");
    mkdirSync(runDir, { recursive: true });
    const outDir = join(dir, "out");
    mkdirSync(outDir, { recursive: true });

    const funcsFile = join(dir, "funcs.sh");
    writeFileSync(funcsFile, extractFuncs());

    const harness = [
      "#!/bin/bash",
      "set -uo pipefail",
      'source "$FUNCS_FILE"',
      "SWITCH_TARGET=omlx",
      "SWITCH_PREVIOUS=ollama",
      "SWITCH_STARTED=1700000000000",
      "write_switch_phase starting",
      'cp "$SWITCH_FILE" "$OUT_DIR/starting.json"',
      'write_switch_phase failed "boom"',
      'cp "$SWITCH_FILE" "$OUT_DIR/failed.json"',
    ].join("\n");
    const harnessFile = join(dir, "harness.sh");
    writeFileSync(harnessFile, harness);
    chmodSync(harnessFile, 0o755);

    const result = spawnSync("bash", [harnessFile], {
      encoding: "utf-8",
      env: {
        PATH: "/usr/bin:/bin",
        HOME: dir,
        PHARMALLM_RUN_DIR: runDir,
        SCRIPT_DIR: join(process.cwd(), "scripts"),
        PROJECT_DIR: process.cwd(),
        FUNCS_FILE: funcsFile,
        OUT_DIR: outDir,
      },
    });

    expect(result.status).toBe(0);

    const starting = parseProgress(JSON.parse(readFileSync(join(outDir, "starting.json"), "utf-8")));
    expect(starting).not.toBeNull();
    expect(starting?.phase).toBe("starting");
    expect(starting?.target).toBe("omlx");
    expect(starting?.previous).toBe("ollama");
    expect(typeof starting?.startedAt).toBe("number");
    expect(starting?.finishedAt).toBeUndefined();
    expect(starting?.error).toBeUndefined();

    const failed = parseProgress(JSON.parse(readFileSync(join(outDir, "failed.json"), "utf-8")));
    expect(failed).not.toBeNull();
    expect(failed?.phase).toBe("failed");
    expect(failed?.target).toBe("omlx");
    expect(failed?.previous).toBe("ollama");
    expect(typeof failed?.finishedAt).toBe("number");
    expect(failed?.error).toBe("boom");
  });

  // Amendment D: "confirmed" is the phase written before any pre-flight check runs.
  it("also round-trips a confirmed write (written before any pre-flight check runs)", () => {
    const dir = mkdtempSync(join(tmpdir(), "write-phase-confirmed-"));
    dirs.push(dir);
    const runDir = join(dir, "run");
    mkdirSync(runDir, { recursive: true });
    const outDir = join(dir, "out");
    mkdirSync(outDir, { recursive: true });

    const funcsFile = join(dir, "funcs.sh");
    writeFileSync(funcsFile, extractFuncs());

    const harness = [
      "#!/bin/bash",
      "set -uo pipefail",
      'source "$FUNCS_FILE"',
      "SWITCH_TARGET=omlx",
      "SWITCH_PREVIOUS=ollama",
      "SWITCH_STARTED=1700000000000",
      "write_switch_phase confirmed",
      'cp "$SWITCH_FILE" "$OUT_DIR/confirmed.json"',
    ].join("\n");
    const harnessFile = join(dir, "harness.sh");
    writeFileSync(harnessFile, harness);
    chmodSync(harnessFile, 0o755);

    const result = spawnSync("bash", [harnessFile], {
      encoding: "utf-8",
      env: {
        PATH: "/usr/bin:/bin",
        HOME: dir,
        PHARMALLM_RUN_DIR: runDir,
        SCRIPT_DIR: join(process.cwd(), "scripts"),
        PROJECT_DIR: process.cwd(),
        FUNCS_FILE: funcsFile,
        OUT_DIR: outDir,
      },
    });

    expect(result.status).toBe(0);

    const confirmed = parseProgress(JSON.parse(readFileSync(join(outDir, "confirmed.json"), "utf-8")));
    expect(confirmed).not.toBeNull();
    expect(confirmed?.phase).toBe("confirmed");
    expect(confirmed?.target).toBe("omlx");
    expect(confirmed?.previous).toBe("ollama");
    expect(typeof confirmed?.startedAt).toBe("number");
    expect(confirmed?.finishedAt).toBeUndefined();
    expect(confirmed?.error).toBeUndefined();
  });
});

describe("switch-stack.sh switch_to: pre-flight checks are guarded and recorded", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // Sources only the function definitions, stubs models_ready/ensure_chromadb per scenario (and
  // stop_app/stop_other_stacks, which must never be reached when a pre-flight check fails), stubs
  // curl so no real Telegram call is ever made, then calls switch_to directly and inspects the
  // progress file and stub call log it leaves behind. Before amendment D, a pre-flight failure
  // (bad stack name, missing models, or ChromaDB not starting) exited with no progress file
  // written at all and no Telegram notification sent, since SWITCH_TARGET was only set — and
  // write_switch_phase only usable — after these checks had already run.
  function runPreflight(target: string, modelsReadyRc: number, ensureChromadbRc: number): {
    progress: unknown;
    curlLog: string;
    status: number | null;
    stubLog: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), "switch-to-preflight-"));
    dirs.push(dir);
    const runDir = join(dir, "run");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "telegram-bot-token"), "FAKE_TOKEN_XYZ\n");
    writeFileSync(join(runDir, "telegram-chat-id"), "424242\n");

    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    const curlLog = join(dir, "curl.log");
    writeFileSync(join(binDir, "curl"), ["#!/bin/bash", 'echo "curl_called: $*" >> "$STUB_CURL_LOG"', "exit 0"].join("\n"));
    chmodSync(join(binDir, "curl"), 0o755);

    const funcsFile = join(dir, "funcs.sh");
    writeFileSync(funcsFile, extractFuncs());

    const stubLog = join(dir, "stub.log");
    const harness = [
      "#!/bin/bash",
      "set -uo pipefail",
      'source "$FUNCS_FILE"',
      "# Stubs: no real model check, no real ChromaDB, and these must never run when a pre-flight check fails.",
      `models_ready() { return ${modelsReadyRc}; }`,
      `ensure_chromadb() { return ${ensureChromadbRc}; }`,
      'stop_app() { echo "stop_app_called" >>"$STUB_LOG"; return 0; }',
      'stop_other_stacks() { echo "stop_other_stacks_called" >>"$STUB_LOG"; return 0; }',
      `switch_to ${target}`,
    ].join("\n");
    const harnessFile = join(dir, "harness.sh");
    writeFileSync(harnessFile, harness);
    chmodSync(harnessFile, 0o755);

    const result = spawnSync("bash", [harnessFile], {
      encoding: "utf-8",
      env: {
        PATH: `${binDir}:/usr/bin:/bin`,
        HOME: dir,
        PHARMALLM_RUN_DIR: runDir,
        SCRIPT_DIR: join(process.cwd(), "scripts"),
        PROJECT_DIR: process.cwd(),
        FUNCS_FILE: funcsFile,
        STUB_CURL_LOG: curlLog,
        STUB_LOG: stubLog,
      },
    });

    const progress = JSON.parse(readFileSync(join(runDir, "stack-switch.json"), "utf-8")) as unknown;
    let curlLogContent = "";
    try {
      curlLogContent = readFileSync(curlLog, "utf-8");
    } catch {
      // no curl call recorded
    }
    let stubLogContent = "";
    try {
      stubLogContent = readFileSync(stubLog, "utf-8");
    } catch {
      // no stub call recorded
    }
    return { progress, curlLog: curlLogContent, status: result.status, stubLog: stubLogContent };
  }

  it("writes failed with a specific reason and notifies, never reaching stop_app, when the target is unknown", () => {
    const { progress, curlLog, status, stubLog } = runPreflight("bogus", 0, 0);
    expect(status).not.toBe(0);
    expect((progress as { phase: string }).phase).toBe("failed");
    expect((progress as { error: string }).error).toBe("unknown stack 'bogus'");
    expect(curlLog).toContain("curl_called");
    expect(stubLog).not.toContain("stop_app_called");
    expect(stubLog).not.toContain("stop_other_stacks_called");
  });

  it("writes failed with a specific reason and notifies, never reaching stop_app, when models are missing", () => {
    const { progress, curlLog, status, stubLog } = runPreflight("omlx", 1, 0);
    expect(status).not.toBe(0);
    expect((progress as { phase: string }).phase).toBe("failed");
    expect((progress as { error: string }).error).toBe(
      "models for omlx are missing (run scripts/switch-stack.sh prepare)"
    );
    expect(curlLog).toContain("curl_called");
    expect(stubLog).not.toContain("stop_app_called");
  });

  it("writes failed with a specific reason and notifies, never reaching stop_app, when ChromaDB cannot start", () => {
    const { progress, curlLog, status, stubLog } = runPreflight("omlx", 0, 1);
    expect(status).not.toBe(0);
    expect((progress as { phase: string }).phase).toBe("failed");
    expect((progress as { error: string }).error).toBe("could not start ChromaDB");
    expect(curlLog).toContain("curl_called");
    expect(stubLog).not.toContain("stop_app_called");
  });
});

// F4: `status` looped over a hand-written `ollama mlx`, so the omlx stack's index was never
// reported. The script now keeps one list of stack names and drives both the status loop and
// stop_other_stacks from it, and this pins that list to the one in llm-stacks.ts.
describe("switch-stack.sh stack list", () => {
  it("keeps a single stack list that cannot drift from llm-stacks.ts", () => {
    const match = script.match(/^STACK_NAMES=\(([^)]*)\)$/m);
    expect(match).not.toBeNull();
    expect(match![1].trim().split(/\s+/)).toEqual([...STACK_NAMES]);
  });

  it("reports the index state of every stack in status, omlx included", () => {
    expect(script).toContain('for stack in "${STACK_NAMES[@]}"; do');
    expect(script).not.toContain("for stack in ollama mlx; do");
  });

  it("drives stop_other_stacks from the same list", () => {
    expect(script).toContain('for other in "${STACK_NAMES[@]}"; do');
  });
});

// F5: the catch-all after the start/warm/index chain blamed the stack ("<target> did not come up")
// even when ensure_index was what failed, which sent the owner looking at model-server logs for an
// indexing problem. ensure_index now has its own guarded branch with its own message.
describe("switch-stack.sh switch_to: a failed index step says so", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // Same harness idiom as the pre-flight tests above: only the function definitions are sourced,
  // every step that would touch a service is stubbed, PATH is pinned to a stub dir and the run
  // directory is a temp dir, so nothing here reaches a real stack, ChromaDB or Telegram.
  function runIndexStub(ensureIndexRc: number): { progress: { phase?: string; error?: string }; status: number | null } {
    const dir = mkdtempSync(join(tmpdir(), "switch-to-index-"));
    dirs.push(dir);
    const runDir = join(dir, "run");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "telegram-bot-token"), "FAKE_TOKEN_XYZ\n");
    writeFileSync(join(runDir, "telegram-chat-id"), "424242\n");

    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "curl"), ["#!/bin/bash", "exit 0"].join("\n"));
    chmodSync(join(binDir, "curl"), 0o755);

    const funcsFile = join(dir, "funcs.sh");
    writeFileSync(funcsFile, extractFuncs());

    const harness = [
      "#!/bin/bash",
      "set -uo pipefail",
      'source "$FUNCS_FILE"',
      "models_ready() { return 0; }",
      "ensure_chromadb() { return 0; }",
      "stop_app() { return 0; }",
      "stop_other_stacks() { return 0; }",
      "stop_stack() { return 0; }",
      "start_stack() { return 0; }",
      "warm_up() { return 0; }",
      "start_app() { return 0; }",
      "show_logs() { return 0; }",
      `ensure_index() { return ${ensureIndexRc}; }`,
      "switch_to omlx",
    ].join("\n");
    const harnessFile = join(dir, "harness.sh");
    writeFileSync(harnessFile, harness);
    chmodSync(harnessFile, 0o755);

    const result = spawnSync("bash", [harnessFile], {
      encoding: "utf-8",
      env: {
        PATH: `${binDir}:/usr/bin:/bin`,
        HOME: dir,
        PHARMALLM_RUN_DIR: runDir,
        SCRIPT_DIR: join(process.cwd(), "scripts"),
        PROJECT_DIR: process.cwd(),
        FUNCS_FILE: funcsFile,
      },
    });

    const progress = JSON.parse(readFileSync(join(runDir, "stack-switch.json"), "utf-8")) as {
      phase?: string;
      error?: string;
    };
    return { progress, status: result.status };
  }

  it("blames the index step, not the stack, when ensure_index fails", () => {
    const { progress, status } = runIndexStub(1);
    expect(status).not.toBe(0);
    expect(progress.phase).toBe("failed");
    expect(progress.error).toBe("could not prepare the indexes for omlx");
    expect(progress.error).not.toContain("did not come up");
  });

  it("still reaches ready when the index step succeeds", () => {
    const { progress, status } = runIndexStub(0);
    expect(status).toBe(0);
    expect(progress.phase).toBe("ready");
  });
});

describe("switch-stack.sh start_app", () => {
  // A stack switch restarts the app through start_app, not start-services.sh.
  // If only one of them points the Gap Detector at n8n, the gap loop silently
  // stops working after the first switch.
  it("points the app's gap detector at the n8n webhook", () => {
    const dir = mkdtempSync(join(tmpdir(), "start-app-"));
    try {
      const project = join(dir, "project");
      const runDir = join(project, "data", "run");
      mkdirSync(runDir, { recursive: true });
      mkdirSync(join(project, "data", "logs"), { recursive: true });

      const binDir = join(dir, "bin");
      mkdirSync(binDir);
      const envOut = join(dir, "app-env");
      // npx stands in for the app: record its environment instead of starting it
      writeFileSync(join(binDir, "npx"), `#!/bin/bash\necho "WEBHOOK=\${N8N_WEBHOOK_URL-<unset>}" >"${envOut}"\n`);
      writeFileSync(join(binDir, "curl"), '#!/bin/bash\necho \'{"status":"healthy"}\'\n');
      for (const f of ["npx", "curl"]) chmodSync(join(binDir, f), 0o755);

      const funcsFile = join(dir, "funcs.sh");
      writeFileSync(funcsFile, extractFuncs());
      const harness = join(dir, "harness.sh");
      writeFileSync(harness, ["#!/bin/bash", 'source "$FUNCS_FILE"', "start_app mlx", "wait"].join("\n"));

      const result = spawnSync("bash", [harness], {
        encoding: "utf-8",
        env: {
          PATH: `${binDir}:/usr/bin:/bin`,
          HOME: dir,
          PHARMALLM_RUN_DIR: runDir,
          SCRIPT_DIR: join(process.cwd(), "scripts"),
          PROJECT_DIR: project,
          FUNCS_FILE: funcsFile,
        },
      });

      expect(result.status).toBe(0);
      expect(readFileSync(envOut, "utf-8").trim()).toBe("WEBHOOK=http://localhost:5678/webhook/knowledge-gap");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("services.sh is_project_pid", () => {
  // A process that renames itself has no project path in its command line. oMLX pulls in
  // setproctitle and shows up as plain "omlx-server", which made the script treat its own
  // server as a foreign program: it refused to reuse the running one AND refused to stop it,
  // so the stack became a one-way trap and the app stayed down.
  function ask(pid: string, runDir: string): string {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `set -u; PROJECT_DIR="$1"; RUN_DIR="$2"; source "$1/scripts/lib/services.sh"; ` +
          `if is_project_pid "$3"; then echo ours; else echo foreign; fi`,
        "bash",
        process.cwd(),
        runDir,
        pid,
      ],
      { encoding: "utf-8" }
    );
    expect(result.status).toBe(0);
    return result.stdout.trim();
  }

  it("claims a pid recorded in a pid file even when the command line hides the project path", () => {
    const dir = mkdtempSync(join(tmpdir(), "pidcheck-"));
    const runDir = join(dir, "run");
    mkdirSync(runDir, { recursive: true });
    // `sleep` carries no project path, standing in for a renamed server process.
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      const pid = String(child.pid);
      expect(ask(pid, runDir)).toBe("foreign");
      writeFileSync(join(runDir, "omlx.pid"), `${pid}\n`);
      expect(ask(pid, runDir)).toBe("ours");
    } finally {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not claim a pid that is neither recorded nor running from the project", () => {
    const dir = mkdtempSync(join(tmpdir(), "pidcheck-"));
    const runDir = join(dir, "run");
    mkdirSync(runDir, { recursive: true });
    try {
      expect(ask("1", runDir)).toBe("foreign");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("switch-stack.sh knows every stack", () => {
  // The shell keeps its own STACK_NAMES array; nothing but this test connects
  // the two lists. A stack present in TypeScript and absent here is switchable
  // from the UI and unstartable from the shell.
  it("declares the same stack list as llm-stacks.ts", () => {
    const match = script.match(/^STACK_NAMES=\(([^)]*)\)/m);

    expect(match).not.toBeNull();
    expect(match?.[1].trim().split(/\s+/)).toEqual([...STACK_NAMES]);
  });

  it.each([...STACK_NAMES])("dispatches, validates and can start/stop %s", (stack: string) => {
    // validate_stack's case arm
    expect(script).toMatch(new RegExp(`\\b${stack}\\b[^)]*\\)\\s*;;`));
    // a models_ready arm
    expect(script).toMatch(new RegExp(`^\\s*${stack}\\)`, "m"));
  });

  it("starts splash on the port the stack definition expects", () => {
    const { splash } = buildStacks({});
    const port = new URL(splash.chatBaseUrl).port;

    expect(script).toMatch(new RegExp(`SPLASH_PORT="?\\$\\{SPLASH_PORT:-${port}\\}"?`));
  });

  it("fixes the context window at 65536 by default, overridably", () => {
    expect(script).toMatch(/SPLASH_MAX_CONTEXT="\$\{SPLASH_MAX_CONTEXT:-65536\}"/);
    expect(script).toMatch(/--max-context "\$SPLASH_MAX_CONTEXT"/);
  });

  it("passes the reasoning-effort flag the spec fixes", () => {
    expect(script).toContain("--default-reasoning-effort none");
  });

  // splash has no embeddings of its own, so its start must bring up the MLX
  // embedding server AND run parity against it -- not against :8000.
  it("runs the parity guard for splash against the embedding server", () => {
    expect(script).toMatch(/splash\)\s*start_splash && check_embedding_parity/);
  });
});
