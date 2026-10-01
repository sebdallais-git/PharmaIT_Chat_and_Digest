<div align="center">

# PharmaITChat

### The IT landscape around pharma — tracked, tagged and answered with a local LLM, VectorDB and neo4j based GraphRAG

PharmaITChat watches the IT and security scene around three pharma customers, their competitors and the vendors that shape their tech stack — **76 named entities**, collected nightly, deduplicated across sources, tagged by a 27B model and stored in a knowledge base you can then ask questions of, in a browser or on Telegram.

**Every model call happens on this machine.** Chat, embeddings, nightly tagging, retrieval, storage. No cloud LLM, no API key for the model, no per-token bill — and no question, answer or document handed to a cloud model. What goes out is the news the system fetches, the web searches it runs (see [Everything local](#everything-local-on-one-machine)) and the Telegram message it sends back.

**Last night, unattended:** 1,165 items fetched, 57 collapsed by cross-source dedupe, 250 tagged and stored, 2 failed feeds, 0 anomalies, 42 minutes — and not a word on Telegram, because nothing went wrong.

[![Node.js](https://img.shields.io/badge/Node.js-22-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Express](https://img.shields.io/badge/Express-4.21-000000?style=for-the-badge&logo=express&logoColor=white)](https://expressjs.com)
<br/>
[![Ollama](https://img.shields.io/badge/Ollama-Qwen3.8_27B-000000?style=for-the-badge&logo=ollama&logoColor=white)](https://ollama.com)
[![MLX](https://img.shields.io/badge/MLX-Qwen3.8_27B-6E56CF?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/ml-explore/mlx-lm)
[![oMLX](https://img.shields.io/badge/oMLX-chat_%2B_embeddings-F59E0B?style=for-the-badge)](https://github.com/jundot/omlx)
[![Splash](https://img.shields.io/badge/Splash-chat_only-EC4899?style=for-the-badge)](#four-interchangeable-stacks)
[![Apple Silicon](https://img.shields.io/badge/Apple_Silicon-M4_Pro_tested-555555?style=for-the-badge&logo=apple&logoColor=white)](#benchmarks)
<br/>
[![Watchlist](https://img.shields.io/badge/watchlist-71_entities-0f766e?style=for-the-badge)](#the-watchlist)
[![ChromaDB](https://img.shields.io/badge/ChromaDB-vector_store-FF6446?style=for-the-badge)](https://www.trychroma.com)
[![Neo4j](https://img.shields.io/badge/Neo4j-Graph_RAG-4581C3?style=for-the-badge&logo=neo4j&logoColor=white)](https://neo4j.com)
<br/>
[![Hermes Agent](https://img.shields.io/badge/Hermes_Agent-0.21.3-8B5CF6?style=for-the-badge)](#hermes-agent-on-telegram)
[![Telegram](https://img.shields.io/badge/Telegram-5_scheduled_jobs-26A5E4?style=for-the-badge&logo=telegram&logoColor=white)](#hermes-agent-on-telegram)
[![MCP](https://img.shields.io/badge/MCP-16_tools-D97757?style=for-the-badge)](#the-mcp-server-and-the-model-gateway)
<br/>
[![open-jev](https://img.shields.io/badge/open--jev-Gemma_3_4B_%C2%B7_4--bit-1e3a8a?style=for-the-badge)](https://github.com/daseinlabs/open-jev)
[![System One](https://img.shields.io/badge/System_One-scorer_beside_the_27B-1e3a8a?style=for-the-badge)](#the-system-one-scorer)
[![n8n](https://img.shields.io/badge/n8n-3_workflows-EA4B71?style=for-the-badge&logo=n8n&logoColor=white)](#workflows)
<br/>
[![SearXNG](https://img.shields.io/badge/SearXNG-metasearch-3050FF?style=for-the-badge&logo=searxng&logoColor=white)](#the-self-healing-loop)
[![Brave Search API](https://img.shields.io/badge/Brave_Search-API-FB542B?style=for-the-badge&logo=brave&logoColor=white)](#the-self-healing-loop)
[![colima](https://img.shields.io/badge/colima-Neo4j_%C2%B7_SearXNG-2496ED?style=for-the-badge&logo=docker&logoColor=white)](#setup)
[![SQLite](https://img.shields.io/badge/SQLite-gaps_%C2%B7_watchlist-003B57?style=for-the-badge&logo=sqlite&logoColor=white)](#the-watchlist)

[![Tests](https://img.shields.io/badge/Jest-1%2C162_tests_%C2%B7_101_suites-C21325?style=flat-square&logo=jest&logoColor=white)](#testing)
[![Python tests](https://img.shields.io/badge/unittest-27_tests-3776AB?style=flat-square&logo=python&logoColor=white)](#testing)
[![Stack switch](https://img.shields.io/badge/stack_switch-Ollama_%C2%B7_MLX_%C2%B7_oMLX_%C2%B7_Splash-6E56CF?style=flat-square)](#four-interchangeable-stacks)
[![UI switch](https://img.shields.io/badge/UI_switch-Telegram_confirmed-26A5E4?style=flat-square)](#switching-from-the-web-ui)
[![Context](https://img.shields.io/badge/context-64K_all_stacks-064e3b?style=flat-square)](#four-interchangeable-stacks)
[![Cloud calls](https://img.shields.io/badge/cloud_LLM_calls-0-064e3b?style=flat-square)](#everything-local-on-one-machine)
[![Nightly run](https://img.shields.io/badge/last_nightly_run-1%2C165_items_%C2%B7_42_min_%C2%B7_0_anomalies-0f766e?style=flat-square)](#the-first-unattended-run)
[![Resolution agreement](https://img.shields.io/badge/scorer_vs_27B-resolution_91%25-1e3a8a?style=flat-square)](#the-system-one-scorer)
[![Page pre-check](https://img.shields.io/badge/page_pre--check-35%25_of_wasted_27B_reads_skipped-1e3a8a?style=flat-square)](#the-system-one-scorer)
[![Autostart](https://img.shields.io/badge/after_reboot-everything_returns-064e3b?style=flat-square)](#hermes-agent-on-telegram)

[Workflows](#workflows) · [Stacks](#four-interchangeable-stacks) · [Benchmarks](#benchmarks) · [Watchlist](#the-watchlist) · [Chat & knowledge base](#chat-retrieval-and-the-knowledge-base) · [System One](#the-system-one-scorer) · [Telegram](#hermes-agent-on-telegram) · [Setup](#setup) · [API](#api-reference)

</div>

---

## Everything local, on one machine

The whole system runs on one local box with 48 GB of unified memory — no cloud tenancy, no inference bill, no rate limit. A 27B Qwen model answers the chat, embeds the documents, tags every item the watchlist collects and drives the Telegram assistant. No question, answer or stored document is handed to a cloud model. The one exception to "nothing leaves" is web search: see below.

| What | Where it runs |
|---|---|
| Chat and reasoning | Local 27B model, on Ollama, MLX, oMLX or Splash |
| Embeddings | Local Qwen3-Embedding 0.6B, on the same stack |
| Nightly entity/domain tagging | The same local chat model, one item at a time |
| Vector store, item store, graph | ChromaDB, SQLite and Neo4j on localhost |
| Answer scoring (System One) | Local Gemma 3 4B (4-bit) on open-jev, beside the 27B |
| Web search | Chat: Google News RSS search. Self-healing loop and Hermes: your own SearXNG on localhost, which forwards the **search queries** to the Brave Search API |

Outbound traffic is limited to what the system goes out to *get* and the one channel it answers on: RSS and Atom feeds, Google News RSS, SEC EDGAR, URLs you explicitly add to the knowledge base, web search, and Telegram. The search queries themselves leave the machine: chat's optional web search sends the question to Google News RSS, and the self-healing loop's queries (written by the local model from a knowledge gap) go through SearXNG, which runs locally but only as a proxy, to Brave's Search API under your own key (SearXNG's page-scraping engines are switched off). Web search can be switched off in the chat UI; the self-healing loop always searches. There is no `.env` file: tokens live in `data/run/` at mode 600 and reach the process through the environment.

---

## Highlights

| | Feature | What it does |
|---|---|---|
| 🏠 | **Local 27B LLM** | Qwen3.8 27B (4-bit) for chat and tagging, Qwen3-Embedding 0.6B (8-bit), 64K context, zero cloud calls |
| 🔀 | **Four interchangeable stacks** | Ollama ⇄ MLX ⇄ oMLX ⇄ Splash by one script or from the web UI, Telegram-confirmed, with per-stack indexes and automatic rollback |
| 👁️ | **Entity watchlist** | 76 watched entities — 3 customers, 28 peers, 45 IT vendors — across 59 RSS feeds, 49 EDGAR CIKs and 188 entity-less topic queries |
| 🌙 | **Unattended nightly run** | 02:30: fetch, dedupe *before* the model, tag by entity and IT domain, store in SQLite and ChromaDB, alert only on failure |
| 🔎 | **Hybrid retrieval** | ChromaDB, an in-memory vector + keyword index, Neo4j Graph RAG and live news, queried in parallel |
| 🛡️ | **Embedding-parity guard** | A stack that shares another's index must prove its embeddings match (cosine ≥ 0.9999) or the switch is refused |
| 🤖 | **Telegram assistant** | Hermes Agent on the same local model: 16 MCP tools, 5 scheduled jobs, a network-less Docker sandbox |
| 🧰 | **MCP server** | `pharmaitchat-mcp` exposes the knowledge base to any MCP client over Streamable HTTP, with compacted payloads |
| 🔌 | **Model gateway** | OpenAI-compatible `/v1` on whichever stack is active, so any agent can borrow the local model |
| 🩹 | **Self-healing knowledge** | Low-confidence answers trigger an n8n workflow that researches, ingests and re-checks the gap — every workflow is diagrammed under [Workflows](#workflows) |
| ⚖️ | **System One scorer** | A local 4B model beside the 27B: skips clearly irrelevant pages before the 27B reads them, and shadows every chat answer and gap resolution, with replay harnesses to measure each use before it is trusted |
| 🎙️ | **Voice input** | Local speech-to-text with whisper.cpp; HTTPS mode for iPad and phone microphones |
| ⏱️ | **Built-in benchmark** | Reproducible Ollama vs MLX vs oMLX vs Splash comparison with retrieval overlap and a blind A/B review page |
| ✅ | **1,189 tests** | 1,162 Jest tests in 101 suites across the app and the MCP server, plus 27 Python tests for the Telegram plugin — every one of them against fakes, none touching a real model server, ChromaDB, Docker, launchd or Telegram |

---

## Workflows

Everything that runs on its own, what starts it, and whether it is live on this machine today.

| Workflow | Started by | Runs in | Status |
|---|---|---|---|
| [Chat turn and gap detection](#chat-turn-and-gap-detection) | Every chat message | App | Live |
| [Gap auto-fill v2](#gap-auto-fill-v2) · `n8n/knowledge_gap_workflow_v2.json` | Webhook from the gap detector | n8n (18 nodes) | **Live**, active |
| [KB canaries](#kb-canaries) · `config/kb-canaries.yaml` | 05:00 daily | Hermes, script mode | Live |
| [Digest agent](#digests) · `scripts/digest.ts` | Asked in chat or Telegram · Mondays 07:30 (weekly) · Tue–Fri 07:30 (briefing) | App · Hermes, script mode | Live |
| [Gap auto-fill v1](#gap-auto-fill-v1) · `n8n/knowledge_gap_workflow.json` | Webhook | n8n (13 nodes) | Kept for reference, not imported |
| [Nightly watchlist ingest](#the-nightly-run) | 02:30 daily | Hermes, script mode | Live |
| [Hermes scheduled jobs](#hermes-scheduled-jobs) | Cron, 3 agent jobs + 4 script jobs | Hermes | Live |
| [Stack switch](#stack-switch) | Web UI request | App + Telegram + Hermes plugin | Live |

### Chat turn and gap detection

The answer streams first; everything after the `done` event runs in the background and never delays the user.

```mermaid
flowchart LR
    Q["Chat question"] --> R["Parallel retrieval<br/>ChromaDB · in-memory · Neo4j · news"]
    R --> A["27B answer<br/>streamed to the user"]
    A --> BG["After done<br/>background"]
    BG --> D["Gap detector, one 27B call<br/>in scope? answered?<br/>asked-for thing named?"]
    BG -. "shadow_detection" .-> S["System One<br/>same question, recorded only"]
    S --> DS[("detection_shadow")]
    D --> RL[("request_log<br/>every turn")]
    D -- "in scope and not answered,<br/>or a named thing it asked for is missing<br/>2 h cooldown per topic" --> GL[("gap_log")]
    GL --> WH["n8n webhook<br/>gap_id, topic, question"]

    style A fill:#064e3b,stroke:#22d3ee,color:#e5e7eb
    style S fill:#1e3a8a,stroke:#60a5fa,color:#e5e7eb
    style WH fill:#4a1d6b,stroke:#d946ef,color:#e5e7eb
```

### Gap auto-fill v2

The live self-healing workflow. Every model step calls the app, so it runs on the active stack; the two failure paths fall back instead of stopping.

```mermaid
flowchart TD
    W["Knowledge Gap Webhook"] --> V{"Validate Gap<br/>numeric gap_id and a topic?"}
    V -- "no" --> VX["End: nothing researched"]
    V -- "yes" --> G["Generate Search Queries<br/>POST /api/llm/complete"]
    G -- "ok" --> P["Parse Search Queries<br/>3 queries"]
    G -- "error" --> GE["Query Error Handler<br/>search the topic itself"]
    P --> S["Search SearXNG<br/>Brave Search API"]
    GE --> S
    S -- "error" --> SE["SearXNG Error Handler<br/>log and stop"]
    S -- "ok" --> DD["Deduplicate Results<br/>top 3 per query"]
    DD --> F["Fetch Page Content"]
    F --> T["Truncate and Clean<br/>strip HTML, 8,000 chars"]
    T --> X["Extract Knowledge<br/>POST /api/llm/complete<br/>page sent as relevance"]
    X --> PC{"System One pre-check<br/>in the app"}
    PC -- "p below 0.1" --> NR["NOT_RELEVANT<br/>no 27B call"]
    PC -- "otherwise or scorer down" --> EX["27B extracts the facts"]
    NR --> FR["Filter Relevant Only"]
    EX --> FR
    FR --> AR{"Anything relevant?"}
    AR -- "yes" --> ST["Store in Knowledge Base<br/>POST /api/knowledge/ingest-text"]
    AR -- "no" --> MU["Mark Gap Unresolved<br/>POST /gaps/:id/unresolved"]
    ST --> SL["Summary and Log<br/>stored sources"]
    SL --> CR["Check Gap Resolution<br/>re-answer: 27B decides,<br/>scorer verdict logged"]
    CR --> RR["Resolution Result Log<br/>resolved · unresolved · review"]

    style PC fill:#1e3a8a,stroke:#60a5fa,color:#e5e7eb
    style EX fill:#064e3b,stroke:#22d3ee,color:#e5e7eb
    style CR fill:#064e3b,stroke:#22d3ee,color:#e5e7eb
    style MU fill:#7c2d12,stroke:#fb923c,color:#e5e7eb
    style SE fill:#7c2d12,stroke:#fb923c,color:#e5e7eb
```

Deploying a change to the JSON: back up the live workflow, `launchctl bootout` the n8n job, `n8n import:workflow`, `n8n publish:workflow`, `launchctl bootstrap`. Editing the file alone changes nothing.

### KB canaries

A daily check that the knowledge base still answers what it is known to hold. `config/kb-canaries.yaml` lists 8 questions with the facts each answer must contain, e.g. Merck 2017 → "NotPetya" and "1.4 billion", and Roche Kaiseraugst MES → "Rockwell", a fact the gap loop stored. A canary passes when the chat retrieved at least one chunk and the answer contains one term from every expected group. A failing canary is asked once more before it counts. The check is plain string matching: a model grading answers would follow its prompt's wording, as the scorer measurements showed.

```mermaid
flowchart LR
    H["Hermes cron, 05:00<br/>pharmaitchat-kb-canary.sh"] --> S["scripts/kb-canary.ts"]
    S --> C["POST /api/chat, benchmark: true<br/>no gap detection, no request log"]
    C --> K{"chunks ≥ 1 and<br/>expected facts present?"}
    K -- "fail" --> R["Ask once more"]
    R --> DB[("gap_log.db<br/>kb_canary_runs")]
    K -- "pass" --> DB
    DB --> T{"All passed?"}
    T -- "yes" --> Q["Silent"]
    T -- "no" --> TG["Telegram: KB canary 7/8 passed<br/>- roche-kaiseraugst-mes: missing Rockwell"]
    DB --> API["GET /api/dashboard/kb-health<br/>ok · failing · stale · never-run"]

    style K fill:#7c2d12,stroke:#fb923c,color:#e5e7eb
```

Run it by hand with `npx tsx scripts/kb-canary.ts` (add `--no-store` to leave no row). Each run's per-canary lines are kept in `data/logs/kb-canary-<date>.log`. It replaced the n8n KB health monitor (2026-09-29). That workflow was never activated, and would not have worked: it sent no API token, read the streamed chat reply as JSON, ran its test chats through gap detection, and kept reports only in memory.

### Gap auto-fill v1

The first version, kept in the repo for reference and never imported here. It stores what it finds but never re-checks the gap and has no "nothing relevant" branch, which is what v2 added.

```mermaid
flowchart LR
    W["Webhook"] --> G["Generate queries"] --> P["Parse"] --> S["SearXNG"] --> D["Dedupe"] --> F["Fetch"] --> T["Truncate"] --> X["Extract"] --> FR["Filter"] --> ST["Store"] --> L["Summary and Log"]
    G -. "error" .-> GE["Query Error Handler"] -.-> S
    S -. "error" .-> SE["SearXNG Error Handler"]
```

### Hermes scheduled jobs

Hermes' cron runs these on the local 27B and reports on Telegram. Scheduled runs use a write-limited MCP server (no `start_reindex`, no `add_knowledge`) and get no web, memory, terminal or file tools.

```mermaid
flowchart LR
    H["Hermes gateway<br/>cron"] --> WL["02:30 · watchlist ingest<br/>script mode, no agent"]
    H --> KC["05:00 · KB canaries<br/>script mode, no agent"]
    H --> WD["Mon 07:30 · weekly digest<br/>script mode, no agent"]
    H --> DB["Tue–Fri 07:30 · daily briefing<br/>script mode, no agent"]
    H --> GR["07:00 · gap resolution"]
    H --> HW["09:00 and 19:00 · health watch"]
    H --> FD["Mon 08:00 · feedback digest"]
    WL --> WI["watchlist ingest script"]
    GR --> T2["re-check at most 3 triggered gaps"]
    HW --> T3["system_health"]
    FD --> T4["feedback_report"]
    WI -- "only on failure" --> TG["Telegram"]
    KC -- "only on failure" --> TG
    WD -- "always: the digest is the message" --> TG
    DB -- "only when there is something to act on" --> TG
    T2 --> TG
    T3 -- "only when unhealthy" --> TG
    T4 --> TG

    style H fill:#4a1d6b,stroke:#d946ef,color:#e5e7eb
    style TG fill:#0c4a6e,stroke:#26A5E4,color:#e5e7eb
```

The nightly ingest itself is diagrammed under [The nightly run](#the-nightly-run).

### Stack switch

A switch requested in the browser only happens after a tap on Telegram.

```mermaid
sequenceDiagram
    participant UI as Web UI
    participant App as PharmaITChat
    participant TG as Telegram
    participant H as Hermes plugin
    UI->>App: POST /api/stack/switch (target stack)
    App->>App: refuse during a benchmark, reindex or another switch
    App->>TG: confirm and cancel buttons (one-time token)
    TG->>H: tap
    H->>App: POST /api/stack/confirm or /cancel (API token)
    App->>App: switch-stack.sh starts the target stack, rebuilds its index if stale
    alt switch fails
        App->>App: roll back to the previous stack
    end
    UI->>App: GET /api/stack/status until done
```

---

## Four interchangeable stacks

Every local model call — chat and embeddings alike — runs on **exactly one** stack. Ollama, MLX and oMLX run the same chat model at matching 4-bit quantization; Splash serves its own build of the same Qwen3.8 27B model. There is no silent fallback: if the active stack is down, requests fail with a clear error.

**Splash serves no embeddings of its own.** It exposes `/v1/chat/completions` but there is no `/v1/embeddings` endpoint at all — the single most surprising fact about this stack, and the reason for everything else about it below: it borrows the MLX embedding server on `:8081` and shares the MLX stack's ChromaDB collection and on-disk index, the same arrangement oMLX uses.

| | 🦙 Ollama stack | 🍎 MLX stack | 🧬 oMLX stack | 💦 Splash stack |
|---|---|---|---|---|
| **Chat model** | `qwen3.8-pharma` (Qwen3.8 27B Q4_K_M, 64K context) | `mlx-community/Qwen3.8-27B-4bit` via `mlx_lm.server` | `mlx-community--Qwen3.8-27B-4bit` (oMLX's discovery ids use double dashes) | `incoai/Qwen3.8-27B-Splash`, 65536-token context |
| **Embedding model** | `qwen3-embedding:0.6b-q8_0` | `mlx-community/Qwen3-Embedding-0.6B-8bit` via `python/mlx-embed-server.py` | `mlx-community--Qwen3-Embedding-0.6B-8bit` | **none** — borrows the MLX embedding server |
| **Ports** | `:11434` | `:8080` chat, `:8081` embeddings | `:8090` — one server for chat and embeddings | `:8000` chat; `:8081` embeddings (the MLX server) |
| **ChromaDB collection** | `knowledge_base_ollama` | `knowledge_base_mlx` | `knowledge_base_mlx` (shared with the MLX stack) | `knowledge_base_mlx` (shared with the MLX stack) |
| **In-memory index** | `knowledge/.index.ollama.json` | `knowledge/.index.mlx.json` | `knowledge/.index.mlx.json` (shared with the MLX stack) | `knowledge/.index.mlx.json` (shared with the MLX stack) |
| **Prompt cache** | one shared cache, evicted by the next caller | several caches, capped by `--prompt-cache-bytes` (8 GB) | one paged SSD cache, capped by `--paged-ssd-cache-max-size` (20 GB default); survives an app restart | managed by the Splash server itself |
| **Thinking** | off by default; off/low/medium/high per chat, via `reasoning_effort` | off by default; on/off per chat, via `chat_template_kwargs.enable_thinking` | off by default; on/off per chat, via `chat_template_kwargs.enable_thinking` | off by default (also server-side with `--default-reasoning-effort none`); off/low/medium/high per chat, via `reasoning_effort` |
| **Graph rebuild** | ✅ supported | ❌ switch to Ollama first (`409`) | ❌ switch to Ollama first (`409`) — `python/graph_builder.py` calls Ollama directly | ❌ switch to Ollama first (`409`) — same reason |

Splash has the steepest hardware bar of the four: **Apple M3 or newer, macOS 26.4 or later, 36 GB unified memory minimum (48 GB recommended)**. Its model, `incoai/Qwen3.8-27B-Splash`, is a 17.4 GB download under Apache-2.0 and **not gated** — unlike some Hugging Face models, no access token is needed to pull it. The engine itself comes from Homebrew (`brew install incoai/tap/splash`), whose Metal kernels are **precompiled**; a source checkout would compile them on first start and need full Xcode. `switch-stack.sh` prefers the Homebrew binary.

```bash
scripts/switch-stack.sh mlx          # stop the other stacks, start MLX, restart the app (rolls back on failure)
scripts/switch-stack.sh omlx         # third stack, port 8090 — one server for chat and embeddings,
                                     # shares the MLX index, restores long prompts from SSD after a restart
scripts/switch-stack.sh splash       # fourth stack, port 8000 — chat only, borrows the MLX embedding
                                     # server on :8081 and shares its index, like omlx does
scripts/switch-stack.sh ollama       # and back
scripts/switch-stack.sh status       # active stack, ports, OLLAMA_NUM_PARALLEL and index counts
scripts/switch-stack.sh ensure-stack ollama   # start a stack and its indexes without starting the app
scripts/switch-stack.sh prepare      # one-time model downloads; also installs the oMLX venv and Splash (Homebrew)
scripts/switch-stack.sh telegram     # store the Telegram credentials used to confirm UI-driven switches
scripts/switch-stack.sh ollama-ctx   # recreate qwen3.8-pharma if its context differs from the Modelfile
```

### Switching from the web UI

The chat header has a stack selector next to the model selector. Choosing a different stack does not switch immediately: PharmaITChat sends a Telegram message with **Switch** and **Cancel** buttons, valid for 5 minutes. Tapping Switch starts it, tapping Cancel or ignoring the message reverts the selector. The tap goes through the Hermes gateway (the `pharmaitchat-switch` plugin), which calls the app on localhost — so the phone never has to reach the server at all. The UI then follows the switch (stopping, starting, warming up, checking indexes) and shows the new stack with how long it took: `OMLX stack ready (96 s)`. Telegram gets a completion message with the same line.

The switch route itself needs no token, because approval comes from tapping the Telegram button. Store the credentials once:

```bash
scripts/switch-stack.sh telegram         # prompts for the bot token and your chat id, stores them at mode 600
```

Without them the selector is disabled and says so. The Hermes gateway must also be running on this machine with the `pharmaitchat-switch` plugin installed (`scripts/hermes-setup.sh install-plugin`), or the selector is disabled and says why. A split, two-machine Hermes setup can't confirm switches this way — use `scripts/switch-stack.sh` there instead. A switch is refused while another switch is pending confirmation or already in progress, while a benchmark or a reindex is running, or when the requested stack is already active.

### The embedding-parity guard

The oMLX stack shares the MLX index and ChromaDB collection because their embeddings are identical (cosine 1.000000). Every oMLX start re-checks that against `__tests__/fixtures/embedding-reference.json` and **refuses to serve below a cosine of 0.9999**. Without the check, an oMLX upgrade that quietly changed the embedding would write vectors into `knowledge_base_mlx` that no longer match the ones already there, and searches would return the wrong documents with no error at all. The probe turns a silent corruption into a refused switch.

Every index also records its stack, embedding model and dimension (1024), plus a completeness marker written only when a rebuild ran to the end. Search on a mismatched, incomplete or rebuilding index is refused rather than answered with meaningless matches.

### Memory limits

MLX keeps every freed GPU buffer for reuse and sets no cap of its own, and the defaults of `mlx_lm.server` work on 8 prompts and 32 replies at once. On one 48 GB Mac, under varied real inputs, each of the three MLX processes grew to about 36 GB by itself; together they pushed the 27B into swap until it froze or ran out of GPU memory. Each is now capped, measured on the same real inputs before and after:

| Process | Cap | Uncapped | Capped |
|---|---|---|---|
| 27B chat (`:8080`) | 2 GiB buffer cache, 1 prompt / 2 replies at a time, 4 GiB prompt cache | 6 concurrent 7.5k-token requests: all failed, GPU out of memory at 36 GB | all 6 answered, 27 GB peak, same total time |
| jev scorer (`:8010`) | 1 GiB | 36 GB within 30 page checks | 4.2 GB, same latency |
| Embedder (`:8081`) | 512 MiB | 36 GB within 90 embeddings | 1.5 GB, slightly faster |

Because the 27B now takes one prompt at a time, a health probe can queue behind a long request: `/api/health` and the watchdog read GPU load when their probe times out, and a server keeping the GPU busy is reported `busy` (healthy), not wedged.

### 64K context

`ollama/qwen3.8-pharma.Modelfile` sets `num_ctx 65536` and MLX is started with `--prompt-cache-bytes`. The model is a hybrid architecture: only 16 of its 64 layers keep a KV cache, so 64K costs about 4 GB instead of the 1 GB a 16K context used. Ollama's OpenAI API cannot set the context per request, so one shared size keeps a single copy of the model loaded. Keep `OLLAMA_NUM_PARALLEL` at 1 — each parallel slot allocates its own 64K context.

```mermaid
flowchart LR
    A["switch-stack.sh &lt;stack&gt;"] --> B{"Models<br/>downloaded?"}
    B -- no --> X["Exit: run prepare"]
    B -- yes --> C["Stop app and<br/>other stacks"]
    C --> D["Start target stack"]
    D -- "oMLX or Splash<br/>(share MLX index)" --> P["Check embedding<br/>parity (cosine ≥ 0.9999)"]
    D --> W["Warm up"]
    P --> W
    W --> E{"Indexes match stack<br/>and complete?"}
    E -- no --> F["Rebuild indexes"]
    E -- yes --> G["Start app, wait for<br/>/api/health"]
    F --> G
    G --> H["Record active stack"]
    D -. failure .-> R["Roll back to<br/>previous stack"]
    P -. failure .-> R
    F -. failure .-> R
    G -. failure .-> R

    style H fill:#064e3b,stroke:#22d3ee,color:#e5e7eb
    style R fill:#7f1d1d,stroke:#f43f5e,color:#e5e7eb
    style X fill:#7f1d1d,stroke:#f43f5e,color:#e5e7eb
```

**One client, four stacks.** `src/services/llm-client.ts` talks to all four through the OpenAI-compatible `/v1/chat/completions` API (and `/v1/embeddings` on the three that serve it); `src/config/llm-stacks.ts` only swaps base URLs and model names. Thinking is off by default on all four; the chat's thinking switch offers whatever levels the active stack supports (`src/services/thinking.ts`). Indexes are rebuilt from `knowledge/` and `data/raw_documents/`, where uploads, ingested text and collected articles are saved first — so a rebuild never depends on a source still being online. Everything follows the active stack: n8n calls `POST /api/llm/complete`, agents call `/v1/chat/completions`, the nightly ingest tags with whatever `data/run/active-stack` says.

---

## Benchmarks

### RAG answers (the web chat workload)

Ollama, MLX and oMLX measured on the same day, **2026-09-19** (Splash on 2026-09-29, see below), on the **same workstation-class machine** — one local box, 48 GB unified memory. Full pipeline through `POST /api/chat`: 23 questions from `bench/questions.json`, one cold run each after a warm-up question outside the set, temperature 0, no web search, `max_tokens` 1024, background LLM jobs paused. The stacks were switched between runs on that one machine (macOS 26.4); only the stack changed, and nothing else ran while a run was in flight.

| Metric (median) | 🦙 Ollama | 🍎 MLX | ⚡ oMLX | 💦 Splash |
|---|---:|---:|---:|---:|
| Time to first token | 19.1 s | 18.4 s | 17.5 s | **12.1 s** |
| Decode speed | 12.4 tok/s | 13.2 tok/s | 15.2 tok/s | **40.1 tok/s** |
| Total time per answer | 99.6 s | 92.3 s | 82.5 s | **36.0 s** |
| Query embedding | 31 ms | **19 ms** | 21 ms | 30 ms |
| Retrieval | 76 ms | **44 ms** | 68 ms | **44 ms** |
| Peak system memory used | 42,845 MB | **37,409 MB** | 41,009 MB | 43,712 MB |
| Model process memory | 28,459 MB | 16,184 MB | 17,119 MB | 6,552 MB* |
| Answers hitting the 1024-token cap | 15 / 23 | 11 / 23 | 10 / 23 | 11 / 23 |
| Failed runs | 0 / 23 | 0 / 23 | 0 / 23 | 0 / 23 |
| Version | Ollama 0.34.0 | mlx 0.32.2, mlx-lm 0.31.3 | oMLX 0.7.0.dev3 | Splash 1.1.0 (Homebrew) |

**Among the three measured on 2026-09-19, oMLX generates fastest** — 23% quicker decode than Ollama and 15% quicker than MLX, which compounds into a 17% shorter answer than Ollama end to end. **MLX stays leanest**: lowest peak memory and the fastest retrieval, because its embedding server is a separate process rather than sharing one with chat as oMLX does. Ollama's memory figure is honest now that the sampler follows its `llama-server` children — it genuinely holds the most.

The oMLX and MLX rows come from the *same* ChromaDB collection and the same on-disk index: the two stacks share them, so these numbers compare generation, not two different corpora.

**Splash answers 2.5× faster than the next stack**: 36 s per answer against oMLX's 82.5 s and MLX's 92.3 s, from a decode speed of 40 tok/s — it pairs the 27B with a trained draft model that proposes tokens ahead (speculative decoding). It was measured on **2026-09-29**, ten days after the others, on the same machine; MLX was re-run the same day and matched its 2026-09-19 numbers within 1% (13.1 tok/s, 92.3 s), so the columns compare. The cost is memory: the highest peak system use of the four (43.7 GB). \*Splash maps its weights from disk and keeps GPU memory outside the process, so its process figure undercounts; compare the system row. Splash serves chat only and borrows MLX's embedding server, hence the same retrieval.

### Long prompts (the agent workload)

Measured 2026-09-17 on the same machine, through `/v1` with a 16.7K-token prompt, streamed, sent cold and then again with the same prefix.

| Metric | 🦙 Ollama | 🍎 MLX | ⚡ oMLX | 💦 Splash |
|---|---:|---:|---:|---:|
| Cold time to first token | 156.3 s | 141.2 s | 149.6 s | **130.7 s**† |
| Warm time to first token, same prefix | 5.8 s | 0.8 s | 7.1 s | **0.5 s** |
| Same prompt after restarting the model server | ≈156 s | ≈141 s | **12.6 s** | ≈133 s |
| Decode | 11.3–11.6 tok/s | 11.5–12.4 tok/s | 11.4–12.1 tok/s | **25–43 tok/s** |
| Memory pressure | normal, 41% free | normal, 40% free | normal, 39% free | normal, 49–50% free |

The oMLX column was measured on 2026-09-18 during its trial, on the same machine and the same 16.7K-token prompt. **Restart recovery is the one axis where it is in a different class**: its SSD prefix cache restored 16,384 tokens and recomputed only 368, turning a 149.6 s cold prefill into 12.6 s (`Prefix cache restore … source=paged cached=16384 suffix=368`). The cache costs about 4.3 GB under `~/.omlx`, capped by `OMLX_CACHE_MAX_GB` (default 20).

The Splash column was measured on 2026-09-29 (Homebrew 1.1.0) with a rebuilt prompt of the same size — 16,817–16,960 tokens from `knowledge/`, since the original prompt text was not kept. †The first long prompt after switching to Splash took 196.9 s; later cold prompts, including a different uncached one, took 130.7–132.6 s, so the one-off extra is a first-use cost, not its steady state. Splash's SSD prompt cache (`--max-cache-disk`) is off by default, so a restart costs a full cold prefill.

Prefill is the cost, at roughly 104–118 tok/s. Caching works on all three: appending a tool result to a conversation keeps the cached prefix, and a 14.6K-token prompt that cost 140.6 s cold came back in 10.9 s once about 1K tokens were appended. On Ollama the cache is shared, so a web chat between two agent steps evicts it.

**Reading it honestly**

- 🏁 oMLX wins the part that dominates: decode. Embedding and retrieval differences are milliseconds against 80–100 s answers, so they barely move the total.
- ✂️ Many answers hit the 1024-token cap (15/23 Ollama, 11/23 MLX, 10/23 oMLX). The cap is identical everywhere, so the comparison is fair, but the totals describe truncated answers — and a faster stack hits the cap in less time, which flatters its total slightly.
- 🧮 Ollama really does hold the most memory (28.5 GB of model process). An earlier run reported 59 MB because the sampler missed Ollama 0.34's `llama-server` child processes; that is fixed, and this table is the corrected measurement.
- 🐍 oMLX is alpha software pinned at one commit, roughly seven months old and largely one maintainer's work. It is the fastest of the three here; that is not the same as the safest.
- 🔁 Single cold runs on one machine. Treat the percentages as a signal, not a verdict.

<details>
<summary><b>Reproduce the benchmark</b></summary>

<br/>

```bash
scripts/switch-stack.sh ollama && npx tsx scripts/benchmark-stack.ts
scripts/switch-stack.sh mlx    && npx tsx scripts/benchmark-stack.ts
scripts/switch-stack.sh omlx   && npx tsx scripts/benchmark-stack.ts
npx tsx scripts/compare-benchmarks.ts data/benchmarks/ollama-<time>.json data/benchmarks/mlx-<time>.json
```

`compare-benchmarks.ts` takes two runs at a time, so compare the pairs you care about. Benchmark mode makes `/v1` return `503`, which takes the Telegram agent offline for the duration — check `~/.hermes/cron/jobs.json` for the next scheduled run before starting, or it fails with `HTTP 503: Benchmark in progress`.

`benchmark-stack.ts` accepts `--runs`, `--app` and `--questions`. Benchmark mode (`/api/bench/start`, a 15-minute lease) pauses background LLM jobs; chat requests with `benchmark: true` use temperature 0, skip web search and cap answers at 1024 tokens. `/v1` and `/api/llm/complete` return `503` while it runs. The comparison reports TTFT, decode speed, embedding and retrieval time, peak memory, retrieval overlap, and writes a blind A/B review page with stack labels hidden.

Embedding parity check (stacks run one after the other):

```bash
LLM_PROVIDER=ollama npx tsx scripts/embedding-parity.ts save data/benchmarks/parity-ollama.json
LLM_PROVIDER=mlx    npx tsx scripts/embedding-parity.ts save data/benchmarks/parity-mlx.json
npx tsx scripts/embedding-parity.ts compare data/benchmarks/parity-ollama.json data/benchmarks/parity-mlx.json
```

The question set has 23 questions: 11 vendor, 5 threat, 2 regulation, 2 pharma, and 3 deliberately not covered by the knowledge base.

</details>

---

## The watchlist

Most news tooling watches *topics*. PharmaITChat watches **named entities**: three pharma customers, the peer sets they are measured against, and the IT and security vendors that sell into them. Every item is attributed to the entities it is about and the IT domains it touches, so "what has Novartis done in cloud this month" is a query over structured tags, not a keyword search.

| | Count | Who |
|---|---:|---|
| **Customers** | 3 | Roche, Novartis, Sandoz |
| **Peers** | 28 | The competitive sets each customer is measured against |
| **IT vendors** | 45 | Grouped by the domain they sell into; networking and end-user computing added 2026-09-30 (Arista, HP Inc., Omnissa, Citrix, plus Nutanix) |
| **Total watched entities** | **76** | |
| **Verified RSS/Atom feeds** | 59 | Including Google News search feeds where a company publishes none; every entity has at least one active feed |
| **EDGAR CIKs** | 49 | SEC filings, rate-limited to one shared 10 req/s gate |
| **Entity-less topic queries** | 188 | Google News queries covering the same ground with no named subject |

Twelve IT domains carry the tagging vocabulary: `cyber`, `ai`, `cloud`, `infrastructure`, `rnd_it`, `mfg_it`, `sap`, `data`, `storage`, `backup`, and since 2026-09-30 `networking` and `euc` (end-user computing), split out of `infrastructure` so each line you sell shows up on its own. Items stored before then keep their old tags. Measured before shipping (50 stored items re-tagged with the old and new prompt on Splash): 6 of 20 infrastructure items moved to `networking` or `euc` (PCs, network articles), none of 10 untagged items picked up a new tag, and the other ten domains agreed on 445 of 450 item-domain pairs. The vocabulary is **closed** — an entity id or domain the model invents rather than picks is dropped at the tagger boundary and again at the storage boundary, never stored.

### The nightly run

At **02:30** a Hermes cron job runs one pass in `--no-agent` script mode — no LLM agent step, just the script. Silent on a normal night; a Telegram message only when it fails.

```mermaid
flowchart LR
    F["Feeds in priority order<br/>customers → peers → vendors → topics"] --> A["Adapters<br/>RSS/Atom · Google News · EDGAR"]
    A --> D["Dedupe<br/>canonical URL, content hash, title key"]
    D --> T["Tag with the local 27B model<br/>entities · domains · signal · importance"]
    T --> S["SQLite data/watchlist.db"]
    T --> C["ChromaDB"]

    style D fill:#1e1b4b,stroke:#a78bfa,color:#e5e7eb
    style T fill:#064e3b,stroke:#22d3ee,color:#e5e7eb
```

**Dedupe happens before the model.** The same press release legitimately arrives through a company's IR RSS, through Google News and through EDGAR. Collapsing those three into one item costs a few store lookups; tagging them three times would cost three model calls. Every duplicate is recorded as an extra source on the surviving item rather than thrown away.

Three more properties hold the run together:

- **Tagging is sequential.** The local model serves one request at a time, so concurrency here would only queue behind itself.
- **A feed never takes the run down.** An adapter, tagger or store error is caught per feed: the failure is recorded, the feed's watermark is *not* advanced (so the next run re-fetches what this one missed) and the run moves on.
- **The run stops itself before anything else does.** A 250-item cap and a 45-minute wall-clock budget keep it inside Hermes' script timeout. Items past the cap are counted as deferred, not dropped, and the next run picks them up. A feed that has never been seen is backfilled 30 days, not from the beginning of time.

### The first unattended run

Night of **2026-09-21, 02:30–03:12 CEST** (run id 3), start to finish with nobody watching:

| | |
|---|---:|
| Items fetched | 1,165 |
| Collapsed by cross-source dedupe | 57 |
| Tagged and stored | 250 |
| Deferred by the 250-item cap | 858 |
| Stopped by the time budget | 0 |
| Failed feeds | 2 |
| Anomalies | 0 |
| Wall clock | 42 minutes |

Cap-bound and comfortably inside the budget. Disabling the `ir_page` adapter cut failures from 10 to 2 and anomalies from 14 to 0 in the same run, and cross-source dedupe went from 3 to 57 once EDGAR and Google News overlapped the IR feeds properly.

### Working with it

[`config/watchlist.yaml`](config/watchlist.yaml) is the single definition of who is watched and what topics run with no named entity. Editing that file is how an entity, feed or topic is added or retired — nothing else changes. A syntax error in it costs the news agent its topic list for the night and nothing more; it can no longer take the server down at boot.

```bash
npm run watchlist -- verify-feeds                      # fetch every configured feed once, report what parses
npm run watchlist -- ingest [--limit N] [--since ISO] [--only id,id]
npm run watchlist -- status [--days N]                 # last run's stats and per-entity counts, read-only
```

| Command | What it does |
|---|---|
| `verify-feeds` | Fetches every configured RSS/Atom feed once and reports which parse cleanly, writing nothing. EDGAR CIKs and IR pages are skipped with a reason — they are not RSS and would always report a spurious failure |
| `ingest` | One nightly pass. `--only` runs just the named entities' feeds (an unknown id is rejected rather than silently running zero feeds); `--since` overrides every feed's own watermark; `--limit` overrides the per-run cap. Prints which stack it tagged with and the run's counts, and exits non-zero if every attempted feed failed |
| `status` | The last recorded run's stats plus per-entity item counts over a trailing window (default 7 days) |

`ingest` resolves the stack exactly as the rest of the app does: `LLM_PROVIDER` if set, otherwise `data/run/active-stack` (written by `scripts/switch-stack.sh`), falling back to `ollama`.

Installing the schedule copies `hermes/scripts/pharmaitchat-watchlist-ingest.sh` into `~/.hermes/scripts/` with the repo's absolute path baked in, and creates the job with `--script … --no-agent --deliver local --failure-deliver telegram`:

```bash
scripts/hermes-setup.sh install-cron
```

### What is not built yet

Stated plainly, because a README that implies otherwise wastes the reader's time:

- **Monthly and quarterly digests, `search_watchlist` and `compare_entities`** from the [design spec](docs/superpowers/specs/2026-09-20-it-scene-watchlist-design.md) are not built; the [digest agent](#digests) covers any period on request and sends the weekly one.
- **IR-page collection is disabled.** The adapter scanned hundreds of links per entity and recognised zero dates on 14 of 29 pages, for 4 stored items in a whole run — noise at a scale that masks real failures. It is switched off at the run level (`DISABLED_FEED_KINDS` in `src/services/watchlist-ingest.ts`), not deleted: every `ir_page` URL and the research behind it stays in the config.
- **Every entity has an active feed** since 2026-09-30: the 13 that had none (nine peers, four vendors) got a Google News search feed. Peers use the customers' IT scope (name plus digital transformation, AI, CIO, data center, cloud migration, SAP or IT infrastructure), so Hikma and Zentiva are empty until they make IT news rather than filling up with share-price stories; vendors get their own disambiguated query ("Tulip Interfaces", Körber plus pharma/MES/Werum, Anthropic plus pharma/healthcare).

---

## Your role

Every answer and every digest is framed by **who is asking**: your title and company, the accounts you cover, and the lines you sell (storage, servers, networking, backup, end-user computing, security). There is no selector. You set it by chatting, in the web chat or on Telegram:

| You say | What happens |
|---|---|
| "I am the Dell GAM for Roche, Novartis and Sandoz" | A new role: it keeps what you said and asks only for what is missing (the lines you sell, a focus), then saves it and makes it active |
| "I'm now HLS principal at Everpure" | Starts another role the same way, even in the middle of answering questions for the first |
| "switch to my Dell role" | Makes a saved role active and shows its details |
| "add Lonza to my accounts, I don't sell networking" | Edits the active role and says what changed |
| "what is my role?" | Shows the active role |

One role is active for both the web chat and Telegram. While it is, the chat model is told who you are and to answer for that seller: what the news means for your accounts, and your company's products first.

```mermaid
flowchart LR
    M["Message<br/>web chat or Telegram"] --> K{"About your role?<br/>keyword check, or an<br/>onboarding question is open"}
    K -- "no" --> CHAT["Normal answer<br/>with your role in the prompt"]
    K -- "yes" --> X["27B reads it into validated changes<br/>(onboarding answers are parsed without it)"]
    X -- "not about the role" --> CHAT
    X --> E["Role engine<br/>switch · onboard · update · show"]
    E --> S[("data/run/roles.json<br/>mode 600")]
    E --> R["Reply: a question,<br/>or the role's details"]
```

- **The model never holds the state.** It turns a free-form message into a checked set of changes (portfolio values limited to the six lines); the engine decides what to ask or save. Answers to an onboarding question are parsed without the model, so they are instant.
- **An ordinary question costs nothing extra.** Only messages that look like role talk ("I am … at …", "my accounts", "switch to …") reach the model, and one that turns out not to be about the role goes on to the normal answer.
- **Measured live** (Splash, 2026-09-30): the Dell role came out of one sentence plus two answers; switching, editing and "what is my role?" each took 3–4 s; ordinary questions were never caught.
- **On Telegram** Hermes passes such messages to the `my_role` tool verbatim and relays the reply. Scheduled Hermes jobs cannot call it.
- **Benchmarks and the KB canaries** skip roles entirely, so their answers stay comparable.

## Digests

"Make me a digest of what happened this week" goes to the **digest agent**, not to the normal 5-chunk answer, in the web chat and on Telegram (`make_digest`). Every Monday at 07:30 Hermes sends last week's digest to Telegram by itself. Each digest is written for [your role](#your-role) and ends with **action items**: one per line you sell, tied to an account, turning the news into a next step.

```mermaid
flowchart LR
    Q["'digest of last week'<br/>'storage at Novartis this month'"] --> P["Period and focus<br/>parsed without a model"]
    P --> S[("watchlist.db<br/>items in the period")]
    S --> SEL["Deterministic selection<br/>sections, importance, caps<br/>accounts round-robin"]
    SEL --> W["4 short 27B calls<br/>headline · accounts ·<br/>infrastructure · action items"]
    W --> V{"Every bullet cites<br/>real item numbers?"}
    V -- "no" --> DROP["Bullet dropped"]
    V -- "yes" --> R["Render within budget<br/>links, then lists give way;<br/>action items never cut"]
    R --> OUT["Web chat (full)<br/>Telegram (≤ 3,900 chars)"]
```

| Section | What goes in |
|---|---|
| Headline | 3–4 bullets on the period's most important items for your role |
| Your accounts | One bullet per account, items taken round-robin so a busy account cannot crowd out the others |
| Infrastructure scene | Storage, servers, networking and backup news: competitor moves, launches, supply and pricing signals |
| Pharma industry · Cyber · AI, cloud & data · R&D and manufacturing IT | The top items as a plain list, with links |
| Action items | One per portfolio line: account, next step, which of your company's product families to lead with |
| Footer | Items in the period, accounts the watchlist does not follow, feeds failing 3+ nights running |

- **Selection is code, prose is the model's.** Which items go in is decided over the item store; the model writes about the items it is handed, and a bullet that cites no real item number is dropped. A failed model call leaves that section as a plain item list.
- **Period and focus come from your wording**: "this week" (7 days), "last week" (Monday to Sunday), "yesterday", "this month", "last month", "last 10 days", "since Monday"; a company or a domain word ("storage", "cyber", "manufacturing") narrows it; "my accounts" keeps only your accounts and their peers.
- **Measured** (Splash, 2026-09-30, Dell GAM role): 35 items, 3,151 characters, 88 s over four calls; last week's digest from the script in 50 s. The first run gave all eight account slots to Roche (25 items against Novartis' 3 and Sandoz' 2) and cut the action items at the Telegram limit; both are fixed and tested.
- **Action items are prompts, not facts**: they name product families from the model's own knowledge, which can be out of date.

**Weekday briefing** (Tuesday to Friday, 07:30): yesterday's news about your accounts, with the account bullets and action items only. It is sent only when at least one real action item survives: importance-1 account items (the tagger's "barely relevant", where mis-tagged stories sit) are left out, and bullets that say "no action" or "unrelated" are dropped. Tested live on 2026-09-30, yesterday's only "Roche" item was a mis-tagged financial-analyst story, and the first version turned it into six "No action" lines; now that day is silent. It replaced the 06:00 "news digest" job, which reported the retired news agent's "0 new articles" every morning.

Run either by hand: `npx tsx scripts/digest.ts --request "digest of last week"` or `--request "briefing of yesterday" --briefing`. Each scheduled run is kept in `data/logs/weekly-digest-<date>.log` or `daily-briefing-<date>.log`.

## Chat, retrieval and the knowledge base

Ask a question in the browser at `http://localhost:3000` (or by voice, or on Telegram) and four retrieval paths run in parallel before the model sees anything.

```mermaid
flowchart LR
    U["Question<br/>text or voice"] --> API["POST /api/chat<br/>SSE stream"]

    subgraph R["Parallel retrieval"]
        direction TB
        C["ChromaDB<br/>vector search"]
        M["In-memory index<br/>vector + keyword"]
        G["Neo4j graph<br/>3 s timeout"]
        W["Google News RSS<br/>optional"]
    end

    API --> R
    R --> CTX["Merged context<br/>in-memory used if ChromaDB misses"]
    CTX --> LLM["Active stack<br/>Qwen3.8 27B"]
    LLM --> OUT["Streamed answer<br/>sources, TTFT, tok/s"]
    LLM --> GAP["Gap detector"]
    GAP -- "low confidence" --> N8N["n8n webhook"]
    API -. "reasoning steps" .-> UI["Reasoning panel"]

    style R fill:#1e1b4b,stroke:#a78bfa,color:#e5e7eb
    style LLM fill:#064e3b,stroke:#22d3ee,color:#e5e7eb
    style N8N fill:#4a1d6b,stroke:#d946ef,color:#e5e7eb
```

The reasoning panel shows each step live ("Searching knowledge graph…", "Searching the web for: …") and collapses when the first answer token arrives. Every answer carries a `response_id` for feedback and names the documents it used. Typing `/names` toggles whether answers name specific companies in incident discussions.

### The knowledge base

`knowledge/` ships **40 curated documents** (36 Markdown, 2 DOCX, 2 PDF), grown by uploads, the n8n research loop and the watchlist's nightly ingest. The embedded corpus is about 439 MB across the per-stack ChromaDB collections; at the last verified rebuild the Ollama index held 7,779 chunks and the MLX index 7,623.

| Area | Examples |
|---|---|
| 🏢 Vendor intelligence | Dell, Pure Storage, NetApp, HPE, VAST Data, WEKA, NVIDIA, SAP, ServiceNow, Snowflake, Databricks, Splunk / Sentinel / CrowdStrike, endpoint and identity security, Bug Bounty Switzerland |
| 💊 Pharma industry | Business and science basics, regulation, Phase 3 pipeline 2025–26, top 20 by revenue / market cap / reputation, manufacturing plants, Basel biotech hub |
| 🛡️ Cyber threats | Major pharma attacks, attacks by year, attack types, systems compromised, costs and remediation, IT/OT threats 2025 |

Uploads accept `.txt`, `.md`, `.pdf`, `.csv`, `.json`, `.docx`, `.pptx` and `.ppt`. Everything ingested is saved to `data/raw_documents/` first, so an index can always be rebuilt from source.

### The knowledge graph

Neo4j stores **14 entity types** (Company, Subsidiary, Drug, TherapeuticArea, ManufacturingSite, Country, RegulatoryBody, Regulation, ThreatActor, Attack, AttackVector, Vendor, Product, Technology) and **20 relationship types** such as `ACQUIRED`, `MANUFACTURES`, `TARGETED`, `ATTRIBUTED_TO`, `USED_VECTOR` and `PROTECTS_AGAINST`. Chat extracts likely entity names from the question and queries the graph alongside vector search; graph writes from uploads run asynchronously so they never block a response.

### The self-healing loop

```mermaid
sequenceDiagram
    participant App as PharmaITChat
    participant N as n8n
    participant S as SearXNG
    App->>App: In-scope question the answer did not answer (2 h cooldown per topic, logged to SQLite)
    App->>N: Webhook with gap_id
    N->>App: POST /api/llm/complete (generate 3 search queries)
    N->>S: Search each query, dedupe, fetch pages
    loop each fetched page
        N->>App: POST /api/llm/complete (extract facts, page sent as relevance)
        App->>App: System One pre-check — clearly off-topic pages answer NOT_RELEVANT with no 27B call
    end
    alt something relevant found
        N->>App: POST /api/knowledge/ingest-text
        N->>App: POST /api/knowledge/gaps/check-resolution
        App->>App: re-answer — the 27B judges it, the scorer's verdict is logged beside it
        App-->>N: resolved, or unresolved with retry_count++
    else nothing relevant
        N->>App: POST /api/knowledge/gaps/:id/unresolved
    end
```

The KB health check is no longer an n8n workflow: see [KB canaries](#kb-canaries).

| File | Nodes | Purpose |
|---|---:|---|
| `n8n/knowledge_gap_workflow_v2.json` | 18 | Gap auto-fill with resolution check (recommended) |
| `n8n/knowledge_gap_workflow.json` | 13 | Gap auto-fill, v1 |

All LLM steps call `POST /api/llm/complete`, so they run on the active stack. See [`n8n/README.md`](n8n/README.md).

### The System One scorer

Every judgment in the loop above ("did the chat answer the question?", "does the re-answer close the gap?") costs a full 27B call. [open-jev](https://github.com/daseinlabs/open-jev) serves Gemma 3 4B (4-bit, ~3 GB, `127.0.0.1:8010`) as a *System One* scorer: it answers a typed yes/no question with a probability in under a second, and the app reaches it through `/api/decide` (`config/decide.yaml` holds the thresholds, 0.85 and 0.5).

**It decides one thing: which fetched pages are not worth the 27B's time.** Before the gap workflow's 27B extraction, the app asks it whether a page is about the gap's topic; below `page_relevance_skip_below` (0.1) the page is answered `NOT_RELEVANT` with no 27B call. The 27B used to discard about two thirds of the pages it read. On 34 pages from real gap runs, this skips 9 of the 26 the 27B discarded and none of the 8 it kept (lowest kept: 0.915). Any scorer failure extracts the page as before.

**Everywhere else it only watches.** In gap resolution the 27B still decides and the scorer's verdict is logged beside it (`[Gap Resolution] 27B X, scorer Y`); on every chat turn, with `shadow_detection: true`, both verdicts go to the `detection_shadow` table. Chat works the same with the scorer down.

Before a scorer is trusted, it is measured against the 27B:

| Tool | Measures |
|---|---|
| `scripts/replay-gap-decisions.ts` | The 60 open gaps (mostly non-answers): does the scorer catch a missed answer? |
| `scripts/replay-detection.ts` | Past confident questions, answers regenerated in benchmark mode: does it raise false alarms on good answers? |
| `scripts/shadow-report.ts` | Live agreement on real chat turns |
| `scripts/replay-page-relevance.ts` | Every page in n8n's gap-run history: which discarded pages it skips, and whether it would ever skip one the 27B kept |

Each replay takes `--question candidate.json` to try a new wording without touching production, and `--details` to list every disagreement. The wording matters more than anything else measured so far: on the same 60 gap answers, the first detection question agreed with the 27B 26.8% of the time and the current one 91.2%; the 16-bit model was replaced by the 4-bit one on the same kind of evidence. The same replays also showed where it does **not** work: on detection no wording tested both caught non-answers and spared good ones, so detection stays with the 27B. Setup: [Optional: System One scorer](#setup).

> [!NOTE]
> The standalone news agent (`src/services/news-agent.ts`) no longer scrubs anything. Its 188 topic queries now belong solely to the watchlist ingest, which already fetches every one of them with its own dedupe ladder; running both meant the same articles were embedded into the same collection twice a day. The job, its state file and its tool contract (`POST /api/agent/run`, the MCP `run_news_agent` tool) are kept and now report zero.

---

## Hermes Agent on Telegram

[`hermes/`](hermes/README.md) runs [Hermes Agent](https://hermes-agent.nousresearch.com/) as a Telegram assistant **on the same local 27B model** — the phone talks to your own machine, not to a cloud. Everything needed to rebuild it lives in the repo; secrets stay in `~/.hermes/.env` and `data/run/*-token` at mode 600.

```bash
scripts/switch-stack.sh token           # PharmaITChat API token
scripts/switch-stack.sh mcp-token       # token Hermes uses for pharmaitchat-mcp
scripts/hermes-setup.sh all             # config, .env, launchd services, plugin, cron jobs
scripts/hermes-setup.sh check           # read-only status; prints variable names, never values
```

| Job | Schedule | What it does |
|---|---|---|
| `pharmaitchat-watchlist-ingest` | 02:30 daily | The nightly watchlist run (script mode, no agent). Silent unless it fails |
| `pharmaitchat-kb-canary` | 05:00 daily | Asks the KB canary questions (script mode). Silent unless one fails |
| `pharmaitchat-gap-resolution` | 07:00 daily | Re-checks at most 3 triggered knowledge gaps, oldest first; `[SILENT]` when there are none |
| `pharmaitchat-weekly-digest` | Monday 07:30 | Last week's digest for your role, ending with action items (script mode) |
| `pharmaitchat-daily-briefing` | Tuesday–Friday 07:30 | Yesterday's news about your accounts and what to do about it (script mode). Silent on a day with nothing actionable |
| `pharmaitchat-health-watch` | 09:00 and 19:00 | Reports failing checks; `[SILENT]` while healthy |
| `pharmaitchat-feedback-digest` | Monday 08:00 | Weekly rating trends and the worst-rated answers |

- **Tool scope is the control.** Telegram and CLI runs get 15 of the 16 MCP tools (no `start_reindex`). Scheduled runs connect to a separate, write-limited `pharmaitchat_cron` server with 14 tools: no `start_reindex` and no `add_knowledge`. MCP calls are never approval-gated, so the tool list is what enforces this. Scheduled runs also get no web, memory, terminal or file toolsets.
- **Sandbox:** shell commands run in a Docker container with `--network=none`, 512 MB and 1 CPU, no host project or home directory mounted. Verified live: `/Users` is not visible, `host.docker.internal` does not resolve and the app is unreachable from inside.
- **Web search:** the local SearXNG instance, with the keyless cloud fallbacks turned off. Private and loopback URLs stay blocked for Hermes' web tools, so ChromaDB and Neo4j cannot be reached that way.
- **Speed:** a warm Telegram round trip takes about 1 min 47 s end to end (Hermes' own timer reports 107.7 s). The first step of a cold session pays the full prefill, about 140–156 s.
- **Restarting the MCP service** costs the next Hermes message about 3 minutes, because the model has to prefill the tool list again.
- **After a reboot:** everything comes back on its own. The Hermes gateway and the launchd jobs `com.pharmaitchat.stack` (the app, the active model stack, ChromaDB, and colima with the Neo4j and SearXNG containers), `mcp`, `n8n`, `jev` and `mlx-watchdog` all run at load. `scripts/check-services.sh` confirms it.

The Telegram bot is also what confirms a stack switch requested from the web UI — see [Switching from the web UI](#switching-from-the-web-ui).

<details>
<summary><b>Running Hermes on a second Mac</b></summary>

<br/>

Point the agent at the model Mac's LAN or VPN address. On the PharmaITChat Mac, bake the bind address into the launch agent so it survives a reboot:

```bash
MCP_HOST=0.0.0.0 scripts/hermes-setup.sh install-services
```

An MCP token is then required. On the Hermes Mac, set `PHARMALLM_URL`, `PHARMALLM_MCP_URL` and `SEARXNG_URL` to the model Mac and copy the two token values into `~/.hermes/.env` by hand. Full instructions in [`hermes/README.md`](hermes/README.md).

</details>

---

## The MCP server and the model gateway

PharmaITChat serves AI agents in two ways: as a set of tools, and as a model provider.

| | Endpoint | Purpose |
|---|---|---|
| 🧰 **MCP tools** | `pharmaitchat-mcp` at `http://<host>:3200/mcp` | 20 tools over Streamable HTTP: search, full RAG answers, add knowledge, graph, gaps, health, metrics, news agent, background reindex, feedback, exports, your role, digests |
| 🧠 **Model gateway** | `http://<host>:3000/v1` or `https://<host>:3443/v1` | OpenAI-compatible chat completions on the active stack, tools and streaming supported |

### The MCP server

`mcp/` is a separate package and process with no RAG logic of its own: every tool maps to one or two PharmaITChat REST calls. It speaks stateless Streamable HTTP at `POST /mcp` and answers `GET /healthz` without auth, which makes the knowledge base usable from any MCP client — Claude Desktop, Hermes, your own.

```bash
scripts/switch-stack.sh mcp-token       # create data/run/mcp-token
npm --prefix mcp install
scripts/switch-stack.sh mcp start       # launchd service com.pharmaitchat.mcp, logs in data/logs/mcp.log
scripts/switch-stack.sh mcp status
scripts/switch-stack.sh mcp stop
```

Without `MCP_TOKEN` the service accepts only same-machine requests with a local Host header. With a token it requires `Authorization: Bearer` and accepts any Host. `scripts/run-mcp.sh` refuses to listen on a non-loopback host without a token. See [`mcp/README.md`](mcp/README.md) for the full tool list.

**Tool payloads are compacted** before they reach an agent (`mcp/src/tools/compact.ts`): embeddings are dropped, long lists become `{count, sample, truncated}`, stored answers are cut to 300 characters, and `list_knowledge_gaps` returns 20 rows by default (`limit` up to 50).

| Tool result | Before | After |
|---|---:|---:|
| `search_knowledge` (5 chunks) | ≈48,600 tokens | ≈1,100 tokens |
| `list_knowledge_gaps` | ≈31,000 tokens | ≈2,700 tokens |
| `knowledge_status` | ≈10,000 tokens | ≈530 tokens |
| `news_agent_status` | ≈2,200 tokens | ≈260 tokens |

Each search chunk used to carry a ~30 KB embedding object next to ~440 characters of text, so 98% of the payload was a vector no agent can use. That size, re-read on every step, was the real cost of agent runs — not cache misses.

### The model gateway

`/v1/chat/completions` forwards to the active stack and pipes the response through byte for byte, so streaming and tool calls work unchanged. It forces the stack's own chat model (the `model` field is ignored), forwards only `messages`, `tools`, `tool_choice`, `stream`, `stream_options`, `temperature` and `max_tokens` (capped at 4096), and drops the rest. It returns `503` during a benchmark or when the stack is down, with no fallback.

---

## Setup

**Prerequisites:** [Homebrew](https://brew.sh), Node.js 22, Python 3, about 50 GB of free disk for the models, and `ffmpeg` if you want voice input. The **MLX and oMLX stacks require Apple Silicon**; **Splash additionally requires an M3 or newer and macOS 26.4+** (36 GB unified memory minimum, 48 GB recommended). The Ollama stack only needs Ollama, so a host without Apple Silicon still gets the whole pipeline — on one stack instead of four. The setup scripts themselves drive Homebrew and `launchctl`, so they assume macOS.

```bash
# 1. Install Ollama and the Node dependencies
brew install ollama && brew services start ollama
git clone git@github.com:sebdallais-git/PharmaIT_Chat_and_Digest.git
cd PharmaIT_Chat_and_Digest
npm install

# 2. One-time setup: download the Ollama, MLX and Splash models (~50 GB total),
#    create the MLX and oMLX venvs (oMLX reuses the same Hugging Face snapshots,
#    so it adds no extra download), install Splash from Homebrew, then start ChromaDB,
#    build the active stack's indexes and launch the app
scripts/switch-stack.sh prepare          # also installs the oMLX venv and Splash (Homebrew)
```

When `prepare` finishes, PharmaITChat is running on the Ollama stack (the default):

| | URL |
|---|---|
| 💬 Chat | http://localhost:3000 |
| 📊 Dashboard | http://localhost:3000/dashboard |
| ❤️ Health | http://localhost:3000/api/health |

Later sessions start everything (ChromaDB, the last active stack and a hot-reload dev server) with:

```bash
npm run dev          # runs scripts/start-services.sh
```

> [!NOTE]
> The first index build re-embeds the whole knowledge base and took 12–16 minutes here. Ollama 0.17.6 could not pull Qwen3.8; the setup was verified with Ollama 0.34.0.

> [!IMPORTANT]
> Nothing starts the app or the model stack after a reboot. Run `scripts/start-services.sh` (or `scripts/switch-stack.sh ollama`) before you expect answers. Only the MCP service and the Hermes gateway come back on their own, and until the app is up they report it as unreachable.

<details>
<summary><b>Optional: the watchlist schedule</b></summary>

<br/>

The nightly ingest is a Hermes cron job, so it needs Hermes installed first ([`hermes/README.md`](hermes/README.md)). Then:

```bash
scripts/hermes-setup.sh install-cron     # creates all six jobs from hermes/cron/jobs.json
npm run watchlist -- verify-feeds        # sanity-check the feeds before the first night
npm run watchlist -- status              # after the first run: counts and per-entity totals
```

</details>

<details>
<summary><b>Optional: self-healing loop (n8n + SearXNG)</b></summary>

<br/>

1. Run [SearXNG](https://github.com/searxng/searxng) on `http://localhost:8888` with `bash scripts/setup-searxng.sh`, which builds its settings from `config/searxng/settings.yml`, and [n8n](https://n8n.io) on `http://localhost:5678`. General web search uses the [Brave Search API](https://brave.com/search/api/) only: the public engines SearXNG would scrape answer a self-hosted instance with CAPTCHAs and rate limits, and Bing returned spam that crowded out real results. Put a Brave key in `data/run/brave-api-key` (mode 600) before running the script, or web search returns nothing; it is rendered into the container's settings, never into the repo or a command line.
2. In n8n, import `n8n/knowledge_gap_workflow_v2.json` (**Workflows → Import from File**) and activate it.
3. Nothing else to wire: `start-services.sh` and `switch-stack.sh` point the gap detector at `http://localhost:5678/webhook/knowledge-gap` (override with `N8N_WEBHOOK_URL`), and `scripts/run-n8n.sh` hands n8n the API token from `data/run/api-token`.

The workflows call protected routes with `Authorization: Bearer {{ $env.PHARMALLM_API_TOKEN }}` — the legacy variable name, which `run-n8n.sh` sets. n8n 2.x blocks `$env` in expressions by default, so `run-n8n.sh` also sets `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`; an n8n started some other way needs both. See [`n8n/README.md`](n8n/README.md).

</details>

<details>
<summary><b>Optional: System One scorer (open-jev)</b></summary>

<br/>

A local Gemma 3 4B scorer that answers typed yes/no questions with a probability. It records its verdict next to the 27B's in gap resolution, and on every chat turn when `shadow_detection` is on in `config/decide.yaml`. It never decides on its own; see `docs/superpowers/specs/2026-09-22-system-one-decision-design.md`. Chat works without it.

```bash
# 1. Next to this repo, with uv (brew install uv)
cd .. && git clone https://github.com/daseinlabs/open-jev.git && cd open-jev && make venv

# 2. Accept the Gemma licence at huggingface.co/google/gemma-3-4b-it, then store a Read token
#    in data/run/hf-token (mode 600) and create the scorer key:
( umask 077; openssl rand -hex 32 > ../PharmaIT_Chat_and_Digest/data/run/jev-token )

# 3. The 4-bit MLX build: ~3 GB beside the 27B (open-jev's `make setup` fetches the 16-bit 8 GB one)
HF_TOKEN="$(cat ../PharmaIT_Chat_and_Digest/data/run/hf-token)" .venv/bin/hf download \
  mlx-community/gemma-3-4b-it-4bit --local-dir models/gemma-3-4b-it-4bit

# 4. Install the launchd job (127.0.0.1:8010) and check it
cd ../PharmaIT_Chat_and_Digest && scripts/hermes-setup.sh install-services
scripts/check-services.sh | grep jev
```

`scripts/run-jev.sh` serves `models/gemma-3-4b-it-4bit` unless `JEV_MODEL` says otherwise. Measure a change of model or question with `scripts/replay-gap-decisions.ts` before relying on it.

</details>

<details>
<summary><b>Optional: Graph RAG (Neo4j)</b></summary>

<br/>

```bash
# Neo4j Community in Docker (the app's default password is pharma2024)
docker run -d --name neo4j-pharma \
  -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/pharma2024 \
  neo4j:community

# Bulk-extract entities from knowledge/*.md (requires the Ollama stack to be running)
pip install -r python/requirements.txt
python python/graph_builder.py
```

`graph_builder.py` calls Ollama's `/api/generate` directly with `OLLAMA_MODEL` (default `mistral-small:24b`), so pull that model or set `OLLAMA_MODEL` to one you have. Browse the graph at http://localhost:7474. New uploads are added to the graph automatically.

</details>

<details>
<summary><b>Optional: agents (MCP service and Telegram assistant)</b></summary>

<br/>

```bash
scripts/switch-stack.sh token          # create data/run/api-token
scripts/switch-stack.sh mcp-token      # create data/run/mcp-token
npm --prefix mcp install
scripts/switch-stack.sh mcp start      # pharmaitchat-mcp under launchd (com.pharmaitchat.mcp)
scripts/switch-stack.sh mcp status
```

Creating the API token does not enable it: restart the app (`scripts/switch-stack.sh ollama`, `mlx` or `omlx`) so it is exported. The Telegram assistant is a separate install — see [`hermes/README.md`](hermes/README.md).

</details>

### Voice input and HTTPS

The mic button records audio in the browser (MediaRecorder), uploads it to `POST /api/chat/transcribe` (max 25 MB), converts it to 16 kHz WAV with `ffmpeg`, and transcribes it locally with whisper.cpp (`ggml-base.en`, bundled with `whisper-node`).

Browsers only allow microphone access on secure origins, so an **iPad or phone needs HTTPS**. Put `certs/key.pem` and `certs/cert.pem` in place and the server also listens on **https://&lt;your-host&gt;:3443** (`HTTPS_PORT`). The device must trust the certificate. A token, once set, is required on both ports.

---

## Architecture

```mermaid
flowchart TB
    subgraph CL["Clients"]
        direction LR
        B["Browser<br/>chat + dashboard"]
        N["n8n workflows"]
        AG["AI agents<br/>Hermes, Claude Desktop"]
    end

    MCP["pharmaitchat-mcp :3200<br/>20 tools, Streamable HTTP<br/>MCP_TOKEN + payload compaction"]

    subgraph APP["PharmaITChat :3000 / :3443"]
        direction TB
        AUTH["auth middleware<br/>UI routes open, everything else needs a token"]
        V1["/v1<br/>OpenAI-compatible gateway"]
        API["/api/*<br/>chat, knowledge, gaps, graph, feedback, stack"]
        RJ["reindex job<br/>202 + job id, poll status"]
    end

    CRON["Nightly watchlist ingest<br/>02:30, Hermes script mode"]
    STACK["Active stack<br/>Ollama :11434, MLX :8080 or oMLX :8090"]
    JEV["System One scorer :8010<br/>Gemma 3 4B, shadow only"]
    DATA["ChromaDB · in-memory index<br/>Neo4j · SQLite (app + watchlist)"]

    B --> AUTH
    N --> AUTH
    AG --> MCP
    AG --> AUTH
    MCP -- "REST + API token" --> AUTH
    AUTH --> V1
    AUTH --> API
    API --> RJ
    V1 --> STACK
    API --> STACK
    API -. "/api/decide" .-> JEV
    API --> DATA
    RJ --> DATA
    CRON --> STACK
    CRON --> DATA

    style AUTH fill:#7c2d12,stroke:#fb923c,color:#e5e7eb
    style MCP fill:#4a1d6b,stroke:#d946ef,color:#e5e7eb
    style STACK fill:#064e3b,stroke:#22d3ee,color:#e5e7eb
    style CRON fill:#0f766e,stroke:#5eead4,color:#e5e7eb
    style JEV fill:#1e3a8a,stroke:#60a5fa,color:#e5e7eb
```

Static files and the browser routes listed in `src/api/auth.ts` are always open. Everything else (`/v1/*` and the rest of `/api/*`) needs `Authorization: Bearer <token>` once `PHARMAITCHAT_API_TOKEN` is set. Without a token, those routes accept only same-machine requests that also carry a `localhost`, `127.0.0.1` or `[::1]` Host header, which blocks DNS rebinding.

---

## API Reference

The **Auth** column shows which routes need `Authorization: Bearer <PHARMAITCHAT_API_TOKEN>` once a token is set. Without a token, `token` routes accept only same-machine requests addressed as localhost. `open` routes are the browser UI routes listed in `src/api/auth.ts` and never need the token.

<details>
<summary><b>Model gateway (OpenAI-compatible)</b></summary>

<br/>

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/v1/models` | GET | token | The active stack's chat model (`503` when the stack is down) |
| `/v1/chat/completions` | POST | token | Forwarded to the active stack, tools and streaming supported (`503` during a benchmark or when the stack is down) |

</details>

<details>
<summary><b>Chat, stack and benchmark</b></summary>

<br/>

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/api/chat` | POST | open | SSE stream with reasoning steps, token stats and `response_id` |
| `/api/chat/transcribe` | POST | open | Multipart `audio` file (max 25 MB) → `{ "text": "..." }` |
| `/api/chat/models` | GET | open | Active stack and its chat and embedding models |
| `/api/llm/complete` | POST | token | `{ prompt }` → `{ response }` on the active stack (used by n8n) |
| `/api/bench/start` | POST | token | Pause background LLM jobs (15-minute lease, refreshed by calling again) |
| `/api/bench/stop` | POST | token | Resume background LLM jobs |
| `/api/bench/status` | GET | token | Benchmark flag and running background jobs |
| `/api/stack/switch` | POST | open | `{ stack }` → request a switch to `ollama`, `mlx` or `omlx`; sends a Telegram message with Switch/Cancel buttons (`202` pending confirmation, with `id`; `400` unknown stack; `409` refused — already active, another switch pending, a switch already in progress, a benchmark or a reindex running, Telegram not configured, or `hermes_unavailable` when the Hermes gateway or its plugin cannot receive the tap; `502` if the Telegram send fails) |
| `/api/stack/confirm` | POST | token | `{ token }` from the Telegram button, sent by the Hermes plugin; starts `scripts/switch-stack.sh <target>` (`200 {status, target}`, `410` if the token expired or was already used) |
| `/api/stack/cancel` | POST | token | `{ token }`; drops the pending switch (`200 {status, target}`, `410` as above) |
| `/api/stack/status` | GET | open | Active stack, whether Telegram is configured, `hermes_ready`, `hermes_reason`, any pending switch, `cancelled`, and switch progress |

`/api/stack/switch` and `/api/stack/status` are `open` because requesting a switch or checking its status needs no proof of identity — approval happens on the Telegram tap. `/api/stack/confirm` and `/api/stack/cancel` need the bearer token because the tap reaches the app through the Hermes plugin, not from the phone directly.

</details>

<details>
<summary><b>Knowledge, reindex and gaps</b></summary>

<br/>

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/api/knowledge/stats` | GET | open | Knowledge base stats |
| `/api/knowledge/search` | POST | open | Search the knowledge base |
| `/api/knowledge/ingest-text` | POST | open | Ingest raw text (saved to `data/raw_documents/` first) |
| `/api/knowledge/upload` | POST | open | Upload and ingest a file (saved as a raw document first) |
| `/api/knowledge/add` | POST | token | Add a URL or text to ChromaDB |
| `/api/knowledge/status` | GET | token | ChromaDB status |
| `/api/knowledge/reindex` | POST | token | Start rebuilding the active stack's indexes in the background: `202 { job_id, status: "running" }`, `409` while a reindex or benchmark runs |
| `/api/knowledge/reindex/status` | GET | token | Most recent reindex job: `status` (`idle`, `running`, `succeeded`, `failed`), progress, result or error |
| `/api/knowledge/gaps` | GET | token | Recent gap detections |
| `/api/knowledge/gaps/stats` | GET | token | Gap analytics |
| `/api/knowledge/gaps/check-resolution` | POST | token | Re-ask a gap through the full RAG pipeline |

Job state lives in memory, so a server restart forgets it. The index completeness markers remain the source of truth.

</details>

<details>
<summary><b>Feedback, dashboard, graph and agent</b></summary>

<br/>

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/api/feedback` | POST | token | `{ response_id, rating (1-5), comment? }` |
| `/api/feedback/stats` | GET | token | Rating analytics (7d, 30d, RAG vs non-RAG) |
| `/api/feedback/low-rated` | GET | token | Answers rated 2 or lower, with chunk IDs |
| `/api/feedback/weekly-digest` | GET | token | 7-day summary with improvement priorities |
| `/api/health` | GET | open | Active stack (`llm_chat`, `llm_embed`, `search_index`), ChromaDB, SearXNG, Neo4j, SQLite |
| `/api/dashboard/metrics` | GET | open | All dashboard metrics (30 s cache) |
| `/api/dashboard/chromadb-misses` | GET | open | Recent ChromaDB misses and top missed queries |
| `/api/dashboard/kb-health` | GET | token | KB canary status (`ok`, `failing`, `stale`, `never-run`), newest run and the last 30 pass counts |
| `/api/role` | GET | token | The active role, every saved role, whether an onboarding is open |
| `/api/role/message` | POST | token | One turn of the role conversation: `{message}` → `{reply}` |
| `/api/digest` | POST | token | Build a digest: `{request?, budget?}` → `{markdown, period, items}` (default: the last 7 days, 3,900 characters) |
| `/api/graph/health` | GET | token | Neo4j connection check with latency |
| `/api/graph/stats` | GET | open | Node and relationship counts by type |
| `/api/graph/search` | POST | token | Search by entity name, returns neighbors |
| `/api/graph/rebuild` | POST | token | Clear and rebuild the graph (Ollama stack only, `409` on MLX and oMLX) |
| `/api/agent/status` | GET | open | News agent last run and the watchlist's topic list |
| `/api/agent/run` | POST | open | Trigger the news agent now (reports zero — see the note above) |

</details>

---

## Monitoring and feedback

**Dashboard** (`/dashboard`, refreshes every 60 s, metrics cached 30 s):

| Panel | Shows |
|---|---|
| Metric cards | Questions today, confidence rate, average rating, knowledge base size |
| Time series | 30-day questions and confidence, user ratings |
| Gap intelligence | Recent gaps with status, top gap topics |
| System health | Knowledge sources, active stack, ChromaDB, SearXNG, Neo4j and SQLite checks with latency |

**Health** (`/api/health`) is `healthy`, `degraded` when only ChromaDB, SearXNG or Neo4j is down, or `unhealthy` when the active stack's chat or embedding endpoint or the search index is unusable. The inactive stacks are never probed.

**Feedback:** ratings (1–5) are linked to the chunks used, compared across RAG and non-RAG answers, and answers rated 2 or lower are surfaced as improvement candidates. ChromaDB misses are logged to show coverage gaps.

---

## Configuration

Everything works with defaults. `scripts/switch-stack.sh` and `npm run dev` set `LLM_PROVIDER` and export the API token from `data/run/api-token` when it exists.

<details>
<summary><b>Environment variables</b></summary>

<br/>

| Variable | Default | Description |
|---|---|---|
| `LLM_PROVIDER` | `ollama` | Active stack: `ollama`, `mlx`, `omlx` or `splash` |
| `PORT` | `3000` | HTTP port |
| `HTTPS_PORT` | `3443` | HTTPS port (used when `certs/key.pem` and `certs/cert.pem` exist) |
| `HOST` | `0.0.0.0` | Bind address |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama stack endpoint |
| `MLX_CHAT_URL` | `http://localhost:8080` | MLX chat server |
| `MLX_EMBED_URL` | `http://localhost:8081` | MLX embedding server |
| `OMLX_URL` | `http://localhost:8090` | oMLX server (chat and embeddings) |
| `MLX_PYTHON` | `python3` | Python used to create `python/mlx-venv` and `python/omlx-venv` |
| `CHROMADB_URL` | `http://localhost:8100` | ChromaDB server |
| `N8N_WEBHOOK_URL` | `http://localhost:5678/webhook/knowledge-gap` | n8n webhook for gap auto-fill (set by `start-services.sh` and `switch-stack.sh`) |
| `NEO4J_URI` | `bolt://localhost:7687` | Neo4j Bolt URI |
| `NEO4J_USER` | `neo4j` | Neo4j user |
| `NEO4J_PASSWORD` | `pharma2024` | Neo4j password |
| `APP_URL` | `http://localhost:3000` | App URL used by `scripts/reindex-stack.ts` |
| `PHARMAITCHAT_API_TOKEN` | *(none)* | Token for `/v1` and operations routes; without it they accept only same-machine requests addressed as localhost |
| `MLX_PROMPT_CACHE_BYTES` | `4294967296` | Memory cap for `mlx_lm.server`'s prompt cache (set by `switch-stack.sh`) |
| `MLX_CACHE_LIMIT` | `2147483648` | MLX buffer-cache cap for the 27B chat server (`switch-stack.sh`) |
| `MLX_PROMPT_CONCURRENCY` / `MLX_DECODE_CONCURRENCY` | `1` / `2` | How many prompts the 27B reads, and replies it generates, at once; extra requests queue (`switch-stack.sh`) |
| `JEV_MLX_CACHE_LIMIT` | `1073741824` | MLX buffer-cache cap for the jev scorer (`scripts/run-jev.sh`) |
| `MLX_EMBED_CACHE_LIMIT` | `536870912` | MLX buffer-cache cap for the embedding server (`python/mlx-embed-server.py`) |
| `WATCHDOG_BUSY_CPU` / `WATCHDOG_BUSY_GPU` | `5` / `30` | Above either (%), a chat server that misses the watchdog's probe is busy, not wedged |
| `MCP_HOST` / `MCP_PORT` | `127.0.0.1` / `3200` | Where `pharmaitchat-mcp` listens (`scripts/run-mcp.sh`); a non-loopback host requires `data/run/mcp-token` |
| `MCP_TOKEN` | *(none)* | Bearer token agents send to `pharmaitchat-mcp`; read from `data/run/mcp-token` by `run-mcp.sh` |

Tokens live in `data/run/` at mode 600 and are passed through the environment only, never as command arguments. There is no `.env` file.

> [!NOTE]
> The product was renamed from PharmaLLM. Where a variable carries the product name, the app and the MCP service read `PHARMAITCHAT_<NAME>` first and fall back to the legacy `PHARMALLM_<NAME>` — `API_TOKEN` and `URL` in both, `RUN_DIR` in `scripts/hermes-setup.sh` — so an unedited `~/.hermes/.env` keeps working. Hermes' own config template still expands `${PHARMALLM_URL}`, `${PHARMALLM_MCP_URL}` and `${PHARMALLM_MCP_TOKEN}`, because Hermes' variable expansion has no fallback of its own. The app-side fallback is temporary.

</details>

---

## Project structure

<details>
<summary><b>Show the tree</b></summary>

<br/>

```
PharmaITChat/
├── src/
│   ├── server.ts                 # Express + HTTPS, auth middleware, index checks, news agent schedule
│   ├── config/
│   │   ├── llm-stacks.ts         # Ollama, MLX, oMLX and Splash stack definitions
│   │   └── env-names.ts          # PHARMAITCHAT_* with a PHARMALLM_* fallback
│   ├── api/                      # auth, chat, knowledge, agent, feedback, dashboard, graph, bench, llm, v1, stack
│   ├── services/
│   │   ├── llm-client.ts         # One OpenAI-compatible client for all four stacks
│   │   ├── model-gateway.ts      # /v1 body building and forwarding
│   │   ├── index-guard.ts        # Refuses search on mismatched indexes
│   │   ├── reindex.ts            # Rebuilds the active stack's indexes
│   │   ├── reindex-jobs.ts       # Background reindex job state
│   │   ├── raw-documents.ts      # Source documents that indexes are rebuilt from
│   │   ├── bench-mode.ts         # Benchmark lease and background job tracking
│   │   ├── health.ts             # Health probes and aggregation
│   │   ├── knowledge-store.ts    # In-memory hybrid index
│   │   ├── chromadb-store.ts     # ChromaDB client
│   │   ├── graph-store.ts        # Neo4j queries and entity writes
│   │   ├── gap-detector.ts       # Confidence check, cooldown, n8n webhook
│   │   ├── news-agent.ts         # Legacy job; its topic scrub now belongs to the watchlist ingest
│   │   ├── watchlist-config.ts   # Loads/validates config/watchlist.yaml (entities, feeds, topics)
│   │   ├── watchlist-store.ts    # SQLite store for items, feed watermarks and runs
│   │   ├── watchlist-sources.ts  # RSS/Atom + Google News adapters, canonicalization, dedupe keys
│   │   ├── watchlist-edgar.ts    # EDGAR filings adapter, IR page adapter (disabled at run level)
│   │   ├── watchlist-tagger.ts   # Local-model tagging against the closed vocabulary
│   │   ├── watchlist-ingest.ts   # Nightly orchestrator: fetch, dedupe, tag, store, embed
│   │   ├── stack-switch.ts       # Pending-switch state machine (confirm tokens, refusal reasons)
│   │   ├── telegram-notify.ts    # Sends the switch buttons and the completion message
│   │   ├── hermes-readiness.ts   # Can Hermes receive the switch buttons? (gateway socket + plugin ready file)
│   │   ├── switch-labels.ts      # Switch-status text ("OMLX stack ready (96 s)"), synced with public/app.js
│   │   └── ...                   # feedback, request log, response cache, web search, file parser
│   └── utils/batches.ts
├── config/watchlist.yaml         # 76 entities (customers, peers, vendors) + 188 entity-less topic queries
├── mcp/                          # pharmaitchat-mcp: 16 MCP tools over Streamable HTTP
│   ├── src/pharmaitchat-client.ts  # REST client for the app
│   ├── src/tools/                # knowledge, graph, gaps, operations, feedback, compact.ts
│   ├── src/http.ts               # auth middleware, /mcp, /healthz
│   └── __tests__/                # against a fake PharmaITChat server
├── hermes/                       # Telegram assistant
│   ├── config.template.yaml      # Model provider, two MCP server scopes, sandbox, toolsets
│   ├── SOUL.md                   # Assistant role and tool policy
│   ├── cron/jobs.json            # The five scheduled jobs
│   ├── scripts/pharmaitchat-watchlist-ingest.sh   # 02:30 --no-agent script-mode job body
│   ├── plugins/pharmaitchat-switch/               # Handles the Telegram Switch / Cancel buttons
│   ├── tests/                    # Python unit tests for the plugin
│   └── com.pharmaitchat.mcp.plist.template        # launchd service for pharmaitchat-mcp
├── scripts/
│   ├── switch-stack.sh           # prepare | ollama | mlx | omlx | ensure-stack | status | token | telegram | mcp-token | mcp | ollama-ctx
│   ├── start-services.sh         # npm run dev: ChromaDB + active stack + dev server
│   ├── run-mcp.sh                # launchd entry point for pharmaitchat-mcp
│   ├── hermes-setup.sh           # check | install-config | install-services | install-plugin | install-cron | all
│   ├── watchlist.ts              # verify-feeds | ingest | status
│   ├── reindex-stack.ts          # Rebuild, --check or --status for the active stack
│   ├── benchmark-stack.ts        # Benchmark the active stack through the app
│   ├── compare-benchmarks.ts     # Comparison report + blind A/B page
│   ├── embedding-parity.ts       # Cross-stack embedding parity
│   └── lib/                      # Shared shell and TypeScript helpers
├── python/
│   ├── mlx-embed-server.py       # OpenAI-compatible embedding server for MLX
│   └── graph_builder.py          # Bulk entity extraction into Neo4j (calls Ollama)
├── ollama/qwen3.8-pharma.Modelfile   # Qwen3.8 27B Q4_K_M with a 64K context
├── bench/questions.json          # 23 benchmark questions
├── knowledge/                    # 40 curated documents + per-stack index files
├── n8n/                          # Importable workflows + setup guide
├── docs/superpowers/             # Specs, plans and verification records
├── public/                       # Chat UI (voice, reasoning panel, stack selector)
├── dashboard/                    # Monitoring dashboard
├── __tests__/                    # Jest suites (+ fake OpenAI-compatible server)
└── data/                         # Raw documents, benchmarks, logs, tokens, SQLite (gitignored)
```

</details>

---

## Testing

**606 Jest tests across 48 suites** — 541 for the app, 65 for the MCP server — plus 27 Python tests for the Telegram switch plugin. All of them run against fakes: not one reaches a real model server, ChromaDB, the live app, Docker, launchd or Telegram, so a fresh checkout runs the whole Jest suite in under 20 seconds with nothing but `npm install`.

```bash
npm run test                 # Jest: 41 suites, 541 tests
npm --prefix mcp test        # Jest: 7 suites, 65 tests
npm run test:hermes-plugin   # Python unittest: 27 tests for the Telegram switch plugin
npm run typecheck            # tsc --noEmit (strict mode)
npm run typecheck:tests      # type-check the test suites
npm --prefix mcp run typecheck
```

---

## Troubleshooting

<details>
<summary><b>App, stacks and indexes</b></summary>

<br/>

| Symptom | Fix |
|---|---|
| Nothing answers after a reboot | The `com.pharmaitchat.stack` launch agent starts ChromaDB, the active stack and the app at login. Check `bash scripts/check-services.sh`; restart it with `launchctl kickstart -k gui/$UID/com.pharmaitchat.stack` |
| `Models for mlx are missing` | Run `scripts/switch-stack.sh prepare` once |
| `Models for splash are missing` | Run `scripts/switch-stack.sh prepare` once — installs Splash from Homebrew and downloads the 17.4 GB model |
| Splash won't start, or fails with an unsupported-hardware error | Splash needs an Apple M3 or newer and **macOS 26.4 or later**, with 36 GB unified memory minimum (48 GB recommended); check `sw_vers` and the Mac model before filing it as a bug |
| Search refused / `search_index` error in `/api/health` | The index belongs to another stack, is incomplete or is rebuilding. Wait for the rebuild, or `POST /api/knowledge/reindex` and poll `/api/knowledge/reindex/status` |
| `Port 8080 is used by another program` | Free the MLX ports (`:8080`, `:8081`); the switch leaves foreign processes alone and rolls back |
| `Port 8000 is used by another program` | Free the Splash port before switching; look for a stray `splash-server` (or `splash serve`) process holding it and stop it, since the switch leaves foreign processes alone and rolls back |
| `/api/graph/rebuild` returns `409` | Graph rebuild only works on the Ollama stack: `scripts/switch-stack.sh ollama` |
| Reindex, `/v1` or `/api/llm/complete` rejected during a benchmark | Wait for it to finish, or `POST /api/bench/stop` |
| Health is `degraded` | A supporting service (ChromaDB, SearXNG or Neo4j) is down; chat still works |
| Hermes does not answer on Telegram | First check you are writing to the right bot (`@…Hermes_bot`, the chat that receives its startup notice and daily reports): Hermes only sees messages sent to its own bot. Then check `check-services.sh` and `~/.hermes/logs/agent.log` for `inbound message` |
| The UI's stack selector is disabled | `check-services.sh`, line `UI stack switch`, gives the reason: the app has no Telegram credentials (restart the `com.pharmaitchat.stack` launch agent), or the Hermes `pharmaitchat-switch` plugin is not ready (restart the gateway) |
| `401 Unauthorized` on `/api/*` or `/v1/*` | Send `Authorization: Bearer <token>`, or reach the app as `localhost` from the same machine |
| Mic button missing or blocked on iPad | Use HTTPS on port 3443 with certificates in `certs/` that the device trusts |
| `npm run dev` fails on port 3000 | The app already runs in the `com.pharmaitchat.stack` launch agent, under `tsx watch` (log in `data/logs/stack.log`); a stack switch hands it back to that job. Without the launch agent, `switch-stack.sh` starts it in the background (log in `data/logs/app.log`) |
| Switch or rebuild failed | Check `data/logs/` (`mlx-chat.log`, `mlx-embed.log`, `omlx.log`, `splash.log`, `reindex-<stack>.log`, `app.log`). `mlx-chat.log` is appended across restarts, with a `=== … starting mlx_lm.server` line per start |
| A stack shows as `(unavailable)` in the selector | `bash scripts/switch-stack.sh availability` says why, using the same checks as a switch: models missing (`prepare`), or Splash unable to build its engine. The switch is refused before any Telegram confirmation is sent |
| `Splash cannot build its engine: Xcode's Metal compiler is missing` | That is a Splash source checkout, which compiles its Metal kernels on first start and needs full Xcode. Install the Homebrew package instead, whose kernels are precompiled: `brew tap incoai/tap && brew install incoai/tap/splash`; `switch-stack.sh` prefers it when present |
| Chat and Hermes hang; `mlx-chat.log` shows `[METAL] … Insufficient Memory` | The 27B ran out of GPU memory and its generation thread died while the server kept listening; the watchdog restarts it. Check memory with `top -o mem`: an uncapped MLX process (the 27B, the jev scorer or the embedder) can grow to ~36 GB. All three are capped by default; see [Memory limits](#memory-limits) |
| Health shows `llm_chat: busy` | Not a fault: the 27B takes one prompt at a time and the probe queued behind a long request while the GPU was working. It counts as healthy, and the watchdog counts no strike |

</details>

<details>
<summary><b>Watchlist</b></summary>

<br/>

| Symptom | Fix |
|---|---|
| The server refuses to boot after editing the watchlist | It no longer can — a bad `config/watchlist.yaml` costs the news agent its topic list and logs the YAML error. Fix the file and check it with `npm run watchlist -- verify-feeds` |
| A nightly Telegram failure message | The run only speaks up when it fails. `npm run watchlist -- status` shows the last recorded run, and the full per-feed output of every night — success or not — is in `data/logs/watchlist-ingest-<date>.log` |
| An entity produces nothing | It may be one of the 14 with no active feed while `ir_page` is disabled. Check its `feeds:` block in `config/watchlist.yaml` |
| `verify-feeds` prints `skip … verified separately` | Expected for `edgar` (a CIK, not a URL) and `ir_page` (an HTML page, not a feed) |
| The run tags far fewer items than were fetched | The 250-item cap. The remainder is counted as deferred and picked up by the next run; raise it with `--limit` for a one-off catch-up |

</details>

<details>
<summary><b>Agents and the sandbox</b></summary>

<br/>

| Symptom | Fix |
|---|---|
| Hermes says the context length is below the minimum | The Ollama model still has the old context. Run `scripts/switch-stack.sh ollama-ctx`, which recreates `qwen3.8-pharma` from the Modelfile without downloading |
| MCP tool calls fail after 5 minutes | Restart `pharmaitchat-mcp` so the version with keepalive notifications runs: `scripts/switch-stack.sh mcp stop && scripts/switch-stack.sh mcp start`. Expect the next Hermes message to take about 3 minutes longer |
| `docker pull` hangs with no output | `~/.docker/config.json` sets `credsStore: desktop` while Docker Desktop is not running, so the pull blocks in the credential helper before it reaches the daemon. Start Docker Desktop, remove `credsStore`, or pull with an empty `DOCKER_CONFIG` against the colima socket. See [`hermes/README.md`](hermes/README.md) |
| Hermes shell tool fails to start | The sandbox image is missing. Pull `nikolaik/python-nodejs:python3.11-nodejs20` once before first use |
| `hermes-setup.sh check` reports the gateway as not loaded | It probes the `gui` launchd domain; the gateway loads in `user`. Confirm with `hermes gateway status` |
| The stack selector in the UI is disabled | Telegram credentials are missing (`scripts/switch-stack.sh telegram`) or the `pharmaitchat-switch` plugin is not loaded by the running gateway (`scripts/hermes-setup.sh install-plugin`) |

</details>

---

<div align="center">

**One machine. 76 entities watched every night. Zero cloud model calls.**

Built by [@sebdallais-git](https://github.com/sebdallais-git).

</div>
