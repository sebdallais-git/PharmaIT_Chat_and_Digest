import { describe, expect, it } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Keeps the host seam from eroding: a new `localhost:NNNN` in code means a machine detail outside
// config/host.yaml again. Comments and documentation lines are skipped.
const ROOTS = ["src", "mcp/src", "scripts", "python"];
const SKIP_DIRS = new Set(["node_modules", "omlx-src", "omlx-venv", "mlx-venv", "venv", "splash-src", "__pycache__", "tests"]);
const EXTENSIONS = [".ts", ".sh", ".py", ".mjs", ".js"];
// Known remaining literals (spec: "Out"). Each entry is a repo-relative path.
const ALLOWED_FILES = new Set([
  "python/utils/search.py", // deleted by chore/retire-legacy-rag
  "python/utils/vectordb.py", // deleted by chore/retire-legacy-rag
  "scripts/migrate-news-to-raw-documents.ts", // deleted by chore/retire-legacy-rag
  "python/smoke_embeddings.py", // hits are usage examples inside the module docstring; the URL is a CLI argument
]);
const LITERAL = /(?:localhost|127\.0\.0\.1):\d{2,5}/;

// Tracked files only: local virtualenvs and checkouts (python/.venv, omlx-src, ...) hold third-party
// code full of localhost examples, and differ from machine to machine. Repo-relative paths.
function files(): string[] {
  const tracked = execFileSync("git", ["ls-files", "--", ...ROOTS], { cwd: process.cwd(), encoding: "utf-8" });
  return tracked
    .split("\n")
    .filter((path) => EXTENSIONS.some((ext) => path.endsWith(ext)))
    .filter((path) => !path.split("/").some((segment) => SKIP_DIRS.has(segment)));
}

function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("#") || t.startsWith("*") || t.startsWith("/*") || t.startsWith('"""');
}

describe("no host:port literals outside config/host.yaml", () => {
  it("finds none in code", () => {
    const hits: string[] = [];
    const scanned = files();
    for (const rel of scanned) {
      if (ALLOWED_FILES.has(rel)) continue;
      readFileSync(join(process.cwd(), rel), "utf-8")
        .split("\n")
        .forEach((line, i) => {
          if (LITERAL.test(line) && !isComment(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    // An empty scan would pass vacuously (e.g. git missing or ROOTS renamed)
    expect(scanned.length).toBeGreaterThan(50);
    expect(hits).toEqual([]);
  });
});
