import { describe, expect, it } from "@jest/globals";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// src/platform/ moves to the Sils_Healthcare repo as-is when the Studio arrives. It may import
// node builtins, yaml, the generic env-name helper and its own files -- never app services.
const platformDir = join(process.cwd(), "src", "platform");
const ALLOWED = [/^node:/, /^yaml$/, /^\.\.\/config\/env-names\.js$/, /^\.\/[a-z0-9-]+\.js$/];

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? tsFiles(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : [],
  );
}

describe("src/platform import boundary", () => {
  const files = tsFiles(platformDir);

  it("has files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((file) => [relative(process.cwd(), file), file]))("%s imports only allowed modules", (_name, file) => {
    const source = readFileSync(file, "utf-8");
    const specifiers = [...source.matchAll(/(?:^|\n)\s*(?:import|export)[^'"]*?from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    const dynamic = [...source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    const offending = [...specifiers, ...dynamic].filter((spec) => !ALLOWED.some((pattern) => pattern.test(spec)));
    expect(offending).toEqual([]);
  });
});
