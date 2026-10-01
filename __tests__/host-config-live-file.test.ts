import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHostConfig } from "../src/platform/host-config.js";

// The only test that reads the live config/host.yaml. It pins the mac-mini profile to the values
// that were hardcoded before the seam existed, so moving them into the file changed nothing.
// On a new machine, change this test together with the file, deliberately.
const livePath = join(process.cwd(), "config", "host.yaml");
const host = parseHostConfig(readFileSync(livePath, "utf-8"), livePath);

describe("config/host.yaml (mac-mini profile)", () => {
  it("keeps every endpoint where it was", () => {
    const ports = Object.fromEntries(Object.entries(host.endpoints).map(([name, e]) => [name, e.port]));
    expect(ports).toEqual({
      app: 3000, mcp: 3200, n8n: 5678, chromadb: 8100, neo4j: 7687, searxng: 8888, scorer: 8010,
      ollama: 11434, mlx_chat: 8080, mlx_embed: 8081, omlx: 8090, splash: 8000,
    });
    expect(host.endpoints.app.httpsPort).toBe(3443);
    expect(host.address).toBe("localhost");
    expect(host.endpoints.mcp.address).toBe("127.0.0.1");
    expect(host.endpoints.scorer.address).toBe("127.0.0.1");
    expect(host.endpoints.neo4j.scheme).toBe("bolt");
  });

  it("keeps the 2026-09-28/29 memory limits", () => {
    expect(host.resources).toEqual({
      mlxChat: { cacheLimitBytes: 2147483648, promptCacheBytes: 4294967296, promptConcurrency: 1, decodeConcurrency: 2 },
      mlxEmbed: { cacheLimitBytes: 536870912 },
      scorer: { cacheLimitBytes: 1073741824 },
      omlx: { ssdCacheMaxGb: 20 },
      ollama: { numParallel: 1 },
    });
  });

  it("matches the test fixture except for the name", () => {
    const fixturePath = join(process.cwd(), "__tests__", "fixtures", "host.yaml");
    const fixture = parseHostConfig(readFileSync(fixturePath, "utf-8"), fixturePath);
    expect({ ...fixture, name: host.name, path: host.path }).toEqual(host);
  });
});
