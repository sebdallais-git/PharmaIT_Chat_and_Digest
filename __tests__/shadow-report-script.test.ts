import { afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openShadowStore } from "../src/services/detection-shadow.js";

// scripts/shadow-report.ts opens gap_log.db read-only, then called
// openShadowStore(), which runs CREATE TABLE IF NOT EXISTS detection_shadow.
// The table only appears on the app's first detection after deploy, so
// running the report before any chat traffic crashed with "attempt to write a
// readonly database" instead of saying there were no rows yet.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("scripts/shadow-report.ts", () => {
  it("says there are no rows yet when detection_shadow does not exist, and leaves the database alone", () => {
    const root = mkdtempSync(join(tmpdir(), "shadow-report-"));
    dirs.push(root);
    mkdirSync(join(root, "data"));
    const dbPath = join(root, "data", "gap_log.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE gap_log (id INTEGER PRIMARY KEY)");
    db.close();

    const result = spawnSync(
      join(process.cwd(), "node_modules", ".bin", "tsx"),
      [join(process.cwd(), "scripts", "shadow-report.ts")],
      { cwd: root, encoding: "utf-8" },
    );

    expect(result.stderr).not.toMatch(/readonly database/);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No shadow rows yet");
    const after = new Database(dbPath, { readonly: true });
    const tables = after.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    after.close();
    expect(tables.map((t) => t.name)).toEqual(["gap_log"]);
  });

  it("prints the agreement report when rows exist, and exits cleanly", () => {
    const root = mkdtempSync(join(tmpdir(), "shadow-report-"));
    dirs.push(root);
    mkdirSync(join(root, "data"));
    const db = new Database(join(root, "data", "gap_log.db"));
    const store = openShadowStore(db);
    store.record({
      timestamp: "2026-09-27T06:00:00.000Z",
      queryExcerpt: "Which ERP did Sandoz choose?",
      llmConfident: false,
      scorerVerdict: "unresolved",
      scorerProbability: 0.2,
      scorerError: null,
    });
    db.close();

    const result = spawnSync(
      join(process.cwd(), "node_modules", ".bin", "tsx"),
      [join(process.cwd(), "scripts", "shadow-report.ts")],
      { cwd: root, encoding: "utf-8" },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("turns recorded:");
  });
});
