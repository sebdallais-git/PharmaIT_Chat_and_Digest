# Host Config Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every endpoint and machine-sized resource limit comes from one file, `config/host.yaml`, with no behaviour change on the mac-mini.

**Architecture:** A pure, validated loader in `src/platform/host-config.ts` (first file of the future Sils_Healthcare `platform/` layer) is the only parser. TypeScript consumers call `serviceUrl()` / `loadHostConfig()`; bash scripts source `scripts/lib/host.sh`, which runs `scripts/lib/host-env.ts` through `node --import tsx` and `eval`s its `export NAME="${NAME:-value}"` lines. Existing env vars keep precedence everywhere.

**Tech Stack:** TypeScript ESM (Node16 modules, strict), `yaml` ^2.9, Jest 30 + ts-jest ESM, bash, tsx.

**Spec:** `docs/superpowers/specs/2026-09-30-host-config-seam-design.md`

**Work only in the worktree** `/Users/seb/claude/PharmaLLM/.worktrees/host-config` (branch `feature/host-config`). The main checkout runs the live app under `tsx watch`; never edit files there.

**Deviations from the spec, found while planning (all narrower, none wider):**
- `python/utils/{search,vectordb}.py` and `scripts/migrate-news-to-raw-documents.ts` are left alone and allow-listed: branch `chore/retire-legacy-rag` deletes them.
- `endpoints.mcp` and `endpoints.scorer` carry `address: 127.0.0.1`, because that is what `run-mcp.sh`, `run-jev.sh`, `hermes-setup.sh` and `decide.yaml` use today.
- `scripts/mlx-watchdog.sh` needs no change: it already asks `switch-stack.sh chat-endpoint` for its port, and `switch-stack.sh` gets it from `host.sh`.

## Global Constraints

- No behaviour change on the mac-mini: every value in `config/host.yaml` equals today's hardcoded value (pinned by `host-config-live-file.test.ts`).
- Precedence per value: existing env var (names unchanged) → `config/host.yaml` → nothing. No hardcoded default left in code.
- `PHARMAITCHAT_HOST_CONFIG` (fallback `PHARMALLM_HOST_CONFIG`) overrides the file location; read with `readEnvWithFallback` from `src/config/env-names.ts`.
- `src/platform/**` imports only `node:*`, `yaml`, `../config/env-names.js` and each other.
- Invalid host config = loud failure listing every problem. No silent fallback.
- Tests never read `config/host.yaml` (except `host-config-live-file.test.ts`) and never touch live services. Jest points every test process at `__tests__/fixtures/host.yaml` through a setup file.
- ES modules only, no `any`, kebab-case filenames, comments in English, commit prefixes `feat:`/`refactor:`/`test:`/`docs:`, every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- After every task: `npm run typecheck` and `npm run typecheck:tests` pass.

## Review Focus

1. **A script test runs with `PATH=/usr/bin:/bin` (no node).** Expect: `host.sh` uses `NODE_BIN` when set, and fails with "node not found" otherwise — never a silent empty port. Pinned in Task 2 (`host-env.test.ts`, "fails loudly without node").
2. **An env var set to an empty string** (e.g. `OLLAMA_URL=`). Expect: treated as absent, the file value is used, as `readEnvWithFallback` already does for other names. Pinned in Task 1 (`serviceUrl` "ignores blank overrides").
3. **Two services given the same port in host.yaml** (the Splash/scorer 8000 clash that once happened). Expect: load error naming both. Pinned in Task 1 ("rejects duplicate ports").
4. **A `base_url` left in `config/decide.yaml` after the move.** Expect: load error pointing at host.yaml, not a quietly ignored second source. Pinned in Task 5.
5. **An address with shell metacharacters in host.yaml** (`localhost; rm -rf`). Expect: rejected at parse, so `host-env.ts` output is always safe to `eval`. Pinned in Task 1 ("rejects unsafe addresses").

---

### Task 1: Host config module, file, fixture and Jest wiring

**Files:**
- Create: `config/host.yaml`
- Create: `src/platform/host-config.ts`
- Create: `__tests__/fixtures/host.yaml`
- Create: `__tests__/setup/host-config-env.ts`
- Create: `__tests__/host-config.test.ts`
- Create: `__tests__/host-config-live-file.test.ts`
- Create: `__tests__/platform-boundary.test.ts`
- Modify: `jest.config.js` (add `setupFiles`)
- Modify: `mcp/jest.config.js` (add `setupFiles`)

**Interfaces:**
- Produces (exact exports of `src/platform/host-config.ts`):
  - `ENDPOINT_NAMES: readonly ["app","mcp","n8n","chromadb","neo4j","searxng","scorer","ollama","mlx_chat","mlx_embed","omlx","splash"]`
  - `type EndpointName`
  - `interface Endpoint { address: string; port: number; scheme: string; httpsPort: number | null }`
  - `interface HostResources { mlxChat: { cacheLimitBytes: number; promptCacheBytes: number; promptConcurrency: number; decodeConcurrency: number }; mlxEmbed: { cacheLimitBytes: number }; scorer: { cacheLimitBytes: number }; omlx: { ssdCacheMaxGb: number }; ollama: { numParallel: number } }`
  - `interface HostConfig { name: string; address: string; path: string; endpoints: Record<EndpointName, Endpoint>; resources: HostResources }`
  - `class HostConfigError extends Error { readonly path: string; readonly problems: string[] }`
  - `parseHostConfig(text: string, path: string): HostConfig`
  - `hostConfigPath(env?: NodeJS.ProcessEnv): string`
  - `loadHostConfig(env?: NodeJS.ProcessEnv): HostConfig` (cached per resolved path)
  - `endpointUrl(host: HostConfig, name: EndpointName): string`
  - `serviceUrl(name: EndpointName, env?: NodeJS.ProcessEnv, host?: HostConfig): string`
  - `hostSummary(host: HostConfig): { name: string; config: string; resources: HostResources }`
- Produces: `__tests__/fixtures/host.yaml` (name `test-host`, same endpoint/resource values as the live file).

- [ ] **Step 1: Create the live file `config/host.yaml`**

```yaml
# Host profile: everything tied to the machine PharmaITChat runs on.
# Moving to another machine means editing this file and nothing else
# (Sils_Healthcare rule: no hostname, home path or machine port in code).
# docs/superpowers/specs/2026-09-30-host-config-seam-design.md
#
# Every value can still be overridden by the env var that overrode it before
# (OLLAMA_URL, CHROMADB_URL, MLX_CACHE_LIMIT, ...). Read by
# src/platform/host-config.ts; bash scripts get it through scripts/lib/host.sh.

host:
  name: mac-mini          # label only (/api/health); nothing branches on it
  address: localhost      # every endpoint's address unless it sets its own

endpoints:
  app:       { port: 3000, https_port: 3443 }
  mcp:       { port: 3200, address: 127.0.0.1 }   # run-mcp.sh binds loopback only
  n8n:       { port: 5678 }
  chromadb:  { port: 8100 }
  neo4j:     { port: 7687, scheme: bolt }
  searxng:   { port: 8888 }
  # 8010, not 8000: Splash binds 127.0.0.1:8000 by default, and running the
  # scorer alongside a stack is the normal case.
  scorer:    { port: 8010, address: 127.0.0.1 }
  ollama:    { port: 11434 }
  mlx_chat:  { port: 8080 }
  mlx_embed: { port: 8081 }
  omlx:      { port: 8090 }
  splash:    { port: 8000 }

# Sized for a 48 GB mac-mini. Retune on a bigger machine.
resources:
  mlx_chat:
    # On 2026-09-29 six concurrent ~7.5k-token requests took mlx_lm.server from
    # 23 GB to 36 GB and all six failed with a Metal "Insufficient Memory" error;
    # the generation thread died while the server kept accepting requests, so
    # Hermes and chat hung until the watchdog restarted it. With these limits the
    # same load passed 6/6 at a 27 GB peak in the same wall time.
    # Freed GPU buffers MLX keeps for reuse (uncapped by default). Bytes.
    cache_limit_bytes: 2147483648
    # Cached prompts (several 64k agent prompts would otherwise pile up). Bytes.
    prompt_cache_bytes: 4294967296
    # Requests worked on at once; the defaults (8 prefills, 32 decodes) each hold
    # a 27B KV cache. A burst queues instead of exhausting Metal memory.
    prompt_concurrency: 1
    decode_concurrency: 2
  mlx_embed:
    # Every embedding is a forward pass over a different number of tokens:
    # uncapped, a test instance grew from 0.9 GB to 36 GB within 90 varied
    # requests (2026-09-29). 512 MiB held it at 1.5 GB with no loss of speed.
    cache_limit_bytes: 536870912
  scorer:
    # A scorer call on a long page allocates gigabytes (Gemma 3's vocabulary is
    # 262k words). Uncapped, open-jev grew from 3 GB to 36 GB within 30 calls on
    # 2026-09-28; a 1 GiB cap held it at 4.2 GB with no change in latency.
    cache_limit_bytes: 1073741824
  omlx:
    # The paged SSD prefix cache is unbounded; it reached 4.3 GB in two short sessions.
    ssd_cache_max_gb: 20
  ollama:
    # Each parallel slot allocates its own 64k context. Informational: Ollama is
    # a Homebrew service and reads OLLAMA_NUM_PARALLEL from launchctl.
    num_parallel: 1
```

- [ ] **Step 2: Create the test fixture `__tests__/fixtures/host.yaml`**

Same values as the live file, no comments, `name: test-host`:

```yaml
host:
  name: test-host
  address: localhost
endpoints:
  app:       { port: 3000, https_port: 3443 }
  mcp:       { port: 3200, address: 127.0.0.1 }
  n8n:       { port: 5678 }
  chromadb:  { port: 8100 }
  neo4j:     { port: 7687, scheme: bolt }
  searxng:   { port: 8888 }
  scorer:    { port: 8010, address: 127.0.0.1 }
  ollama:    { port: 11434 }
  mlx_chat:  { port: 8080 }
  mlx_embed: { port: 8081 }
  omlx:      { port: 8090 }
  splash:    { port: 8000 }
resources:
  mlx_chat: { cache_limit_bytes: 2147483648, prompt_cache_bytes: 4294967296, prompt_concurrency: 1, decode_concurrency: 2 }
  mlx_embed: { cache_limit_bytes: 536870912 }
  scorer: { cache_limit_bytes: 1073741824 }
  omlx: { ssd_cache_max_gb: 20 }
  ollama: { num_parallel: 1 }
```

- [ ] **Step 3: Create the Jest setup file `__tests__/setup/host-config-env.ts`**

```ts
// Every Jest process reads the fixture host profile, never config/host.yaml: tests must not
// depend on the machine they run on. Child processes spawned with { ...process.env } inherit it;
// tests that build their own env add hostTestEnv() from __tests__/helpers/host-env.ts.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.PHARMAITCHAT_HOST_CONFIG = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "host.yaml");
```

Add to `jest.config.js`, after `testMatch`:

```js
  // Points PHARMAITCHAT_HOST_CONFIG at __tests__/fixtures/host.yaml before any test module loads
  setupFiles: ["<rootDir>/__tests__/setup/host-config-env.ts"],
```

Add to `mcp/jest.config.js`, after `testMatch`:

```js
  // Same fixture host profile as the app's tests (the MCP config reads src/platform/host-config.ts)
  setupFiles: ["<rootDir>/../__tests__/setup/host-config-env.ts"],
```

- [ ] **Step 4: Write the failing tests `__tests__/host-config.test.ts`**

```ts
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
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npm test -- __tests__/host-config.test.ts`
Expected: FAIL — `Cannot find module '../src/platform/host-config.js'`.

- [ ] **Step 6: Implement `src/platform/host-config.ts`**

```ts
// Host profile: everything tied to the machine this runs on -- service endpoints and the
// memory/concurrency limits sized for it -- read from one file, config/host.yaml.
// First piece of the Sils_Healthcare platform/ layer: imports only node:*, yaml and env-names
// (enforced by __tests__/platform-boundary.test.ts) so the folder can move as-is.
// docs/superpowers/specs/2026-09-30-host-config-seam-design.md

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { readEnvWithFallback } from "../config/env-names.js";

export const ENDPOINT_NAMES = [
  "app", "mcp", "n8n", "chromadb", "neo4j", "searxng", "scorer",
  "ollama", "mlx_chat", "mlx_embed", "omlx", "splash",
] as const;
export type EndpointName = (typeof ENDPOINT_NAMES)[number];

export interface Endpoint {
  address: string;
  port: number;
  scheme: string;
  httpsPort: number | null;
}

export interface HostResources {
  mlxChat: { cacheLimitBytes: number; promptCacheBytes: number; promptConcurrency: number; decodeConcurrency: number };
  mlxEmbed: { cacheLimitBytes: number };
  scorer: { cacheLimitBytes: number };
  omlx: { ssdCacheMaxGb: number };
  ollama: { numParallel: number };
}

export interface HostConfig {
  name: string;
  address: string;
  path: string;
  endpoints: Record<EndpointName, Endpoint>;
  resources: HostResources;
}

export class HostConfigError extends Error {
  constructor(
    readonly path: string,
    readonly problems: string[],
  ) {
    super(`Invalid host config ${path}:\n  - ${problems.join("\n  - ")}`);
    this.name = "HostConfigError";
  }
}

// Hostname, IPv4 or bare IPv6. Also what keeps scripts/lib/host-env.ts output safe to eval.
const ADDRESS_PATTERN = /^[A-Za-z0-9.:-]+$/;
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/;

// The env var that already overrode each endpoint before this file existed. Names unchanged.
const URL_OVERRIDES: Partial<Record<EndpointName, string>> = {
  ollama: "OLLAMA_URL",
  mlx_chat: "MLX_CHAT_URL",
  mlx_embed: "MLX_EMBED_URL",
  omlx: "OMLX_URL",
  splash: "SPLASH_URL",
  chromadb: "CHROMADB_URL",
  neo4j: "NEO4J_URI",
  searxng: "SEARXNG_URL",
};

const DEFAULT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "host.yaml");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Every reader below records a problem and returns a placeholder instead of throwing, so one
// parse reports everything wrong with the file.
function section(raw: Record<string, unknown>, key: string, where: string, problems: string[]): Record<string, unknown> {
  const value = raw[key];
  if (isRecord(value)) return value;
  problems.push(`${where}${key} is missing or not a mapping`);
  return {};
}

function readString(raw: Record<string, unknown>, key: string, where: string, problems: string[]): string {
  const value = raw[key];
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  problems.push(`${where}.${key} must be a non-empty string`);
  return "";
}

function readAddress(raw: Record<string, unknown>, key: string, where: string, problems: string[]): string {
  const value = raw[key];
  if (typeof value === "string" && ADDRESS_PATTERN.test(value)) return value;
  problems.push(`${where}.${key} must be a hostname or IP address, got ${JSON.stringify(value)}`);
  return "";
}

function readPort(raw: Record<string, unknown>, key: string, where: string, problems: string[]): number {
  const value = raw[key];
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535) return value;
  problems.push(`${where}.${key} must be an integer between 1 and 65535, got ${JSON.stringify(value)}`);
  return 0;
}

function readPositive(raw: Record<string, unknown>, key: string, where: string, problems: string[]): number {
  const value = raw[key];
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  problems.push(`${where}.${key} must be a positive integer, got ${JSON.stringify(value)}`);
  return 0;
}

function readEndpoint(raw: Record<string, unknown>, where: string, hostAddress: string, problems: string[]): Endpoint {
  let scheme = "http";
  if (raw.scheme !== undefined) {
    if (typeof raw.scheme === "string" && SCHEME_PATTERN.test(raw.scheme)) scheme = raw.scheme;
    else problems.push(`${where}.scheme must be a URL scheme such as http or bolt, got ${JSON.stringify(raw.scheme)}`);
  }
  return {
    address: raw.address === undefined ? hostAddress : readAddress(raw, "address", where, problems),
    port: readPort(raw, "port", where, problems),
    scheme,
    httpsPort: raw.https_port === undefined ? null : readPort(raw, "https_port", where, problems),
  };
}

export function parseHostConfig(text: string, path: string): HostConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new HostConfigError(path, [`not valid YAML: ${err instanceof Error ? err.message : String(err)}`]);
  }
  if (!isRecord(raw)) throw new HostConfigError(path, ["expected a YAML mapping"]);

  const problems: string[] = [];
  const host = section(raw, "host", "", problems);
  const name = readString(host, "name", "host", problems);
  const address = readAddress(host, "address", "host", problems);

  const endpointsRaw = section(raw, "endpoints", "", problems);
  const endpoints: Partial<Record<EndpointName, Endpoint>> = {};
  for (const endpoint of ENDPOINT_NAMES) {
    const entry = endpointsRaw[endpoint];
    if (!isRecord(entry)) {
      problems.push(`endpoints.${endpoint} is missing`);
      continue;
    }
    endpoints[endpoint] = readEndpoint(entry, `endpoints.${endpoint}`, address, problems);
  }
  for (const key of Object.keys(endpointsRaw)) {
    if (!(ENDPOINT_NAMES as readonly string[]).includes(key)) {
      problems.push(`endpoints.${key} is not a known service (expected one of: ${ENDPOINT_NAMES.join(", ")})`);
    }
  }

  // Two services on one port is how the scorer once shadowed Splash on 8000
  const owners = new Map<number, string>();
  for (const endpoint of ENDPOINT_NAMES) {
    const entry = endpoints[endpoint];
    if (!entry) continue;
    const claims: Array<[string, number | null]> = [
      [`endpoints.${endpoint}.port`, entry.port],
      [`endpoints.${endpoint}.https_port`, entry.httpsPort],
    ];
    for (const [label, port] of claims) {
      if (port === null || port === 0) continue;
      const owner = owners.get(port);
      if (owner) problems.push(`${owner} ${port} is also claimed by ${label}`);
      else owners.set(port, label);
    }
  }

  const res = section(raw, "resources", "", problems);
  const mlxChat = section(res, "mlx_chat", "resources.", problems);
  const mlxEmbed = section(res, "mlx_embed", "resources.", problems);
  const scorer = section(res, "scorer", "resources.", problems);
  const omlx = section(res, "omlx", "resources.", problems);
  const ollama = section(res, "ollama", "resources.", problems);
  const resources: HostResources = {
    mlxChat: {
      cacheLimitBytes: readPositive(mlxChat, "cache_limit_bytes", "resources.mlx_chat", problems),
      promptCacheBytes: readPositive(mlxChat, "prompt_cache_bytes", "resources.mlx_chat", problems),
      promptConcurrency: readPositive(mlxChat, "prompt_concurrency", "resources.mlx_chat", problems),
      decodeConcurrency: readPositive(mlxChat, "decode_concurrency", "resources.mlx_chat", problems),
    },
    mlxEmbed: { cacheLimitBytes: readPositive(mlxEmbed, "cache_limit_bytes", "resources.mlx_embed", problems) },
    scorer: { cacheLimitBytes: readPositive(scorer, "cache_limit_bytes", "resources.scorer", problems) },
    omlx: { ssdCacheMaxGb: readPositive(omlx, "ssd_cache_max_gb", "resources.omlx", problems) },
    ollama: { numParallel: readPositive(ollama, "num_parallel", "resources.ollama", problems) },
  };

  if (problems.length > 0) throw new HostConfigError(path, problems);
  return { name, address, path, endpoints: endpoints as Record<EndpointName, Endpoint>, resources };
}

export function hostConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return readEnvWithFallback(env, "HOST_CONFIG") ?? DEFAULT_PATH;
}

const cache = new Map<string, HostConfig>();

// Cached per path: the file is read once per process. Edits take effect on restart, like every
// other config file the app reads at startup.
export function loadHostConfig(env: NodeJS.ProcessEnv = process.env): HostConfig {
  const path = hostConfigPath(env);
  const cached = cache.get(path);
  if (cached) return cached;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new HostConfigError(path, [`cannot read the file: ${err instanceof Error ? err.message : String(err)}`]);
  }
  const host = parseHostConfig(text, path);
  cache.set(path, host);
  return host;
}

export function endpointUrl(host: HostConfig, name: EndpointName): string {
  const endpoint = host.endpoints[name];
  const address = endpoint.address.includes(":") ? `[${endpoint.address}]` : endpoint.address;
  return `${endpoint.scheme}://${address}:${endpoint.port}`;
}

// The URL a consumer should call: the service's existing env override when set (blank counts as
// unset), else the host file. The file is only read when no override applies. Its location always
// comes from process.env, not from `env`: callers pass a partial env to override URLs, and that
// must not silently redirect them to the default file.
export function serviceUrl(name: EndpointName, env: NodeJS.ProcessEnv = process.env, host?: HostConfig): string {
  const overrideName = URL_OVERRIDES[name];
  const override = name === "app" ? readEnvWithFallback(env, "URL") : overrideName ? env[overrideName]?.trim() : undefined;
  if (override) return override.replace(/\/+$/, "");
  return endpointUrl(host ?? loadHostConfig(), name);
}

export function hostSummary(host: HostConfig): { name: string; config: string; resources: HostResources } {
  return { name: host.name, config: host.path, resources: host.resources };
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -- __tests__/host-config.test.ts`
Expected: PASS. If "rejects duplicate ports" fails on wording, fix the message in the implementation, not the regex: the problem must name both `endpoints.scorer.port` (first owner, it comes earlier in `ENDPOINT_NAMES`) and `endpoints.splash.port`.

- [ ] **Step 8: Write `__tests__/host-config-live-file.test.ts`**

```ts
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
```

- [ ] **Step 9: Write `__tests__/platform-boundary.test.ts`**

```ts
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
```

- [ ] **Step 10: Run the three new test files, the MCP suite and both typechecks**

Run: `npm test -- __tests__/host-config.test.ts __tests__/host-config-live-file.test.ts __tests__/platform-boundary.test.ts && npm --prefix mcp test && npm run typecheck && npm run typecheck:tests`
Expected: all PASS (the MCP suite proves its new `setupFiles` path resolves).

- [ ] **Step 11: Commit**

```bash
git add config/host.yaml src/platform/host-config.ts __tests__/fixtures/host.yaml __tests__/setup/host-config-env.ts \
  __tests__/host-config.test.ts __tests__/host-config-live-file.test.ts __tests__/platform-boundary.test.ts \
  jest.config.js mcp/jest.config.js
git commit -m "feat: host profile in config/host.yaml with a validated loader" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Bash bridge (`host-env.ts` + `host.sh`)

**Files:**
- Create: `scripts/lib/host-env.ts`
- Create: `scripts/lib/host.sh`
- Create: `__tests__/helpers/host-env.ts`
- Create: `__tests__/host-env.test.ts`

**Interfaces:**
- Consumes: `loadHostConfig()`, `HostConfigError` from Task 1.
- Produces, exported by sourcing `scripts/lib/host.sh` (each keeps a value already in the environment):
  `PHARMAITCHAT_HOST_NAME PHARMAITCHAT_HOST_ADDRESS APP_PORT APP_HTTPS_PORT MCP_HOST MCP_PORT N8N_PORT CHROMADB_PORT NEO4J_PORT SEARXNG_PORT JEV_HOST JEV_PORT OLLAMA_PORT MLX_CHAT_PORT MLX_EMBED_PORT OMLX_PORT SPLASH_PORT MLX_CACHE_LIMIT MLX_PROMPT_CACHE_BYTES MLX_PROMPT_CONCURRENCY MLX_DECODE_CONCURRENCY MLX_EMBED_CACHE_LIMIT JEV_MLX_CACHE_LIMIT OMLX_CACHE_MAX_GB OLLAMA_NUM_PARALLEL`
- Produces: `hostTestEnv(): { NODE_BIN: string; PHARMAITCHAT_HOST_CONFIG: string }` and `HOST_FIXTURE: string` in `__tests__/helpers/host-env.ts`, for tests that spawn scripts with their own env.

- [ ] **Step 1: Create the test helper `__tests__/helpers/host-env.ts`**

```ts
// For tests that spawn bash scripts with an env of their own (PATH=/usr/bin:/bin has no node):
// scripts/lib/host.sh needs a node binary and a host profile to read.
import { join } from "node:path";

export const HOST_FIXTURE = join(process.cwd(), "__tests__", "fixtures", "host.yaml");

export function hostTestEnv(): { NODE_BIN: string; PHARMAITCHAT_HOST_CONFIG: string } {
  return { NODE_BIN: process.execPath, PHARMAITCHAT_HOST_CONFIG: HOST_FIXTURE };
}
```

- [ ] **Step 2: Write the failing test `__tests__/host-env.test.ts`**

```ts
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_FIXTURE, hostTestEnv } from "./helpers/host-env.js";

const hostSh = join(process.cwd(), "scripts", "lib", "host.sh");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sourceHost(env: Record<string, string>, print: string[]) {
  const echo = print.map((name) => `echo "${name}=\${${name}-<unset>}"`).join("\n");
  return spawnSync("bash", ["-c", `set -euo pipefail\nsource "$1"\n${echo}`, "bash", hostSh], {
    encoding: "utf-8",
    env: { PATH: "/usr/bin:/bin", HOME: tmpdir(), ...env },
  });
}

describe("scripts/lib/host.sh", () => {
  it("exports ports and resource limits from the host profile", () => {
    const result = sourceHost(hostTestEnv(), ["APP_PORT", "MLX_CHAT_PORT", "JEV_HOST", "JEV_PORT", "MLX_CACHE_LIMIT", "OMLX_CACHE_MAX_GB", "PHARMAITCHAT_HOST_NAME"]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "APP_PORT=3000",
      "MLX_CHAT_PORT=8080",
      "JEV_HOST=127.0.0.1",
      "JEV_PORT=8010",
      "MLX_CACHE_LIMIT=2147483648",
      "OMLX_CACHE_MAX_GB=20",
      "PHARMAITCHAT_HOST_NAME=test-host",
    ]);
  });

  it("keeps a value already set in the environment", () => {
    const result = sourceHost({ ...hostTestEnv(), MLX_CACHE_LIMIT: "123" }, ["MLX_CACHE_LIMIT"]);
    expect(result.stdout.trim()).toBe("MLX_CACHE_LIMIT=123");
  });

  it("exits non-zero and lists the problems when the profile is invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "host-sh-"));
    dirs.push(dir);
    const bad = join(dir, "host.yaml");
    writeFileSync(bad, readFileSync(HOST_FIXTURE, "utf-8").replace("{ port: 8100 }", "{ port: 0 }"));
    const result = sourceHost({ ...hostTestEnv(), PHARMAITCHAT_HOST_CONFIG: bad }, ["APP_PORT"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("endpoints.chromadb.port");
    expect(result.stdout).not.toContain("APP_PORT=");
  });

  it("fails loudly without node", () => {
    const result = sourceHost({ PHARMAITCHAT_HOST_CONFIG: HOST_FIXTURE }, ["APP_PORT"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/node not found/);
  });

  it("works from any working directory", () => {
    const result = spawnSync("bash", ["-c", `cd /\nsource "$1"\necho "$CHROMADB_PORT"`, "bash", hostSh], {
      encoding: "utf-8",
      env: { PATH: "/usr/bin:/bin", HOME: tmpdir(), ...hostTestEnv() },
    });
    expect(result.stdout.trim()).toBe("8100");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -- __tests__/host-env.test.ts`
Expected: FAIL — `host.sh: No such file or directory`.

- [ ] **Step 4: Implement `scripts/lib/host-env.ts`**

```ts
// Prints the host profile (config/host.yaml) as shell exports for scripts/lib/host.sh to eval.
// Each line keeps a value already in the environment: export NAME="${NAME:-value}".
// Values are validated integers or addresses matching [A-Za-z0-9.:-], so the output is safe to eval.
import { HostConfigError, loadHostConfig } from "../../src/platform/host-config.js";
import type { HostConfig } from "../../src/platform/host-config.js";

function exportsFor(host: HostConfig): Array<[string, string | number]> {
  const e = host.endpoints;
  const r = host.resources;
  return [
    ["PHARMAITCHAT_HOST_NAME", host.name],
    ["PHARMAITCHAT_HOST_ADDRESS", host.address],
    ["APP_PORT", e.app.port],
    ["APP_HTTPS_PORT", e.app.httpsPort ?? ""],
    ["MCP_HOST", e.mcp.address],
    ["MCP_PORT", e.mcp.port],
    ["N8N_PORT", e.n8n.port],
    ["CHROMADB_PORT", e.chromadb.port],
    ["NEO4J_PORT", e.neo4j.port],
    ["SEARXNG_PORT", e.searxng.port],
    ["JEV_HOST", e.scorer.address],
    ["JEV_PORT", e.scorer.port],
    ["OLLAMA_PORT", e.ollama.port],
    ["MLX_CHAT_PORT", e.mlx_chat.port],
    ["MLX_EMBED_PORT", e.mlx_embed.port],
    ["OMLX_PORT", e.omlx.port],
    ["SPLASH_PORT", e.splash.port],
    ["MLX_CACHE_LIMIT", r.mlxChat.cacheLimitBytes],
    ["MLX_PROMPT_CACHE_BYTES", r.mlxChat.promptCacheBytes],
    ["MLX_PROMPT_CONCURRENCY", r.mlxChat.promptConcurrency],
    ["MLX_DECODE_CONCURRENCY", r.mlxChat.decodeConcurrency],
    ["MLX_EMBED_CACHE_LIMIT", r.mlxEmbed.cacheLimitBytes],
    ["JEV_MLX_CACHE_LIMIT", r.scorer.cacheLimitBytes],
    ["OMLX_CACHE_MAX_GB", r.omlx.ssdCacheMaxGb],
    ["OLLAMA_NUM_PARALLEL", r.ollama.numParallel],
  ];
}

try {
  const lines = exportsFor(loadHostConfig()).map(([name, value]) => `export ${name}="\${${name}:-${value}}"`);
  process.stdout.write(`${lines.join("\n")}\n`);
} catch (err) {
  process.stderr.write(`${err instanceof HostConfigError ? err.message : String(err)}\n`);
  process.exit(1);
}
```

- [ ] **Step 5: Implement `scripts/lib/host.sh`**

```bash
#!/usr/bin/env bash
# Exports the host profile (config/host.yaml) -- ports and machine-sized limits -- as env vars.
# Source this file; don't execute it. A variable already set in the environment keeps its value.
# Exits the calling script when the profile is invalid or node is missing: a script that went on
# with empty ports would start servers on the wrong port or probe nothing.
# node comes from NODE_BIN (tests, run-mcp.sh) or PATH (launchd puts node's dir first).

_host_repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
_host_node="${NODE_BIN:-$(command -v node 2>/dev/null || true)}"
if [ -z "$_host_node" ]; then
  echo "host.sh: node not found; set NODE_BIN or put node on PATH" >&2
  exit 1
fi
# From the repo root so `--import tsx` resolves the project's own tsx
if ! _host_exports="$(cd "$_host_repo" && "$_host_node" --import tsx scripts/lib/host-env.ts)"; then
  echo "host.sh: could not load the host profile (see above)" >&2
  exit 1
fi
eval "$_host_exports"
unset _host_repo _host_node _host_exports
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -- __tests__/host-env.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck && npm run typecheck:tests` (`scripts/lib/**` is already in `tsconfig.test.json`).

```bash
git add scripts/lib/host-env.ts scripts/lib/host.sh __tests__/helpers/host-env.ts __tests__/host-env.test.ts
git commit -m "feat: host.sh exports the host profile to bash scripts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Bash scripts read the host profile

**Files:**
- Modify: `scripts/lib/services.sh:1-6`
- Modify: `scripts/start-services.sh:46`
- Modify: `scripts/switch-stack.sh:32,42-46,56-76,81` (and the `--host 127.0.0.1`/`http://localhost:` call sites stay as they are)
- Modify: `scripts/run-jev.sh:19-30`
- Modify: `scripts/run-mcp.sh:14-16`
- Modify: `scripts/setup-searxng.sh:29`
- Modify: `scripts/hermes-setup.sh:23,148-150`
- Modify: `scripts/check-services.sh` (ports, `jev_port`, URLs)
- Modify: `python/mlx-embed-server.py:25-32`
- Modify: every test that spawns one of these scripts with its own `env:` (list in Step 6)
- Modify: `__tests__/check-services-jev.test.ts` (rewritten, Step 5)

**Interfaces:**
- Consumes: `scripts/lib/host.sh` and its exported names (Task 2); `hostTestEnv()` (Task 2).
- Produces: scripts with no port or resource literal; later tasks rely on `switch-stack.sh`, `start-services.sh` and `run-mcp.sh` exporting `MLX_EMBED_CACHE_LIMIT`, `MCP_PORT`, `PHARMALLM_URL` to their children.

- [ ] **Step 1: `scripts/lib/services.sh` sources the host profile**

Replace lines 4-6:

```bash
PROJECT_DIR="${PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
CHROMA_PORT="${CHROMADB_PORT:-8100}"
CHROMA_URL="http://localhost:${CHROMA_PORT}"
```

with:

```bash
PROJECT_DIR="${PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
# Ports and machine-sized limits from config/host.yaml (exits on an invalid profile)
# shellcheck source=host.sh
source "$(dirname "${BASH_SOURCE[0]}")/host.sh"
CHROMA_PORT="$CHROMADB_PORT"
CHROMA_URL="http://${PHARMAITCHAT_HOST_ADDRESS}:${CHROMA_PORT}"
```

- [ ] **Step 2: `scripts/switch-stack.sh` drops its literals**

Delete line 32 `MCP_PORT="3200"` and lines 42-46:

```bash
APP_PORT="3000"
APP_HTTPS_PORT="3443"
OLLAMA_PORT="11434"
MLX_CHAT_PORT="8080"
MLX_EMBED_PORT="8081"
```

Replace them with one comment where lines 42-46 were:

```bash
# APP_PORT, APP_HTTPS_PORT, MCP_PORT, OLLAMA_PORT, MLX_CHAT_PORT, MLX_EMBED_PORT, OMLX_PORT and
# SPLASH_PORT come from config/host.yaml through lib/services.sh -> lib/host.sh.
```

Replace the memory-limit block (the comment starting `# Memory limits for mlx_lm.server.` through `MLX_DECODE_CONCURRENCY="${MLX_DECODE_CONCURRENCY:-2}"`) with:

```bash
# mlx_lm.server limits (MLX_CACHE_LIMIT, MLX_PROMPT_CACHE_BYTES, MLX_PROMPT_CONCURRENCY,
# MLX_DECODE_CONCURRENCY), the embedder's MLX_EMBED_CACHE_LIMIT and OMLX_CACHE_MAX_GB come from
# config/host.yaml, which records why each has its value (the 2026-09-29 Metal OOM).
```

Delete `OMLX_PORT="8090"`, the two lines
`# Caps the oMLX paged SSD prefix cache (unbounded, it reached 4.3 GB in two short sessions)` /
`OMLX_CACHE_MAX_GB="${OMLX_CACHE_MAX_GB:-20}"`, and `SPLASH_PORT="${SPLASH_PORT:-8000}"`.

In `start_mlx_embed`, pass the cap explicitly (the Python default goes away in Step 7):

```bash
    MLX_EMBED_CACHE_LIMIT="$MLX_EMBED_CACHE_LIMIT" nohup "$MLX_VENV/bin/python" "$PROJECT_DIR/python/mlx-embed-server.py" \
```

In both `scripts/switch-stack.sh` and `scripts/start-services.sh`, replace
`http://localhost:${N8N_PORT:-5678}/webhook/knowledge-gap` with
`http://${PHARMAITCHAT_HOST_ADDRESS}:${N8N_PORT}/webhook/knowledge-gap` (`start-services.sh` gets both
names by sourcing `lib/services.sh`). `__tests__/start-services-env.test.ts` replaces `lib/services.sh`
with a stub: add `N8N_PORT=5678` and `PHARMAITCHAT_HOST_ADDRESS=localhost` lines to that stub's content.

Then run: `grep -nE '="[0-9]{4,5}"|:-[0-9]{4,}\}' scripts/switch-stack.sh scripts/start-services.sh`
Expected: no output.

- [ ] **Step 3: `run-jev.sh`, `run-mcp.sh`, `setup-searxng.sh`, `hermes-setup.sh`**

`scripts/run-jev.sh` — after `JEV_DIR=...` add:

```bash
# JEV_HOST, JEV_PORT and JEV_MLX_CACHE_LIMIT come from config/host.yaml (exits on an invalid profile)
# shellcheck source=lib/host.sh
source "$SCRIPT_DIR/lib/host.sh"
```

and delete `export JEV_HOST="${JEV_HOST:-127.0.0.1}"`, `export JEV_PORT="${JEV_PORT:-8010}"   # 8000 belongs to the Splash stack`, the 5-line comment beginning `# MLX keeps every freed GPU buffer for reuse` and `export JEV_MLX_CACHE_LIMIT="${JEV_MLX_CACHE_LIMIT:-1073741824}"`. Keep the `case "$JEV_MLX_CACHE_LIMIT"` byte-count check.

`scripts/run-mcp.sh` — replace

```bash
export MCP_HOST="${MCP_HOST:-127.0.0.1}"
export MCP_PORT="${MCP_PORT:-3200}"
export PHARMALLM_URL="${PHARMALLM_URL:-http://localhost:3000}"
```

with

```bash
# MCP_HOST, MCP_PORT and APP_PORT come from config/host.yaml (exits on an invalid profile)
# shellcheck source=lib/host.sh
source "$SCRIPT_DIR/lib/host.sh"
export PHARMALLM_URL="${PHARMALLM_URL:-http://${PHARMAITCHAT_HOST_ADDRESS}:${APP_PORT}}"
```

`scripts/setup-searxng.sh` — replace `SEARXNG_PORT="${SEARXNG_PORT:-8888}"` with

```bash
# SEARXNG_PORT comes from config/host.yaml
# shellcheck source=lib/host.sh
source "$SCRIPT_DIR/lib/host.sh"
```

`scripts/hermes-setup.sh` — after `source "$SCRIPT_DIR/lib/launchd.sh"` add

```bash
# shellcheck source=lib/host.sh
source "$SCRIPT_DIR/lib/host.sh"
```

replace `MCP_HEALTH_URL="${MCP_HEALTH_URL:-http://127.0.0.1:3200/healthz}"` with
`MCP_HEALTH_URL="${MCP_HEALTH_URL:-http://${MCP_HOST}:${MCP_PORT}/healthz}"`, and the three `fill_env` defaults with:

```bash
  fill_env PHARMALLM_URL "http://${PHARMAITCHAT_HOST_ADDRESS}:${APP_PORT}"
  fill_env PHARMALLM_MCP_URL "http://${MCP_HOST}:${MCP_PORT}/mcp"
  fill_env SEARXNG_URL "http://${PHARMAITCHAT_HOST_ADDRESS}:${SEARXNG_PORT}"
```

- [ ] **Step 4: `scripts/check-services.sh`**

After `rc=0` add:

```bash
# Ports from config/host.yaml, the same file every service reads (exits on an invalid profile)
# shellcheck source=lib/host.sh
source "$SCRIPT_DIR/lib/host.sh"
APP_URL="http://${PHARMAITCHAT_HOST_ADDRESS}:${APP_PORT}"
```

Delete the `jev_port()` function and its 2-line comment. Then replace:

| Before | After |
|---|---|
| `    mlx\|splash) echo "8081 MLX embed" ;;` | `    mlx\|splash) echo "$MLX_EMBED_PORT MLX embed" ;;` |
| `check_port 3000 "app" ...` | `check_port "$APP_PORT" "app" ...` |
| `check_port 8100 "ChromaDB" ...` | `check_port "$CHROMADB_PORT" "ChromaDB" ...` |
| `check_port "$(jev_port)" "jev scorer" ...` | `check_port "$JEV_PORT" "jev scorer" ...` |
| `check_port 7687 "Neo4j" ...` | `check_port "$NEO4J_PORT" "Neo4j" ...` |
| `check_port 8888 "SearXNG" ...` | `check_port "$SEARXNG_PORT" "SearXNG" ...` |
| `http://localhost:3000/api/health` | `$APP_URL/api/health` |
| `http://localhost:5678/webhook/knowledge-gap` | `http://${PHARMAITCHAT_HOST_ADDRESS}:${N8N_PORT}/webhook/knowledge-gap` |
| `http://localhost:3000/api/graph/stats` | `$APP_URL/api/graph/stats` |
| `http://localhost:3000/api/stack/status` | `$APP_URL/api/stack/status` |

Keep the rest of each line (labels and `-> ...` hints) unchanged; the `check-services-containers` tests match on them.

- [ ] **Step 5: Rewrite `__tests__/check-services-jev.test.ts`**

`jev_port` no longer exists; the drift it guarded against (probing Splash's 8000) is now prevented by one source of truth. Replace the file with:

```ts
import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The jev scorer moved from :8000 to :8010 and :8000 became Splash's, but check-services.sh kept
// probing 8000: with Splash up and the scorer down it reported the scorer up. Both the scorer
// (run-jev.sh) and this check now take JEV_PORT from config/host.yaml through lib/host.sh.
const script = readFileSync(join(process.cwd(), "scripts", "check-services.sh"), "utf-8");
const runJev = readFileSync(join(process.cwd(), "scripts", "run-jev.sh"), "utf-8");

describe("check-services.sh jev scorer port", () => {
  it("probes the port run-jev.sh listens on, both from the host profile", () => {
    expect(script).toMatch(/source "\$SCRIPT_DIR\/lib\/host\.sh"/);
    expect(runJev).toMatch(/source "\$SCRIPT_DIR\/lib\/host\.sh"/);
    expect(script).toMatch(/check_port "\$JEV_PORT" "jev scorer"/);
    expect(runJev).toMatch(/--port "\$JEV_PORT"/);
  });

  it("no longer parses decide.yaml for a port", () => {
    expect(script).not.toContain("decide.yaml");
  });
});
```

If the old file had further `describe` blocks after the two shown in this plan, keep them and adapt only their use of `jevPort`.

- [ ] **Step 6: Give script-spawning tests a node and the fixture**

Run the full suite to find the tests that now fail because their `env:` has no node:

Run: `npm test 2>&1 | grep -E "✕|host.sh" | head -50`

For every `spawnSync`/`spawn` whose `env:` is an explicit object (not `{ ...process.env, ... }`) and which runs `switch-stack.sh`, `run-mcp.sh`, `run-jev.sh`, `setup-searxng.sh`, `hermes-setup.sh`, `check-services.sh`, or sources `lib/services.sh`/`lib/host.sh`, add `...hostTestEnv(),` as the first entry of the env object and `import { hostTestEnv } from "./helpers/host-env.js";` at the top. Expected files: `switch-stack-config.test.ts`, `mcp-service.test.ts`, `containers.test.ts`, `searxng-setup.test.ts`, `hermes-setup.test.ts`, `mlx-watchdog.test.ts`, `n8n-gap-loop-wiring.test.ts`, `check-services-containers.test.ts`. Tests that copy scripts into a temp dir and stub `lib/services.sh` (e.g. `start-services-env.test.ts`) need nothing.

`check-services-containers.test.ts` extracts `model_server_checks` and runs it alone: add `MLX_EMBED_PORT: "8081"` to that spawn's env (or pass `env: { ...process.env, MLX_EMBED_PORT: "8081" }`) so the expected `8081 MLX embed` line still appears.

Do not change any expected value in these tests. A test whose assertion needs a different number is a behaviour change: stop and report it.

- [ ] **Step 7: `python/mlx-embed-server.py` loses its literal default**

Replace the body of `cache_limit_bytes()`:

```python
def cache_limit_bytes() -> int:
    """MLX keeps freed GPU buffers for reuse with no cap, and every embedding is a forward pass over a
    different number of tokens: uncapped, a test instance grew from 0.9 GB to 36 GB within 90 varied
    requests (2026-09-29). The cap comes from MLX_EMBED_CACHE_LIMIT (bytes), which switch-stack.sh
    exports from config/host.yaml (resources.mlx_embed)."""
    raw = os.environ.get("MLX_EMBED_CACHE_LIMIT", "").strip()
    if not raw.isdigit():
        raise SystemExit(
            f"MLX_EMBED_CACHE_LIMIT must be a byte count, got {raw!r}; start the server through scripts/switch-stack.sh"
        )
    return int(raw)
```

- [ ] **Step 8: Run the full suite, the Hermes plugin tests and typechecks**

Run: `npm test && npm run test:hermes-plugin && npm run typecheck && npm run typecheck:tests`
Expected: all PASS, no expected value changed.

Also run the read-only switch-stack command against the fixture:
`PHARMAITCHAT_HOST_CONFIG="$PWD/__tests__/fixtures/host.yaml" PHARMALLM_RUN_DIR="$(mktemp -d)" bash scripts/switch-stack.sh chat-endpoint omlx`
Expected: `http://localhost:8090 mlx-community--Qwen3.8-27B-4bit`.

- [ ] **Step 9: Commit**

```bash
git add scripts python/mlx-embed-server.py __tests__
git commit -m "refactor: bash scripts take ports and memory limits from the host profile" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: App endpoints (`llm-stacks`, ChromaDB, Neo4j, SearXNG, graph builder)

**Files:**
- Modify: `src/config/llm-stacks.ts:33-35,52-53,66-67,88-89`
- Modify: `src/services/chromadb-store.ts:10`
- Modify: `src/services/graph-store.ts:6`
- Modify: `src/api/dashboard.ts:22,123`
- Modify: `src/api/graph.ts` (the `execFile` call in `POST /rebuild`)
- Modify: `python/graph_builder.py:7,21,24`
- Test: `__tests__/llm-stacks.test.ts` (add one case)

**Interfaces:**
- Consumes: `serviceUrl(name, env?, host?)`, `loadHostConfig()`, `HostConfig` (Task 1).
- Produces: `buildStacks(env?: NodeJS.ProcessEnv, host?: HostConfig)` — new optional second parameter.

- [ ] **Step 1: Write the failing test** — append to `__tests__/llm-stacks.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHostConfig } from "../src/platform/host-config.js";

describe("buildStacks reads endpoints from the host profile", () => {
  const fixture = readFileSync(join(process.cwd(), "__tests__", "fixtures", "host.yaml"), "utf-8");

  it("uses the profile's ports when no env override is set", () => {
    const host = parseHostConfig(fixture.replace("mlx_chat:  { port: 8080 }", "mlx_chat:  { port: 9080 }"), "t.yaml");
    const stacks = buildStacks({}, host);
    expect(stacks.mlx.chatBaseUrl).toBe("http://localhost:9080");
    expect(stacks.splash.embedBaseUrl).toBe("http://localhost:8081");
  });

  it("still lets MLX_CHAT_URL win", () => {
    const host = parseHostConfig(fixture, "t.yaml");
    expect(buildStacks({ MLX_CHAT_URL: "http://elsewhere:1" }, host).mlx.chatBaseUrl).toBe("http://elsewhere:1");
  });
});
```

(Merge the imports with the file's existing ones; `buildStacks` is already imported there.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- __tests__/llm-stacks.test.ts`
Expected: FAIL — `mlx.chatBaseUrl` is `http://localhost:8080`.

- [ ] **Step 3: Implement**

`src/config/llm-stacks.ts`: add `import { serviceUrl } from "../platform/host-config.js";` and `import type { HostConfig } from "../platform/host-config.js";`, then:

```ts
export function buildStacks(env: NodeJS.ProcessEnv = process.env, host?: HostConfig): Record<StackName, StackConfig> {
  // Endpoints from config/host.yaml; OLLAMA_URL, MLX_CHAT_URL, MLX_EMBED_URL, OMLX_URL and SPLASH_URL still win
  const ollamaUrl = serviceUrl("ollama", env, host);
  const mlxChatUrl = serviceUrl("mlx_chat", env, host);
  const mlxEmbedUrl = serviceUrl("mlx_embed", env, host);
  const omlxUrl = serviceUrl("omlx", env, host);
  const splashUrl = serviceUrl("splash", env, host);
```

and use `mlxChatUrl`, `mlxEmbedUrl`, `omlxUrl` (both chat and embed), `splashUrl`, `mlxEmbedUrl` in place of the five `env.X ?? "http://localhost:NNNN"` expressions.

`src/services/chromadb-store.ts:10`:

```ts
const CHROMADB_URL = serviceUrl("chromadb");
```
with `import { serviceUrl } from "../platform/host-config.js";`.

`src/services/graph-store.ts:6`:

```ts
const NEO4J_URI = serviceUrl("neo4j");
```
with the same import.

`src/api/dashboard.ts`: replace `const SEARXNG_URL = "http://localhost:8888";` with `const SEARXNG_URL = serviceUrl("searxng");` and add the import.

`src/api/graph.ts`: add `import { serviceUrl } from "../platform/host-config.js";` and give the builder its endpoints:

```ts
    execFile(
      "python3",
      ["python/graph_builder.py"],
      {
        cwd: process.cwd(),
        timeout: 600000,
        // The builder has no defaults of its own: endpoints come from config/host.yaml
        env: { ...process.env, NEO4J_URI: serviceUrl("neo4j"), OLLAMA_URL: serviceUrl("ollama") },
      },
```

`python/graph_builder.py`: change the docstring line 7 to
`Requires: NEO4J_URI and OLLAMA_URL in the environment (POST /api/graph/rebuild passes them from config/host.yaml)`
and lines 21 and 24 to:

```python
NEO4J_URI = os.environ.get("NEO4J_URI") or sys.exit("graph_builder: NEO4J_URI is not set (run it through POST /api/graph/rebuild)")
OLLAMA_URL = os.environ.get("OLLAMA_URL") or sys.exit("graph_builder: OLLAMA_URL is not set (run it through POST /api/graph/rebuild)")
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- __tests__/llm-stacks.test.ts __tests__/health.test.ts __tests__/stack-switch.test.ts && npm test`
Expected: PASS, with no other test changed.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck && npm run typecheck:tests`

```bash
git add src/config/llm-stacks.ts src/services/chromadb-store.ts src/services/graph-store.ts src/api/dashboard.ts src/api/graph.ts python/graph_builder.py __tests__/llm-stacks.test.ts
git commit -m "refactor: app endpoints come from the host profile" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Scorer URL moves from `decide.yaml` to the host profile

**Files:**
- Modify: `src/services/decide-config.ts:57-96`
- Modify: `config/decide.yaml:8-12`
- Modify: `__tests__/decide-config.test.ts`

**Interfaces:**
- Consumes: `serviceUrl`, `HostConfig` (Task 1).
- Produces: `parseDecideConfig(raw: unknown, baseUrl: string): DecideConfig` (was `parseDecideConfig(raw)`); `loadDecideConfig(path?: string, host?: HostConfig): DecideConfig`. `DecideConfig` is unchanged, so `decide.ts`, `gap-detector.ts`, `gap-resolution-verdict.ts`, `page-relevance.ts` and `dashboard.ts` need no change.

- [ ] **Step 1: Update the tests first** — in `__tests__/decide-config.test.ts`:

Remove `base_url` from `good`:

```ts
const good = {
  model: "jev-latest",
  timeout_ms: 15000,
  thresholds: { resolved: 0.85, unresolved: 0.5 },
};
const SCORER = "http://127.0.0.1:8010";
```

Replace every `parseDecideConfig(x)` call with `parseDecideConfig(x, SCORER)`. Change the "reads a complete document" expectation to `expect(config.baseUrl).toBe(SCORER);`. Replace the test that dropped `base_url` (the lines with `const { base_url: _drop, ...noUrl } = good;`) with:

```ts
  // The scorer's address lives in config/host.yaml. A base_url left here would be a second source
  // that silently disagrees with the one check-services.sh and run-jev.sh use.
  it("refuses a base_url, pointing at the host profile", () => {
    expect(() => parseDecideConfig({ ...good, base_url: "http://127.0.0.1:8010" }, SCORER)).toThrow(/host\.yaml/);
  });
```

Add:

```ts
describe("loadDecideConfig", () => {
  it("takes the scorer URL from the host profile", () => {
    const config = loadDecideConfig(join(process.cwd(), "config", "decide.yaml"));
    expect(config.baseUrl).toBe("http://127.0.0.1:8010");
  });
});
```

with `import { join } from "node:path";` and `loadDecideConfig` added to the existing import. (This reads the committed `decide.yaml`, which holds no host data, and the fixture host profile.)

Run: `grep -rn "parseDecideConfig(" __tests__ src scripts` and add the `SCORER` second argument at every other call site found.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- __tests__/decide-config.test.ts`
Expected: FAIL — "reads a complete document" throws `"base_url" must be a non-empty string`.

- [ ] **Step 3: Implement** in `src/services/decide-config.ts`:

Add imports:

```ts
import { serviceUrl } from "../platform/host-config.js";
import type { HostConfig } from "../platform/host-config.js";
```

Change the signature and the check at the top of `parseDecideConfig`:

```ts
// baseUrl comes from config/host.yaml (endpoints.scorer), not from this file
export function parseDecideConfig(raw: unknown, baseUrl: string): DecideConfig {
  if (!isRecord(raw)) {
    throw new Error("decide config: expected a YAML mapping");
  }
  if (raw.base_url !== undefined) {
    throw new Error('decide config: "base_url" moved to config/host.yaml (endpoints.scorer); remove it here');
  }
```

In the returned object replace `baseUrl: requireString(raw, "base_url"),` with `baseUrl,`. Then:

```ts
export function loadDecideConfig(
  path: string = resolve(process.cwd(), "config", "decide.yaml"),
  host?: HostConfig,
): DecideConfig {
  return parseDecideConfig(parseYamlDocument(readFileSync(path, "utf8")), serviceUrl("scorer", process.env, host));
}
```

In `config/decide.yaml` replace lines 8-12 (the `# 8010, not 8000` comment and `base_url: http://127.0.0.1:8010`) with:

```yaml
# The scorer's address is endpoints.scorer in config/host.yaml (8010: Splash owns 8000).
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- __tests__/decide-config.test.ts __tests__/decide.test.ts __tests__/decide-timing.test.ts __tests__/decide-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck && npm run typecheck:tests`

```bash
git add src/services/decide-config.ts config/decide.yaml __tests__/decide-config.test.ts
git commit -m "refactor: the scorer URL comes from the host profile, not decide.yaml" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: MCP service config

**Files:**
- Modify: `mcp/src/config.ts:47-58`
- Test: `mcp/__tests__/config.test.ts` (add one case)

**Interfaces:**
- Consumes: `loadHostConfig`, `serviceUrl`, `HostConfig` (Task 1).
- Produces: `loadConfig(env?: NodeJS.ProcessEnv, host?: HostConfig): McpConfig` — new optional second parameter, `McpConfig` unchanged.

- [ ] **Step 1: Write the failing test** — append to `mcp/__tests__/config.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHostConfig } from "../../src/platform/host-config.js";

describe("loadConfig reads the host profile", () => {
  const fixture = readFileSync(join(process.cwd(), "..", "__tests__", "fixtures", "host.yaml"), "utf-8");

  it("takes the MCP port and the app URL from it", () => {
    const host = parseHostConfig(
      fixture.replace("mcp:       { port: 3200", "mcp:       { port: 3300").replace("app:       { port: 3000", "app:       { port: 3100"),
      "t.yaml",
    );
    const config = loadConfig({}, host);
    expect(config.port).toBe(3300);
    expect(config.host).toBe("127.0.0.1");
    expect(config.pharmaitchatUrl).toBe("http://localhost:3100");
  });
});
```

(The MCP Jest runs with cwd `mcp/`, hence the `..`.)

- [ ] **Step 2: Run to verify failure**

Run: `npm --prefix mcp test -- __tests__/config.test.ts`
Expected: FAIL — port is 3200.

- [ ] **Step 3: Implement** in `mcp/src/config.ts`:

```ts
import { loadHostConfig, serviceUrl } from "../../src/platform/host-config.js";
import type { HostConfig } from "../../src/platform/host-config.js";
```

```ts
// Port, bind address and the app's URL default to config/host.yaml; MCP_PORT, MCP_HOST and
// PHARMAITCHAT_URL (legacy PHARMALLM_URL) still win
export function loadConfig(env: NodeJS.ProcessEnv = process.env, host?: HostConfig): McpConfig {
  const profile = (): HostConfig => host ?? loadHostConfig();
  const port = Number(env.MCP_PORT ?? String(profile().endpoints.mcp.port));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid MCP_PORT "${env.MCP_PORT}"`);
  }

  const bindHost = env.MCP_HOST ?? profile().endpoints.mcp.address;
  const mcpToken = env.MCP_TOKEN?.trim() || null;
  if (!isLoopbackHost(bindHost) && !mcpToken) {
    throw new Error(`MCP_TOKEN is required when MCP_HOST (${bindHost}) is not a loopback address`);
  }

  return {
    port,
    host: bindHost,
    mcpToken,
    pharmaitchatUrl: serviceUrl("app", env, host),
    pharmaitchatToken: readEnvWithFallback(env, "API_TOKEN") ?? null,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm --prefix mcp test && npm --prefix mcp run typecheck`
Expected: PASS, including the existing `loadConfig({})` case (port 3200, `http://localhost:3000`) through the fixture.

- [ ] **Step 5: Commit**

```bash
git add mcp/src/config.ts mcp/__tests__/config.test.ts
git commit -m "refactor: MCP service defaults come from the host profile" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: TypeScript scripts

**Files (modify, one line or constant each):**
- `scripts/kb-canary.ts:38`
- `scripts/benchmark-stack.ts:54`
- `scripts/reindex-stack.ts:11`
- `scripts/replay-gap-decisions.ts:142`
- `scripts/replay-page-relevance.ts:60`
- `scripts/replay-detection.ts:46`
- `scripts/export-graph.ts:10`
- `scripts/rebuild-vendor-graph.ts:22`
- `scripts/seed-neo4j-attacks.ts:9`

**Interfaces:**
- Consumes: `serviceUrl` (Task 1). Import path from `scripts/`: `../src/platform/host-config.js`.

- [ ] **Step 1: Replace each literal**

| File | Before | After |
|---|---|---|
| `kb-canary.ts` | `option(args, "--app-url", "http://localhost:3000")` | `option(args, "--app-url", serviceUrl("app"))` |
| `benchmark-stack.ts` | `appUrl: value("--app") ?? "http://localhost:3000",` | `appUrl: value("--app") ?? serviceUrl("app"),` |
| `reindex-stack.ts` | `const APP_URL = process.env.APP_URL ?? "http://localhost:3000";` | `const APP_URL = process.env.APP_URL ?? serviceUrl("app");` |
| `replay-gap-decisions.ts` | `fetch("http://127.0.0.1:3000/api/decide", {` | ``fetch(`${serviceUrl("app")}/api/decide`, {`` |
| `replay-page-relevance.ts` | `fetch("http://127.0.0.1:3000/api/decide", {` | ``fetch(`${serviceUrl("app")}/api/decide`, {`` |
| `replay-detection.ts` | `const APP_URL = "http://127.0.0.1:3000";` | `const APP_URL = serviceUrl("app");` |
| `export-graph.ts` | `const URI = process.env.NEO4J_URI ?? "bolt://localhost:7687";` | `const URI = serviceUrl("neo4j");` |
| `rebuild-vendor-graph.ts` | `const URI = process.env.NEO4J_URI ?? "bolt://localhost:7687";` | `const URI = serviceUrl("neo4j");` |
| `seed-neo4j-attacks.ts` | `const NEO4J_URI = process.env.NEO4J_URI ?? "bolt://localhost:7687";` | `const NEO4J_URI = serviceUrl("neo4j");` |

Add `import { serviceUrl } from "../src/platform/host-config.js";` to each file. Leave the usage comments at the top of `kb-canary.ts` and `benchmark-stack.ts` as they are (documentation, allow-listed in Task 9). `127.0.0.1` → `localhost` for the app is safe: `api/auth.ts` treats both as local.

- [ ] **Step 2: Verify**

Run: `npm run typecheck:tests && npx tsx scripts/kb-canary.ts --help 2>&1 | head -5`
Expected: typecheck passes; the canary prints its usage (or its first normal line) without a `HostConfigError` — this reads the real `config/host.yaml`, which is fine for a manual check. If `--help` is not supported and the script starts a run, stop it with Ctrl-C: it only calls the local app.

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add scripts/*.ts
git commit -m "refactor: scripts default to host-profile endpoints" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `/api/health` reports the live host profile

**Files:**
- Modify: `src/api/dashboard.ts` (the `GET /health` handler's `res.json`)

**Interfaces:**
- Consumes: `hostSummary`, `loadHostConfig` (Task 1; `hostSummary` is already unit-tested there).

- [ ] **Step 1: Implement**

Extend the import from Task 4 to `import { hostSummary, loadHostConfig, serviceUrl } from "../platform/host-config.js";` and change the last line of the handler to:

```ts
  // Informational, not checks: a benchmark doesn't make the app unhealthy, and `host` says which
  // machine profile (config/host.yaml) this process started with -- the check after a move
  res.json({
    status: aggregateHealth(checks),
    stack: stack.name,
    benchmark_active: isBenchmarkActive(),
    host: hostSummary(loadHostConfig()),
    checks,
  });
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm test -- __tests__/health.test.ts`
Expected: PASS. (`check-services.sh` parses only `status` and `checks`, so the new field is additive.)

- [ ] **Step 3: Commit**

```bash
git add src/api/dashboard.ts
git commit -m "feat: /api/health names the host profile and its limits" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Literal guard and full verification

**Files:**
- Create: `__tests__/no-host-literals.test.ts`

**Interfaces:**
- Consumes: the finished migration (Tasks 3-8).

- [ ] **Step 1: Write the guard**

```ts
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
```

- [ ] **Step 2: Run it**

Run: `npm test -- __tests__/no-host-literals.test.ts`
Expected: PASS. If it lists hits, each is either a literal a previous task missed (fix it the same way as its neighbours) or a legitimate non-host use (add a precise `ALLOWED_FILES` entry with a comment saying why). Never widen `LITERAL` exclusions to make it pass.

- [ ] **Step 3: Full verification**

Run each; all must pass:

```bash
npm run typecheck
npm run typecheck:tests
npm test
npm --prefix mcp test
npm --prefix mcp run typecheck
npm run test:hermes-plugin
```

- [ ] **Step 4: Commit**

```bash
git add __tests__/no-host-literals.test.ts
git commit -m "test: guard against host:port literals outside the host profile" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Open the PR (do not merge)**

```bash
git push -u origin feature/host-config
env -u GITHUB_TOKEN gh pr create --base main --title "feat: host config seam (config/host.yaml)" --body "$(cat <<'EOF'
Everything tied to the machine -- service endpoints and the memory/concurrency limits sized for the
48 GB mac-mini -- now lives in `config/host.yaml`, read by `src/platform/host-config.ts` (TypeScript)
and `scripts/lib/host.sh` (bash). Existing env overrides keep precedence. No behaviour change on the
mac-mini: `host-config-live-file.test.ts` pins every value to what was hardcoded before.

First piece of the Sils_Healthcare `platform/` layer; `src/platform/` has an enforced import boundary.

Spec: docs/superpowers/specs/2026-09-30-host-config-seam-design.md
Plan: docs/superpowers/plans/2026-09-30-host-config-seam.md

After merge: `bash scripts/check-services.sh` all green; `/api/health` shows `host.name: mac-mini`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Post-merge checks (run by the controller in the main checkout, after Seb merges): `bash scripts/check-services.sh` → "all good"; `curl -s localhost:3000/api/health | python3 -c 'import sys,json; print(json.load(sys.stdin)["host"])'` → `name: mac-mini` with today's resource values; `bash scripts/switch-stack.sh status` runs without a host.sh error.
