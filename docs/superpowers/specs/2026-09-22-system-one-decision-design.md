# System One decisions: a local scorer for typed yes/no judgments

**Date:** 2026-09-22
**Status:** approved design, not yet implemented
**Goal:** take the "is this gap resolved?" judgment off the 27B and give it to a
small local scorer that answers a typed yes/no with a probability.

## Why

The gap-resolution loop currently spends two 27B calls per gap. The first
re-answers the question through RAG — that answer is the product, and it has to
stay. The second asks the 27B to judge its own answer and reply in JSON
(`src/services/gap-detector.ts`, `checkConfidence`). Only the second one is a
judgment, and it is the wrong shape of work for a 27B:

- It runs at roughly 3.4 tok/s on a single MLX server that serves one request at
  a time and is shared with live chat, so a judgment competes with the user.
- Its output is parsed out of free text with `response.match(/\{[\s\S]*?\}/)`.
  A model that answers in prose instead of JSON falls through to
  `{ confident: true }` — the failure mode silently marks a gap resolved.
- A yes/no with a probability is exactly what a scorer does in one forward pass.

Replacing it removes a 27B call from a path that contends with chat, and turns a
parsed guess into a typed number.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Scorer | `daseinlabs/open-jev`, Gemma 3 4B via MLX | Native Metal, no container, speaks a System One contract |
| Scope | Judgment only | The 27B still re-answers; only `checkConfidence` is replaced (user, 2026-09-22) |
| Precision | 4-bit, always resident | ~2.5–3 GB beside a 17 GB 27B on 48 GB; no load latency per decision (user, 2026-09-22) |
| Labels | Backfill with the 27B, then shadow | Only 3 gaps carry a verdict today (user, 2026-09-22) |
| Verdicts | `resolved` ≥ 0.85, `review` in between, `unresolved` < 0.5 | `review` is where a 4B is not to be trusted |
| Port | 8010 | 8000 is the Splash stack's default bind; 8080/8081/8100 are the MLX servers, 3200 MCP, 5678/5679 n8n |
| Health | Non-critical dependency | Chat must work with the scorer down |

## Architecture

```
n8n  ──POST /api/decide──▶  PharmaITChat  ──POST /v1/systemone──▶  open-jev :8010
                               (holds both tokens)                  Gemma 3 4B / MLX
```

The app fronts the scorer exactly as it fronts the LLM stack at
`/api/llm/complete`: n8n never learns the scorer's address or its key, and the
route is authenticated like every other non-browser `/api/*` path.

### The contract

`open-jev` answers `POST /v1/systemone` with three question types. A yes/no is a
`noul`:

```json
{ "state": "<question and answer under judgment>",
  "model": "jev-latest",
  "questions": { "resolved": { "type": "noul",
                               "instructions": "...",
                               "criteria": { "true": "...", "false": "..." } } } }
```

```json
{ "answers": { "resolved": { "noul": 0.91 } } }
```

`noul` is the probability of yes. The thresholds apply to it directly — there is
no parsing step, which is the point.

### Verdicts

```
noul >= 0.85            -> resolved    resolveGap(), answer stored
0.5 <= noul < 0.85      -> review      parked; retry_count NOT incremented
noul < 0.5              -> unresolved  markUnresolved(), retry_count++
```

`review` is a fourth `gap_log.status`, added by a guarded `ALTER` in the same
style as the existing `retry_count` / `resolved_at` migrations. It exists
because the middle of a 4B's distribution is the part least worth acting on: a
gap nobody is sure about should wait for a human, not consume a retry.

## Components

| Unit | Responsibility | Depends on |
|---|---|---|
| `scripts/run-jev.sh` | launchd entry point; reads tokens from `data/run/` | — |
| `com.pharmaitchat.jev.plist` | Keeps the scorer up, `RunAtLoad` + `KeepAlive` | run-jev.sh |
| `src/services/decide.ts` | Builds the `noul` question, applies thresholds | injected `fetch` |
| `src/config/decide-config.ts` | Loads and validates `config/decide.yaml` | — |
| `src/api/decide.ts` | `POST /api/decide`; holds `OPENJEV_API_KEY` | decide.ts |
| `src/api/knowledge.ts` | Swaps `checkConfidence()` for `decide()` | decide.ts |
| `src/services/health.ts` | `jev` probe, non-critical | — |
| `scripts/replay-gap-decisions.ts` | The acceptance harness | gap_log.db, /api/decide |

### Token handling

Two secrets, both files under `data/run/`, mode 600, never `.env` and never
passed as arguments:

- `hf-token` — Hugging Face, because Gemma 3 4B is a gated model
- `jev-token` — `OPENJEV_API_KEY`, held by the app and by the scorer

`run-jev.sh` reads them and exports them, following `run-mcp.sh` line for line,
including its refusal to bind a non-loopback host without a token.

### Health

`jev` joins `/api/health` as an ordinary check and is deliberately absent from
`CRITICAL_CHECKS` (`src/services/health.ts`), which stays
`["llm_chat", "llm_embed", "search_index"]`. A scorer that is down reports
`degraded`; chat is untouched. The probe is a `/health` GET, not a scoring call:
liveness is enough here, because unlike the chat server a wedged scorer cannot
silently corrupt an answer — it fails the decision, and the gap stays open.

## Testing

`decide()` takes its `fetch`, base URL and thresholds as injected dependencies,
so every test drives a fake and no test reaches a model server. Three cases earn
their own tests because they are the ones that would hurt:

1. each threshold boundary maps to the right verdict, including both edges
2. a scorer that is unreachable, slow, or returns a malformed body produces an
   explicit failure — never a default verdict. The bug being replaced is exactly
   this: `checkConfidence` fell through to `confident: true` when it could not
   parse, which silently marked gaps resolved.
3. `review` does not increment `retry_count`

## Acceptance: is a 4B good enough?

The honest answer today is that nobody knows, and the data to find out does not
exist yet. `data/gap_log.db` holds 70 rows:

| status | rows |
|---|---|
| triggered | 63 |
| skipped | 4 |
| unresolved | 2 |
| resolved | 1 |

Three labelled examples cannot validate a classifier. So acceptance has two
stages:

**Backfill.** `scripts/replay-gap-decisions.ts` runs the existing 27B
`checkConfidence()` over the 63 `triggered` gaps that carry a `gemma_response`,
recording each verdict as the baseline. This is a one-off, sequential, and slow
— it must run when nobody is using chat.

**Replay.** The same script then sends each gap through `/api/decide` and
reports:

- agreement with the 27B, split by direction (false-resolved is the expensive
  error: it closes a gap that is still open)
- the **distribution of `noul`**, not just the agreement rate
- how many land in `review`

The distribution is the part that matters. If most gaps cluster between 0.5 and
0.85, the thresholds are carrying the decision rather than the model, and the
right conclusion is to stop rather than to tune the numbers. A high agreement
rate produced by a scorer that is uncertain about everything is not a passing
result.

Note what the baseline is: the 27B's opinion, not ground truth. The replay
measures whether a 4B can stand in for the 27B on this task. It does not measure
whether the 27B was right.

## Risks accepted

**A 4B's `noul` is not calibrated.** It is a softmax over log-probs, and
`open-jev`'s own documentation describes its confidence as an approximation of a
formula TypeSafe does not publish. The thresholds are therefore judgment, not
statistics, and the `review` band is the hedge.

**Gemma 3 4B is gated.** It needs a Hugging Face licence acceptance and a token.
Nothing in this design runs without a manual step by the user.

**A second MLX model shares one GPU.** The chat server already returned
`[metal::malloc] Resource limit exceeded` under a single model, and
`scripts/mlx-watchdog.sh` exists because of it. 4-bit keeps the scorer at ~3 GB
against 48 GB total, and a decision is one short forward pass, but the
contention is real and this is the reason the scorer is non-critical: if it
cannot run, the loop degrades rather than stopping.

## Out of scope

- **The KB health check and pre-ingest relevance scoring.** Both are plausible
  next uses of the same service and both are deliberately deferred until the
  replay says whether a 4B is trustworthy on the easier task.
- **Replacing the 27B's re-answer.** The scorer judges; the 27B still writes the
  answer that gets stored. Whether a scorer could decide from retrieved context
  alone is a separate question, worth asking only after this one is answered.
- **Retry or resume of a failed decision.** A gap whose decision failed stays in
  its current state and is picked up by the next run, the same as today.
