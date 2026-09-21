# PharmaITChat and Digest

Local-first pharma IT intelligence: collects vendor/competitor news, indexes it, and answers
questions over it through a web chat, an HTTP API and a Telegram agent. Inference and storage
run on the Mac; only data collection and delivery touch the internet.

## Commands

```bash
npm run dev              # full stack via ./scripts/start-services.sh
npm run dev:node         # Node server only (tsx watch src/server.ts)
npm run build            # tsc
npm start                # node dist/server.js
npm run typecheck        # tsc --noEmit  — run after any code change
npm run typecheck:tests  # tsc -p tsconfig.test.json
npm test                 # Jest (ESM: needs --experimental-vm-modules, already in the script)
npm run test:hermes-plugin  # python3 -m unittest, hermes/tests
npm run watchlist        # tsx scripts/watchlist.ts
scripts/check-stale-sessions.sh  # read-only; run before/after renaming an MCP server
```

There is **no lint script and no ESLint config** — do not run `npm run lint`.

## Architecture

ESM TypeScript (`"type": "module"`), strict mode. Entry point `src/server.ts`.

- `src/api/` — Express routes: `agent, auth, bench, chat, dashboard, feedback, graph,
  knowledge, llm, stack, v1`
- `src/services/` — stores and integrations: `chromadb-store`, `graph-store`, `knowledge-store`,
  `watchlist-*` (config/sources/ingest/tagger/store/edgar), `model-gateway`, `stack-switch`,
  `llm-client`, `reindex*`, `index-guard`
- `src/config/`, `src/utils/`
- `__tests__/` — Jest + ts-jest
- `mcp/` — separate package (own `package.json` and jest config) exposing the MCP tools
- `hermes/` — Hermes agent config, SOUL.md, cron jobs, Telegram plugin, python tests
- `python/` — MLX embedding server, `graph_builder.py`
- `public/`, `dashboard/` — plain HTML/JS/CSS front ends. **No React, no bundler.**
- `knowledge/` markdown corpus · `data/` chromadb, sqlite dbs, logs · `bench/questions.json`
  · `config/watchlist.yaml` · `n8n/` workflow JSON · `ollama/` Modelfile

**Storage:** ChromaDB (vectors), Neo4j via `neo4j-driver` (graph), `better-sqlite3` (local dbs).
No Prisma, no PostgreSQL.

## Code style

- TypeScript strict; ES modules (`import`/`export`), never CommonJS
- Prefer interfaces over type aliases
- No `any` — use `unknown` with type guards
- camelCase functions, kebab-case filenames
- Comments in English

## Gotchas

- **Tests must never touch live services.** A test once wiped the live ChromaDB. Inject
  dependencies, assert on collection ids, never prove RED by reverting against live data.
- **Never edit `.env`.**
- **Renaming an MCP server orphans long-lived agent sessions** — they keep calling the old
  `mcp__<old>__*` names, which fail at the deferral layer in 0.00s while every health check
  stays green. Rotate each chat session from inside its own chat; cron self-heals.
  `scripts/check-stale-sessions.sh` detects it.
- Stacks share the MLX index: a shared index needs a stable IDENTITY or switching deletes the
  collection.
- Node's `fetch` caps at 300 s — relevant for long local-inference calls.

## Commits

`feat:` · `fix:` · `refactor:` · `test:` · `docs:` — main branch `main`, features on
`feature/<name>`. Remote: `github.com/sebdallais-git/PharmaIT_Chat_and_Digest`.
