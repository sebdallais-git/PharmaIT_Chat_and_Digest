# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

PharmaITChat (renamed from PharmaLLM): local-first pharma IT intelligence. A nightly watchlist
collects news on 71 entities, dedupes it, tags it with a local 27B model and stores it; a web
chat, an HTTP API, an MCP server and a Telegram agent (Hermes) answer questions over it.
**Every model call is local** — no cloud LLM, no API keys for inference.

## Commands

```bash
npm run dev                  # ChromaDB + the active stack + tsx watch (scripts/start-services.sh)
npm run dev:node             # Node server only (tsx watch src/server.ts)
npm run build && npm start   # tsc -> dist/, node dist/server.js
npm run typecheck            # tsc --noEmit — run after any code change
npm run typecheck:tests      # type-check __tests__ via tsconfig.test.json
npm test                     # Jest (ESM flags already in the script)
npm test -- __tests__/stack-switch.test.ts   # single file
npm test -- -t "name of test"                # single test by name
npm --prefix mcp test        # MCP server has its own package + Jest config
npm --prefix mcp run typecheck
npm run test:hermes-plugin   # python unittest, hermes/tests
npm run watchlist -- verify-feeds | ingest [--limit N] [--only id,id] | status
bash scripts/check-services.sh                 # health of every service, incl. the scorer port from config/decide.yaml
npx tsx scripts/replay-gap-decisions.ts [--backfill | --question "…" | --details]
                                               # replay scorer verdicts against data/run/gap-baseline.json (27B baseline)
npx tsx scripts/shadow-report.ts               # detection shadow: scorer vs 27B agreement on chat turns
npx tsx scripts/replay-detection.ts [--backfill [--limit N] [--all] | --question … | --details]
                                               # same for detection: regenerates past answers (27B-labelled, resumable)
npx tsx scripts/replay-page-relevance.ts        # gap workflow page pre-check vs the 27B's keep/discard in n8n history
npx tsx scripts/remove-source.ts <source>      # dry run; --apply deletes it from raw docs, in-memory index and ChromaDB
```

There is **no lint script and no ESLint config** — do not run `npm run lint`.

Stack operations go through `scripts/switch-stack.sh` (`ollama|mlx|omlx|splash|status|prepare|
ensure-stack <s>|availability|ollama-ctx|telegram|mcp start|stop`). `availability` (read-only) says which
stacks can start and why not; the UI disables the others and `/api/stack/switch` refuses them. The active stack is recorded in
`data/run/active-stack`. Everything comes back after a reboot: the launchd job
`com.pharmaitchat.stack` runs `start-services.sh` (app, active stack, ChromaDB, colima
containers). `switch-stack.sh <stack>` itself starts the app in the background (log in
`data/logs/app.log`), so `npm run dev` right after it fails on port 3000.

App: http://localhost:3000 (chat), `/dashboard`, `/api/health`. HTTPS on 3443 when `certs/` has
`key.pem`/`cert.pem`.

## Architecture

ESM TypeScript (`"type": "module"`, `module: Node16`), strict. Source imports siblings as
`./x.js`; Jest maps that back to `.ts`. Entry point `src/server.ts`.

- **Four interchangeable LLM stacks** — Ollama (:11434), MLX (:8080 chat, :8081 embed), oMLX
  (:8090), Splash (:8000 chat only, borrows MLX's :8081 embeddings). Exactly one is active, with
  **no silent fallback**. `src/services/llm-client.ts` speaks the OpenAI-compatible API to all of
  them; `src/config/llm-stacks.ts` only swaps URLs, model names and the "thinking off" knob
  (`reasoning_effort: "none"` for Ollama/Splash vs `chat_template_kwargs.enable_thinking: false`
  for MLX/oMLX).
- **Per-stack indexes.** ChromaDB collection `knowledge_base_ollama` or `knowledge_base_mlx`, plus
  an in-memory index `knowledge/.index.<ollama|mlx>.json`. oMLX and Splash *share* the MLX ones,
  so `index-guard.ts` records stack/model/dimension/completeness and refuses search on a
  mismatch; oMLX must pass an embedding-parity probe (cosine ≥ 0.9999 against
  `__tests__/fixtures/embedding-reference.json`) before serving. Indexes are always rebuilt
  from `knowledge/` + `data/raw_documents/`, never from live sources.
- **Stack switch** (`stack-switch.ts`, `api/stack.ts`): the UI request sends a Telegram
  confirm/cancel message; the tap comes back via the Hermes `pharmaitchat-switch` plugin
  calling localhost. Switches roll back on failure and are refused during a benchmark,
  reindex or another switch.
- **Retrieval** (`api/chat.ts`): ChromaDB, the in-memory vector+keyword index, Neo4j Graph RAG
  and live news in parallel. `gap-detector.ts` asks the 27B (`gap-need.ts`) whether the question is
  in scope and went unanswered; only then does it trigger an
  n8n self-healing workflow. Graph rebuild (`python/graph_builder.py`) only works on Ollama (409
  otherwise).
- **Gap loop**: n8n `n8n/knowledge_gap_workflow_v2.json` → SearXNG (colima container, Brave API)
  → extract/check → store (`ingest-text.ts`) or `POST /api/knowledge/gaps/:id/unresolved`.
  The 27B decides resolution (`gap-resolution-verdict.ts`); the System One scorer
  (open-jev in `~/claude/open-jev`, Gemma 3 4B 4-bit on :8010, `config/decide.yaml`) is only
  logged/shadowed (`[Gap Resolution] 27B X, scorer Y`, `[Decide]` for slow/failed calls).
  It does decide one thing: `/api/llm/complete` with a `relevance` page skips the 27B extraction
  when the page scores below `page_relevance_skip_below` (`page-relevance.ts`, fail-open).
- **Watchlist** (`watchlist-*` services, `scripts/watchlist.ts`, `config/watchlist.yaml` is the
  only definition of entities/feeds/topics). Pipeline: adapters (RSS/Atom, Google News, EDGAR)
  → dedupe **before** the model → sequential tagging → SQLite `data/watchlist.db` + ChromaDB.
  Entity ids and the 10 IT domains are a closed vocabulary; invented values are dropped. Per-feed
  errors don't advance the watermark; 250-item cap and 45-min budget, overflow is deferred.
- **Surfaces**: `/api/*` routes, `/v1` OpenAI-compatible gateway onto the active stack
  (`model-gateway.ts`), `mcp/` (separate package, `pharmaitchat-mcp` on :3200, 16 tools),
  `hermes/` (Telegram agent config, cron jobs, plugin), `public/` + `dashboard/` (plain
  HTML/JS/CSS — no React, no bundler).
- **Auth** (`api/auth.ts`): static files and UI routes open; everything else needs
  `Authorization: Bearer $PHARMAITCHAT_API_TOKEN`, or, with no token set, a same-machine request
  with a localhost Host header.
- Storage: ChromaDB (:8100), Neo4j (`neo4j-driver`), `better-sqlite3`. No Prisma/PostgreSQL.

## Conventions

- ES modules only; no `any` (use `unknown` + type guards); prefer interfaces; kebab-case
  filenames, camelCase functions; comments in English.
- Env vars read `PHARMAITCHAT_<NAME>` first, then the legacy `PHARMALLM_<NAME>`
  (`src/config/env-names.ts`). Keep the fallback when adding such a variable.
- There is no `.env`. Tokens live in `data/run/` (mode 600) and reach processes via the
  environment or stdin (`curl -H @-`), never as command-line arguments.

## Gotchas

- **Tests must never touch live services** (model servers, ChromaDB, Neo4j, Docker, launchd,
  Telegram). A test once wiped the live ChromaDB. Inject dependencies and fakes; never prove
  RED against live data.
- `.worktrees/` holds checkouts of other branches and is excluded from Jest; tests that read
  scripts do so relative to `process.cwd()`.
- Renaming an MCP server orphans long-lived agent sessions: they keep calling the old
  `mcp__<old>__*` names, which fail instantly while health checks stay green. Run
  `scripts/check-stale-sessions.sh` (read-only; `--quiet` for the verdict only) before and after
  a rename: it lists stale routed sessions, dead-name calls and cron jobs that name the old
  server. Rotate each flagged session from inside its own chat (`/new`), then re-run.
- The app runs under `tsx watch` in the `com.pharmaitchat.stack` launchd job: saving a file in `src/`
  reloads the live app. A stack switch hands the app back to that job (`start_app` →
  `launchctl kickstart -k`) rather than starting its own copy.
- A test that reaches `switch-stack.sh` functions must stub `launchctl` and set its own
  `PHARMALLM_RUN_DIR`: `start_app` only hands off to launchd when `RUN_DIR` is the project's own
  `data/run`. A test without that restarted the live stack job twice on 2026-09-29.
- Neo4j and SearXNG run in **colima**, not Docker Desktop (`scripts/lib/services.sh` starts it).
- Editing the n8n workflow JSON does nothing until deployed: export a backup → `launchctl bootout`
  → `n8n import:workflow` → `n8n publish:workflow` → `launchctl bootstrap`.
- launchd jobs: `com.pharmaitchat.{stack,mcp,n8n,mlx-watchdog,jev}`; their PATH comes from
  `scripts/lib/launchd.sh` — re-render the plists after changing it.
- Measure any scorer prompt/model change with the replay harness before shipping: question
  wording moved agreement 35% → 72%, and 16-bit → 4-bit moved it to 91%; thresholds alone never helped.
- Keep `OLLAMA_NUM_PARALLEL=1` — each slot allocates its own 64K context.
- Same for MLX: `switch-stack.sh` starts `mlx_lm.server` with 1 prefill / 2 decodes at a time, a
  4 GiB prompt cache and a 2 GiB MLX buffer-cache cap (`run-jev.sh` caps the scorer at 1 GiB). The
  defaults (8/32, uncapped) ran the GPU out of memory under a burst: the generation thread dies,
  the server keeps listening, and every request hangs until the watchdog restarts it.
  With one prefill at a time, a probe queues behind long requests: `/api/health` and the watchdog
  treat a timeout with the GPU ≥ 30% (`ioreg` "Device Utilization %") as busy, not wedged.
- Node's `fetch` caps at 300 s, which matters for long local-inference calls.
- Logs for failed switches/rebuilds: `data/logs/` (`app.log`, `mlx-*.log`, `omlx.log`,
  `splash.log`, `reindex-<stack>.log`, `watchlist-ingest-<date>.log`).

## Git

Remote `github.com/sebdallais-git/PharmaIT_Chat_and_Digest`, main branch `main`, features on
`feature/<name>`. Commit prefixes: `feat:` `fix:` `refactor:` `test:` `docs:`.
