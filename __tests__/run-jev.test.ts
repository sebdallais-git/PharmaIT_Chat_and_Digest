import { describe, expect, it } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostTestEnv } from "./helpers/host-env.js";

const SCRIPT = join(process.cwd(), "scripts", "run-jev.sh");

// RUN_JEV_EXEC replaces the real server with a stub, the same hook
// scripts/run-mcp.sh uses (RUN_MCP_EXEC). No test starts open-jev.
function run(env: Record<string, string>): { stdout: string; status: number } {
  const runDir = mkdtempSync(join(tmpdir(), "run-jev-test-"));
  const stub = join(runDir, "stub.sh");
  writeFileSync(stub, "#!/usr/bin/env bash\nenv | grep -E '^(OPENJEV_API_KEY|HF_TOKEN|JEV_PORT|JEV_HOST|JEV_MODEL|JEV_MLX_CACHE_LIMIT)=' | sort\n");
  chmodSync(stub, 0o755);
  for (const [name, value] of Object.entries(env.tokens ? JSON.parse(env.tokens) : {})) {
    const p = join(runDir, name);
    writeFileSync(p, String(value));
    chmodSync(p, 0o600);
  }
  try {
    const stdout = execFileSync("bash", [SCRIPT], {
      env: { ...process.env, ...hostTestEnv(), PHARMALLM_RUN_DIR: runDir, RUN_JEV_EXEC: stub, ...env },
      encoding: "utf8",
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: `${e.stdout ?? ""}${e.stderr ?? ""}`, status: e.status ?? 1 };
  }
}

describe("run-jev.sh", () => {
  it("exports the scorer key and the HF token from data/run", () => {
    const { stdout, status } = run({ tokens: JSON.stringify({ "jev-token": "k1", "hf-token": "h1" }) });

    expect(status).toBe(0);
    expect(stdout).toContain("OPENJEV_API_KEY=k1");
    expect(stdout).toContain("HF_TOKEN=h1");
  });

  it("defaults to loopback on port 8010, leaving 8000 to the Splash stack", () => {
    const { stdout } = run({ tokens: JSON.stringify({ "jev-token": "k1", "hf-token": "h1" }) });

    expect(stdout).toContain("JEV_HOST=127.0.0.1");
    expect(stdout).toContain("JEV_PORT=8010");
  });

  // Mirrors run-mcp.sh: a service that holds a gated model and answers
  // decisions must not listen beyond loopback without a key.
  // The spec chose a 4-bit scorer (~3 GB beside the 27B on 48 GB). The server
  // was started without --model, so it loaded open-jev's 16-bit default (8 GB);
  // on 2026-09-27 free memory fell to 1-3 GB and scorer calls slowed from ~0.3 s
  // to 3-6 s. Measured on the 60 baseline gaps, the 4-bit model also agreed
  // with the 27B more often (91.2% vs 71.9%) and answered faster.
  it("serves the 4-bit model by default", () => {
    const { stdout, status } = run({ tokens: JSON.stringify({ "hf-token": "h1" }) });
    expect(status).toBe(0);
    expect(stdout).toContain("JEV_MODEL=models/gemma-3-4b-it-4bit");
  });

  it("lets JEV_MODEL choose another model", () => {
    const { stdout } = run({ JEV_MODEL: "models/gemma-3-4b-it", tokens: JSON.stringify({ "hf-token": "h1" }) });
    expect(stdout).toContain("JEV_MODEL=models/gemma-3-4b-it\n");
  });

  it("passes the model to openjev serve", () => {
    const script = readFileSync(join(process.cwd(), "scripts", "run-jev.sh"), "utf-8");
    // The launch spans two lines since the MLX cache cap; the serve arguments are on the second
    const serve = script.split("\n").find((l) => l.trim().startsWith("serve --host")) ?? "";
    expect(serve).toContain('--model "$JEV_MODEL"');
  });

  it("refuses a non-loopback host with no scorer key", () => {
    const { stdout, status } = run({ JEV_HOST: "0.0.0.0", tokens: JSON.stringify({ "hf-token": "h1" }) });

    expect(status).not.toBe(0);
    expect(stdout).toMatch(/refusing to listen/i);
  });

  it("refuses to start with no Hugging Face token, because the model is gated", () => {
    const { stdout, status } = run({ tokens: JSON.stringify({ "jev-token": "k1" }) });

    expect(status).not.toBe(0);
    expect(stdout).toMatch(/hf-token/);
  });

  // MLX keeps every freed GPU buffer for reuse. Each scorer call on a long page
  // allocates gigabytes (Gemma 3's 262k-word vocabulary), and with no cap the
  // process grew from 3 GB to 36 GB within 30 calls on 2026-09-28: 40 GB of swap
  // beside the 27B, which froze and was restarted by the watchdog, and a Telegram
  // "ping" took 7 minutes. On the same 72 real pages a 1 GiB cap held it at
  // 4.2 GB with no change in latency (1.56 s vs 1.59 s median).
  it("caps MLX's buffer cache at 1 GiB by default", () => {
    const { stdout, status } = run({ tokens: JSON.stringify({ "hf-token": "h1" }) });
    expect(status).toBe(0);
    expect(stdout).toContain("JEV_MLX_CACHE_LIMIT=1073741824");
  });

  it("takes another cap from the environment, and refuses one that is not a byte count", () => {
    expect(run({ tokens: JSON.stringify({ "hf-token": "h1" }), JEV_MLX_CACHE_LIMIT: "536870912" }).stdout).toContain(
      "JEV_MLX_CACHE_LIMIT=536870912",
    );
    const bad = run({ tokens: JSON.stringify({ "hf-token": "h1" }), JEV_MLX_CACHE_LIMIT: "1GB" });
    expect(bad.status).not.toBe(0);
    expect(bad.stdout).toMatch(/JEV_MLX_CACHE_LIMIT/);
  });

  it("sets the cap inside the server process before open-jev starts, from the environment", () => {
    const script = readFileSync(SCRIPT, "utf8");
    const launch = script.slice(script.lastIndexOf("exec "));
    expect(launch).toMatch(/mx\.set_cache_limit\(int\(os\.environ\["JEV_MLX_CACHE_LIMIT"\]\)\)/);
    expect(launch.indexOf("set_cache_limit")).toBeLessThan(launch.indexOf("from openjev.cli import main"));
    expect(launch).toContain('serve --host "$JEV_HOST" --port "$JEV_PORT" --model "$JEV_MODEL"');
  });
});
