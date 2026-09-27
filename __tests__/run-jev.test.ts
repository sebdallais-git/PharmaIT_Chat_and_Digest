import { describe, expect, it } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(process.cwd(), "scripts", "run-jev.sh");

// RUN_JEV_EXEC replaces the real server with a stub, the same hook
// scripts/run-mcp.sh uses (RUN_MCP_EXEC). No test starts open-jev.
function run(env: Record<string, string>): { stdout: string; status: number } {
  const runDir = mkdtempSync(join(tmpdir(), "run-jev-test-"));
  const stub = join(runDir, "stub.sh");
  writeFileSync(stub, "#!/usr/bin/env bash\nenv | grep -E '^(OPENJEV_API_KEY|HF_TOKEN|JEV_PORT|JEV_HOST|JEV_MODEL)=' | sort\n");
  chmodSync(stub, 0o755);
  for (const [name, value] of Object.entries(env.tokens ? JSON.parse(env.tokens) : {})) {
    const p = join(runDir, name);
    writeFileSync(p, String(value));
    chmodSync(p, 0o600);
  }
  try {
    const stdout = execFileSync("bash", [SCRIPT], {
      env: { ...process.env, PHARMALLM_RUN_DIR: runDir, RUN_JEV_EXEC: stub, ...env },
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
    const serve = script.split("\n").find((l) => l.includes("openjev serve")) ?? "";
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
});
