import { afterEach, describe, expect, it } from "@jest/globals";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENDPOINT_NAMES,
  HostConfigError,
  endpointUrl,
  hostConfigPath,
  hostSummary,
  loadHostConfig,
  parseHostConfig,
  serviceUrl,
} from "../src/platform/host-config.js";

const fixturePath = join(process.cwd(), "__tests__", "fixtures", "host.yaml");
const fixture = readFileSync(fixturePath, "utf-8");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function problemsOf(text: string): string[] {
  try {
    parseHostConfig(text, "test.yaml");
  } catch (err) {
    if (err instanceof HostConfigError) return err.problems;
    throw err;
  }
  throw new Error("expected a HostConfigError");
}

describe("parseHostConfig", () => {
  it("reads every endpoint and resource from a valid file", () => {
    const host = parseHostConfig(fixture, "fixture.yaml");
    expect(host.name).toBe("test-host");
    expect(host.path).toBe("fixture.yaml");
    expect(Object.keys(host.endpoints).sort()).toEqual([...ENDPOINT_NAMES].sort());
    expect(host.endpoints.chromadb).toEqual({ address: "localhost", port: 8100, scheme: "http", httpsPort: null });
    expect(host.endpoints.app.httpsPort).toBe(3443);
    expect(host.endpoints.scorer.address).toBe("127.0.0.1");
    expect(host.endpoints.neo4j.scheme).toBe("bolt");
    expect(host.resources.mlxChat).toEqual({
      cacheLimitBytes: 2147483648,
      promptCacheBytes: 4294967296,
      promptConcurrency: 1,
      decodeConcurrency: 2,
    });
    expect(host.resources.omlx.ssdCacheMaxGb).toBe(20);
  });

  it("lists every problem at once, not just the first", () => {
    const text = fixture
      .replace("chromadb:  { port: 8100 }", "chromadb:  { port: 99999 }")
      .replace("cache_limit_bytes: 536870912", "cache_limit_bytes: 1.5")
      .replace(/^  omlx:      \{ port: 8090 \}\n/m, "");
    const problems = problemsOf(text);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("endpoints.chromadb.port"),
        expect.stringContaining("resources.mlx_embed.cache_limit_bytes"),
        expect.stringContaining("endpoints.omlx is missing"),
      ]),
    );
    expect(problems).toHaveLength(3);
  });

  it("rejects duplicate ports, naming both owners", () => {
    const problems = problemsOf(fixture.replace("scorer:    { port: 8010", "scorer:    { port: 8000"));
    expect(problems).toEqual([expect.stringMatching(/endpoints\.scorer\.port 8000 .*endpoints\.splash\.port/)]);
  });

  it("counts https_port as a port", () => {
    const problems = problemsOf(fixture.replace("https_port: 3443", "https_port: 8100"));
    expect(problems).toEqual([expect.stringMatching(/8100/)]);
  });

  it("rejects unsafe addresses so host-env.ts output is safe to eval", () => {
    const problems = problemsOf(fixture.replace("address: localhost", 'address: "localhost; rm -rf ~"'));
    expect(problems).toEqual([expect.stringContaining("host.address")]);
  });

  it("rejects an unknown endpoint name (a typo would otherwise be ignored)", () => {
    const problems = problemsOf(fixture.replace("n8n:       { port: 5678 }", "n8n:       { port: 5678 }\n  chromdb:   { port: 9999 }"));
    expect(problems).toEqual([expect.stringContaining("endpoints.chromdb")]);
  });

  it("reports invalid YAML as a HostConfigError", () => {
    expect(() => parseHostConfig("host: [", "bad.yaml")).toThrow(HostConfigError);
    expect(() => parseHostConfig("host: [", "bad.yaml")).toThrow(/bad\.yaml/);
  });
});

describe("hostConfigPath / loadHostConfig", () => {
  it("follows PHARMAITCHAT_HOST_CONFIG, then the legacy PHARMALLM_ name", () => {
    expect(hostConfigPath({ PHARMAITCHAT_HOST_CONFIG: "/a.yaml", PHARMALLM_HOST_CONFIG: "/b.yaml" })).toBe("/a.yaml");
    expect(hostConfigPath({ PHARMALLM_HOST_CONFIG: "/b.yaml" })).toBe("/b.yaml");
  });

  it("defaults to config/host.yaml in the project, whatever the cwd", () => {
    expect(hostConfigPath({})).toBe(join(process.cwd(), "config", "host.yaml"));
  });

  it("loads the file the env points at", () => {
    const dir = mkdtempSync(join(tmpdir(), "host-config-"));
    dirs.push(dir);
    const path = join(dir, "host.yaml");
    writeFileSync(path, fixture.replace("name: test-host", "name: studio"));
    expect(loadHostConfig({ PHARMAITCHAT_HOST_CONFIG: path }).name).toBe("studio");
  });

  it("uses the fixture in tests (jest setup file)", () => {
    expect(loadHostConfig().name).toBe("test-host");
  });
});

describe("endpointUrl / serviceUrl", () => {
  const host = parseHostConfig(fixture, "fixture.yaml");

  it("builds scheme://address:port", () => {
    expect(endpointUrl(host, "chromadb")).toBe("http://localhost:8100");
    expect(endpointUrl(host, "neo4j")).toBe("bolt://localhost:7687");
    expect(endpointUrl(host, "scorer")).toBe("http://127.0.0.1:8010");
  });

  it("brackets an IPv6 address", () => {
    const v6 = parseHostConfig(fixture.replace("address: localhost", 'address: "::1"'), "v6.yaml");
    expect(endpointUrl(v6, "ollama")).toBe("http://[::1]:11434");
  });

  it("lets the existing env var win over the file", () => {
    expect(serviceUrl("ollama", { OLLAMA_URL: "http://gpu-box:11434/" }, host)).toBe("http://gpu-box:11434");
    expect(serviceUrl("neo4j", { NEO4J_URI: "bolt://db:7687" }, host)).toBe("bolt://db:7687");
    expect(serviceUrl("app", { PHARMALLM_URL: "http://old:3000" }, host)).toBe("http://old:3000");
    expect(serviceUrl("app", { PHARMAITCHAT_URL: "http://new:3000", PHARMALLM_URL: "http://old:3000" }, host)).toBe(
      "http://new:3000",
    );
  });

  it("ignores blank overrides", () => {
    expect(serviceUrl("chromadb", { CHROMADB_URL: "  " }, host)).toBe("http://localhost:8100");
  });

  it("falls back to the file when no override is set", () => {
    expect(serviceUrl("mlx_embed", {}, host)).toBe("http://localhost:8081");
  });
});

describe("hostSummary", () => {
  it("names the profile, its file and the applied resources", () => {
    const host = parseHostConfig(fixture, "fixture.yaml");
    expect(hostSummary(host)).toEqual({ name: "test-host", config: "fixture.yaml", resources: host.resources });
  });
});
