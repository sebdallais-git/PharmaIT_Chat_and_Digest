# Host config seam: one file per machine

**Date:** 2026-09-30
**Status:** approved design, not yet implemented
**Goal:** everything tied to the machine PharmaITChat runs on — service endpoints and the
memory/concurrency limits sized for it — lives in one file, `config/host.yaml`. Moving to
another machine means editing that file. Behaviour on the current mac-mini does not change.

## Why

PharmaITChat is the proving ground for Sils_Healthcare, which moves to a Mac Studio (M5 Ultra,
256 GB, hostname `olympus`) around mid-November 2026. The target's convention: *never hardcode
the hostname, home paths or machine-specific ports; host details live in one config file.*
Services built between now and then are shaped for that target, and this seam is the first
piece of its `platform/` layer.

Today about 45 host/port literals are spread over TypeScript (`llm-stacks.ts`,
`chromadb-store.ts`, `graph-store.ts`, `api/dashboard.ts`, `mcp/src/config.ts`, ~10 scripts),
bash (`switch-stack.sh`, `services.sh`, `check-services.sh`, `hermes-setup.sh`, `run-jev.sh`, `run-mcp.sh`, `setup-searxng.sh`),
Python (`graph_builder.py`, `python/utils`) and `config/decide.yaml`. Most accept an env
override, but the default is repeated in each file.

The larger payoff is the resource half. Ports will likely stay the same on the Studio; the MLX
cache caps, prompt cache and concurrency were tuned on 2026-09-29 for 48 GB and will be wrong
at 256 GB.

## Scope

In: service endpoints (host + port) and machine-sized resource limits.

Out:
- Paths (`HF_HOME`, `data/run`, model caches) — a later step if needed.
- Ollama `num_ctx` — it lives in the Modelfile, which Ollama reads itself.
- The Tailscale URL — the app does not need it.
- n8n workflow JSON (needs the export/import/publish deploy dance), READMEs, doc comments,
  usage lines and test fixtures. These are the known remaining literals and are allow-listed
  in the literal-scan test.

## The file: `config/host.yaml`

```yaml
# Host profile: everything tied to the machine this runs on.
# Moving to another machine = editing this file.
host:
  name: mac-mini          # label only (health, logs); nothing branches on it
  address: localhost      # every endpoint's host unless it sets its own

endpoints:
  app:          { port: 3000, https_port: 3443 }
  mcp:          { port: 3200 }
  n8n:          { port: 5678 }
  chromadb:     { port: 8100 }
  neo4j:        { port: 7687, scheme: bolt }
  searxng:      { port: 8888 }
  scorer:       { port: 8010 }
  ollama:       { port: 11434 }
  mlx_chat:     { port: 8080 }
  mlx_embed:    { port: 8081 }
  omlx:         { port: 8090 }
  splash:       { port: 8000 }

resources:                # sized for 48 GB; the reasons move here from the scripts
  mlx_chat:  { cache_limit_bytes: 2147483648, prompt_cache_bytes: 4294967296,
               prompt_concurrency: 1, decode_concurrency: 2 }
  mlx_embed: { cache_limit_bytes: 536870912 }
  scorer:    { cache_limit_bytes: 1073741824 }
  omlx:      { ssd_cache_max_gb: 20 }
  ollama:    { num_parallel: 1 }
```

`localhost`, not `127.0.0.1`: most call sites use `localhost` today, and a service listening
only on `::1` would break under an IPv4 literal. Changing the address is a deliberate act on
the new machine, not a side effect of this change.

The comments that explain each limit (the 2026-09-29 OOM, the 36 GB embedder growth, the 4.3 GB
oMLX SSD cache) move from `switch-stack.sh`, `run-jev.sh` and `mlx-embed-server.py` into this
file, beside the values.

Validation at load, all errors reported together: every endpoint present; ports are integers in
1–65535; no two ports equal (including `https_port`); byte counts, concurrency and GB values are
positive integers; `scheme`, when present, is a non-empty string (default `http`). An invalid
file stops startup with a clear message — no silent fallback, same rule as the stacks.

## Loader: `src/platform/host-config.ts`

- `parseHostConfig(text: string): HostConfig` — pure; throws `HostConfigError` listing every
  problem.
- `loadHostConfig(env = process.env): HostConfig` — reads `config/host.yaml`, located from the
  module via `import.meta.url` (not `process.cwd()`), cached per resolved path.
  `PHARMAITCHAT_HOST_CONFIG` (fallback `PHARMALLM_HOST_CONFIG`, via `readEnvWithFallback`)
  points elsewhere; tests always use it.
- `endpointUrl(cfg, name): string` — `scheme://address:port`, e.g. `http://localhost:8100`,
  `bolt://localhost:7687`.

**Precedence, per value:** existing env var (names unchanged: `CHROMADB_URL`, `NEO4J_URI`,
`OLLAMA_URL`, `MLX_CHAT_URL`, `MLX_EMBED_URL`, `OMLX_URL`, `SPLASH_URL`, `MCP_PORT`,
`PHARMAITCHAT_URL`, `MLX_CACHE_LIMIT`, …) → `host.yaml` → nothing. No hardcoded default remains
in code.

**Boundary:** files under `src/platform/` import only `node:*`, `yaml`, `src/config/env-names`
and each other, so the folder moves to the Sils_Healthcare repo as-is. Enforced by a test.

## Bash bridge

`scripts/lib/host-env.ts` loads the config and prints one line per value, using the env-var
names the scripts already use:

```bash
export CHROMADB_PORT="${CHROMADB_PORT:-8100}"
export MLX_CACHE_LIMIT="${MLX_CACHE_LIMIT:-2147483648}"
export APP_PORT="${APP_PORT:-3000}"
```

`scripts/lib/host.sh` runs it with `node --import tsx` (~70 ms measured) and `eval`s the
output, so a value already in the environment wins. On error (invalid file, no `node`/`tsx`) it
prints the message and exits non-zero. `services.sh` sources `host.sh`, which covers
`start-services.sh` and `switch-stack.sh`; `check-services.sh`, `run-jev.sh`,
`mlx-watchdog.sh`, `hermes-setup.sh`, `run-mcp.sh` and `setup-searxng.sh` source it directly. launchd jobs find `node` through
the PATH `launchd.sh` renders (node's directory first).

Hardcoded assignments (`APP_PORT="3000"`, `MCP_PORT="3200"`, `MLX_CHAT_PORT="8080"`, …) and
`${X:-default}` resource fallbacks become plain references to the exported values.

`python/mlx-embed-server.py` keeps reading `MLX_EMBED_CACHE_LIMIT` but loses its literal
default: `switch-stack.sh` always exports it. `hermes/plugins/pharmaitchat-switch/tap.py` keeps
reading `PHARMALLM_URL`, which `hermes-setup.sh` fills from the host config.

## Consumers

| Consumer | Change |
|---|---|
| `src/config/llm-stacks.ts` | Stack URLs from `endpointUrl()`; env overrides kept |
| `src/services/chromadb-store.ts`, `graph-store.ts`, `src/api/dashboard.ts` | ChromaDB, Neo4j, SearXNG from host config; `CHROMADB_URL`, `NEO4J_URI` kept |
| `src/services/decide-config.ts`, `config/decide.yaml` | `base_url` removed from the YAML and taken from `endpoints.scorer`; a `base_url` still present is a load error (no second source) |
| `mcp/src/config.ts` | MCP port and app URL from host config; `MCP_PORT`, `PHARMAITCHAT_URL` kept |
| `src/api/graph.ts` → `python/graph_builder.py`, `python/utils/{search,vectordb}.py` | The app passes `NEO4J_URI`, `OLLAMA_URL`, `SEARXNG_URL` in the spawn env; the Python side reads them with no literal default and exits with a clear message if one is missing |
| `scripts/*.ts` (kb-canary, benchmark-stack, reindex-stack, replay-*, export-graph, rebuild-vendor-graph, seed-neo4j-attacks, migrate-news-to-raw-documents) | Defaults from `loadHostConfig()`; CLI flags kept |
| `scripts/*.sh` listed above | Through `host.sh` |
| `src/services/health.ts` / `/api/health` | New `host` field: `name`, config path, applied resource values — the check that the right profile is live |

## Testing

No test reads the live `config/host.yaml` except the one that pins it, and none touches a live
service.

| Test | Proves |
|---|---|
| `host-config.test.ts` | Valid fixture parses; each invalid case (bad port, duplicate port, non-integer bytes, missing endpoint) fails with all errors listed; env beats file; `PHARMAITCHAT_HOST_CONFIG` redirects; `PHARMALLM_` fallback works |
| `host-config-live-file.test.ts` | The committed `host.yaml` parses and equals today's hardcoded values — the "no behaviour change on the mini" guarantee |
| `host-env.test.ts` | `host.sh` against a fixture emits the expected exports; a preset env var survives; an invalid file exits non-zero |
| `platform-boundary.test.ts` | `src/platform/**` imports only the allowed modules |
| `no-host-literals.test.ts` | No `localhost:NNNN` / `127.0.0.1:NNNN` in `src/`, `mcp/src/`, `scripts/`, `python/` (venvs, `omlx-src`, comments excluded) outside the allow-list |

Existing script-level tests (17 files, e.g. `switch-stack-config.test.ts`) get a shared fixture
through `PHARMAITCHAT_HOST_CONFIG`; `llm-stacks`, `decide-config` and MCP config tests get an
injected config. Their expected values do not change.

Before the PR: `npm run typecheck`, `npm run typecheck:tests`, `npm test`,
`npm --prefix mcp test`, `npm --prefix mcp run typecheck`, `npm run test:hermes-plugin`.

## Rollout

Work happens on `feature/host-config` in `.worktrees/host-config`: the live app runs under
`tsx watch` from the main checkout and would reload on every save there. After merge:
`bash scripts/check-services.sh` all green, `/api/health` reports `host.name: mac-mini` with
today's resource values, and a stack switch round-trip (`switch-stack.sh status`) still works.

## On the Studio

Copy the repo, edit `host.name`, and retune `resources` for 256 GB (and the ~220 GB
`iogpu.wired_limit_mb` from the charter, which is a system setting, not this file). The
`src/platform/` folder moves to the Sils_Healthcare `platform/` layer unchanged.
