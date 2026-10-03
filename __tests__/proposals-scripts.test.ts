import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostTestEnv } from "./helpers/host-env.js";

// Review of #67: "--status" on a hand-edited file with a YAML mistake printed a
// stack trace. A bad file or flag is the user's to fix: one line, exit 1.
// Both cases stop before any model, store or network is touched.

const TSX = join(process.cwd(), "node_modules", ".bin", "tsx");

function run(script: string, args: string[], files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "proposals-cli-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return spawnSync(TSX, [join(process.cwd(), "scripts", script), ...args], {
    cwd: dir,
    encoding: "utf-8",
    env: { ...process.env, ...hostTestEnv() },
    timeout: 60_000,
  });
}

describe("proposals scripts report a bad file or flag in one line", () => {
  it.each([
    ["extract-need-evidence.ts", "config/need-evidence.local.yaml"],
    ["extract-install-history.ts", "config/install-history.local.yaml"],
  ])("%s --status on a malformed file", (script, path) => {
    const result = run(script, ["--status"], { [path]: "entries:\n  x-1: {status: approved}\n" });
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(`${path}: entries must be a list`);
  });

  it("extract-need-evidence.ts --only without a file", () => {
    const result = run("extract-need-evidence.ts", ["--only"], {});
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("--only needs a file, e.g. --only knowledge/<file>");
  });
});
