// Benchmark the active stack end to end through the running PharmaITChat app
// Usage: npx tsx scripts/benchmark-stack.ts [--runs 1] [--app http://localhost:3000] [--questions bench/questions.json]

import { serviceUrl } from "../src/platform/host-config.js";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { parseSseLines } from "../src/services/llm-client.js";
import type { ChatTimings } from "../src/services/bench-mode.js";
import type { BenchEnvironment, BenchQuestion, BenchmarkFile, MemoryPeak, QuestionResult, RunResult } from "./lib/benchmark-types.js";
import { readEnvWithFallback } from "../src/config/env-names.js";

// Benchmark routes (/api/bench/*) are protected: send the API token when one is configured
function apiToken(): string | null {
  const fromEnv = readEnvWithFallback(process.env, "API_TOKEN");
  if (fromEnv) return fromEnv;
  const tokenFile = join(process.cwd(), "data", "run", "api-token");
  return existsSync(tokenFile) ? readFileSync(tokenFile, "utf-8").trim() || null : null;
}

const AUTH_HEADERS: Record<string, string> = ((): Record<string, string> => {
  const token = apiToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
})();

interface Options {
  runs: number;
  appUrl: string;
  questionsPath: string;
}

interface ChatEvent {
  token?: string;
  error?: string;
  done?: boolean;
  stack?: string;
  timings?: ChatTimings;
  chunkIds?: string[];
}

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
// Not in the question set, so no benchmark question hits a warm prompt cache
const WARM_UP_QUESTION = "What is a batch record in pharmaceutical manufacturing?";

function parseOptions(argv: string[]): Options {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    runs: Number(value("--runs") ?? 1),
    appUrl: value("--app") ?? serviceUrl("app"),
    questionsPath: value("--questions") ?? join(process.cwd(), "bench", "questions.json"),
  };
}

function run(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unavailable";
  }
}

// Stack processes: Ollama 0.34 runs models in lib/ollama/llama-server children (older versions: "ollama runner");
// MLX runs two Python servers; oMLX runs a single server process ("omlx-server", verified with ps during the
// spike; "omlx serve" is also accepted in case the process title differs across versions)
export function stackPatterns(stack: string): string[] {
  switch (stack) {
    case "mlx":
      return ["mlx_lm.server", "mlx-embed-server.py"];
    case "omlx":
      return ["omlx-server", "omlx serve"];
    case "splash":
      // Splash serves chat from a single process ("splash-server"/"splash serve" -- both spellings
      // are accepted for the same reason the omlx arm accepts two: the process title is not
      // guaranteed stable across versions, and an unmatched pattern samples nothing rather than
      // erroring). Splash serves NO embeddings of its own: it borrows the MLX embedding server
      // (mlx-embed-server.py) on :8081, the same process mlx's own arm above already charges to
      // mlx. Without this pattern here, that process's RSS was silently left out of splash's peak
      // memory row, biasing the comparison this benchmark exists to produce in splash's favour.
      return ["splash-server", "splash serve", "mlx-embed-server.py"];
    default:
      return ["ollama serve", "lib/ollama/llama-server", "ollama runner"];
  }
}

// Collect PIDs across all of a stack's process patterns, deduplicated: one process can match more
// than one pattern (e.g. omlx's "omlx-server" and "omlx serve" for the same server), and summing
// `ps rss` per pattern without deduplicating would double-count it.
export function collectPids(patterns: string[], pgrep: (pattern: string) => string = (pattern) => run("pgrep", ["-f", pattern])): Set<string> {
  const pids = new Set<string>();
  for (const pattern of patterns) {
    for (const pid of pgrep(pattern).split("\n").filter((pid) => /^\d+$/.test(pid))) {
      pids.add(pid);
    }
  }
  return pids;
}

function sampleMemory(stack: string): MemoryPeak {
  let processKb = 0;
  for (const pid of collectPids(stackPatterns(stack))) {
    processKb += Number(run("ps", ["-o", "rss=", "-p", pid])) || 0;
  }

  const vm = run("vm_stat", []);
  const pageSize = Number(vm.match(/page size of (\d+) bytes/)?.[1] ?? 16384);
  const pages = (label: string): number => Number(vm.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] ?? 0);
  const usedPages = pages("Pages active") + pages("Pages wired down") + pages("Pages occupied by compressor");

  return {
    processMb: Math.round(processKb / 1024),
    systemUsedMb: Math.round((usedPages * pageSize) / (1024 * 1024)),
  };
}

async function getJson<T>(url: string, method: "GET" | "POST" = "GET", signal?: AbortSignal): Promise<T> {
  const resp = await fetch(url, { method, signal, headers: AUTH_HEADERS });
  if (!resp.ok) throw new Error(`${method} ${url} failed (${resp.status})`);
  return (await resp.json()) as T;
}

// Benchmark mode is a 15-minute lease in the app, so it is refreshed before each question
async function refreshBenchmarkLease(appUrl: string): Promise<void> {
  await getJson(`${appUrl}/api/bench/start`, "POST");
}

async function stopBenchmark(appUrl: string): Promise<void> {
  await getJson(`${appUrl}/api/bench/stop`, "POST", AbortSignal.timeout(5000)).catch(() => undefined);
}

// Ctrl-C or a kill must not leave background jobs paused until the lease expires
function stopOnSignals(appUrl: string): void {
  const handler = (code: number) => (): void => {
    console.error("Interrupted — stopping benchmark mode");
    void stopBenchmark(appUrl).finally(() => process.exit(code));
  };
  process.once("SIGINT", handler(130));
  process.once("SIGTERM", handler(143));
}

async function ask(appUrl: string, question: string, runNumber: number): Promise<RunResult> {
  let answer = "";
  try {
    const resp = await fetch(`${appUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({ message: question, benchmark: true }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok || !resp.body) {
      return { run: runNumber, answer: "", timings: null, chunkIds: [], error: `HTTP ${resp.status}` };
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseLines(buffer);
      buffer = parsed.rest;

      for (const data of parsed.events) {
        const event = JSON.parse(data) as ChatEvent;
        if (event.error) {
          return { run: runNumber, answer, timings: null, chunkIds: [], error: event.error };
        }
        if (event.token) answer += event.token;
        if (event.done) {
          return { run: runNumber, answer, timings: event.timings ?? null, chunkIds: event.chunkIds ?? [] };
        }
      }
    }

    return { run: runNumber, answer, timings: null, chunkIds: [], error: "stream ended without a done event" };
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    const message = isTimeout ? "request timed out after 600 s" : err instanceof Error ? err.message : String(err);
    return { run: runNumber, answer, timings: null, chunkIds: [], error: message };
  }
}

async function waitForIdle(appUrl: string): Promise<void> {
  const deadline = Date.now() + IDLE_TIMEOUT_MS;
  while (true) {
    const status = await getJson<{ runningJobs: string[] }>(`${appUrl}/api/bench/status`);
    if (status.runningJobs.length === 0) return;
    await refreshBenchmarkLease(appUrl);
    if (Date.now() > deadline) throw new Error(`Background jobs still running: ${status.runningJobs.join(", ")}`);
    console.log(`Waiting for background jobs to finish: ${status.runningJobs.join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const questions = JSON.parse(await readFile(options.questionsPath, "utf-8")) as BenchQuestion[];

  const health = await getJson<{ status: string; stack: string }>(`${options.appUrl}/api/health`);
  if (health.status === "unhealthy") throw new Error(`PharmaITChat is unhealthy on the ${health.stack} stack`);
  const models = await getJson<{ chatModel: string; embeddingModel: string }>(`${options.appUrl}/api/chat/models`);
  const stack = health.stack;

  const environment: BenchEnvironment = {
    macos: run("sw_vers", ["-productVersion"]),
    chip: run("sysctl", ["-n", "machdep.cpu.brand_string"]),
    thermal: run("pmset", ["-g", "therm"]),
    stackVersion:
      stack === "mlx"
        ? run(join(process.cwd(), "python", "mlx-venv", "bin", "python"), [
            "-c",
            "import importlib.metadata as m; print('mlx', m.version('mlx'), 'mlx-lm', m.version('mlx-lm'))",
          ])
        : stack === "omlx"
          ? run(join(process.cwd(), "python", "omlx-venv", "bin", "omlx"), ["--version"])
          : stack === "splash"
            ? run(join(process.cwd(), "python", "splash-src", "splash"), ["--version"])
            : run("ollama", ["--version"]),
    chatModel: models.chatModel,
    embeddingModel: models.embeddingModel,
  };

  await refreshBenchmarkLease(options.appUrl);
  stopOnSignals(options.appUrl);
  const memoryPeak: MemoryPeak = { processMb: 0, systemUsedMb: 0 };
  const sampler = setInterval(() => {
    const sample = sampleMemory(stack);
    memoryPeak.processMb = Math.max(memoryPeak.processMb, sample.processMb);
    memoryPeak.systemUsedMb = Math.max(memoryPeak.systemUsedMb, sample.systemUsedMb);
  }, 1000);

  const startedAt = new Date().toISOString();
  const results: QuestionResult[] = [];

  try {
    await waitForIdle(options.appUrl);

    console.log(`Benchmarking ${stack}: ${questions.length} questions × ${options.runs} runs (plus one warm-up)`);
    await refreshBenchmarkLease(options.appUrl);
    await ask(options.appUrl, WARM_UP_QUESTION, 0); // warm-up, discarded

    for (const question of questions) {
      const runs: RunResult[] = [];
      for (let n = 1; n <= options.runs; n++) {
        await refreshBenchmarkLease(options.appUrl);
        const result = await ask(options.appUrl, question.question, n);
        runs.push(result);
        const summary = result.error
          ? `error: ${result.error}`
          : `TTFT ${result.timings?.ttftMs ?? 0} ms, ${(result.timings?.decodeTokPerSec ?? 0).toFixed(1)} tok/s`;
        console.log(`  ${question.id} run ${n}: ${summary}`);
      }
      results.push({ ...question, runs });
    }
  } finally {
    clearInterval(sampler);
    await stopBenchmark(options.appUrl);
  }

  const output: BenchmarkFile = {
    stack,
    startedAt,
    finishedAt: new Date().toISOString(),
    runsPerQuestion: options.runs,
    environment,
    memoryPeak,
    questions: results,
  };

  const dir = join(process.cwd(), "data", "benchmarks");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${stack}-${startedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(path, JSON.stringify(output, null, 2), "utf-8");
  console.log(`Saved ${path}`);
}

// Only run when executed as a script (npx tsx scripts/benchmark-stack.ts), not when imported
// (e.g. by a test importing stackPatterns) — otherwise importing this module would fire real
// requests against a running app. pathToFileURL (rather than a manual `file://` template) also
// works correctly behind a symlinked path.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
