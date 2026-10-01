import { describe, expect, it } from "@jest/globals";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

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

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : files(join(dir, entry.name));
    return EXTENSIONS.some((ext) => entry.name.endsWith(ext)) ? [join(dir, entry.name)] : [];
  });
}

function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("#") || t.startsWith("*") || t.startsWith("/*") || t.startsWith('"""');
}

describe("no host:port literals outside config/host.yaml", () => {
  it("finds none in code", () => {
    const hits: string[] = [];
    for (const root of ROOTS) {
      for (const file of files(join(process.cwd(), root))) {
        const rel = relative(process.cwd(), file);
        if (ALLOWED_FILES.has(rel)) continue;
        readFileSync(file, "utf-8")
          .split("\n")
          .forEach((line, i) => {
            if (LITERAL.test(line) && !isComment(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
          });
      }
    }
    expect(hits).toEqual([]);
  });
});
