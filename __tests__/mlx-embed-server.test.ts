import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// MLX keeps freed GPU buffers for reuse with no cap, and every embedding is a
// forward pass over a different number of tokens (up to 8192). On 2026-09-29
// a test instance fed 150 real texts of varying length grew from 0.9 GB to
// 36 GB within 90 requests; a reindex embeds thousands. With a 512 MiB cap it
// stayed at 1.5 GB and answered slightly faster (median 425 vs 454 ms).
describe("mlx-embed-server.py memory", () => {
  const source = readFileSync(join(process.cwd(), "python", "mlx-embed-server.py"), "utf8");
  const main = source.slice(source.indexOf("def main()"));

  it("caps MLX's buffer cache from MLX_EMBED_CACHE_LIMIT, 512 MiB by default", () => {
    expect(source).toMatch(/os\.environ\.get\("MLX_EMBED_CACHE_LIMIT", "536870912"\)/);
    expect(main).toMatch(/mx\.set_cache_limit\(/);
  });

  it("sets the cap before the model loads", () => {
    expect(main.indexOf("set_cache_limit")).toBeGreaterThan(-1);
    expect(main.indexOf("set_cache_limit")).toBeLessThan(main.indexOf("Embedder(args.model)"));
  });

  it("refuses a cap that is not a byte count instead of starting uncapped", () => {
    expect(source).toMatch(/isdigit\(\)/);
    expect(source).toMatch(/SystemExit\(/);
  });
});
