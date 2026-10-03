# Need evidence from the legacy documents

**Date:** 2026-10-02
**Status:** approved design, not yet planned
**Follows:** `2026-09-21-vendor-intel-graph-design.md` (the unbuilt row "legacy `knowledge/*.md` | LLM, constrained to
one label + one edge | Evidence → SUPPORTS → Need"), `2026-10-02-watchlist-evidence-graph-design.md` (the rebuild is
the only writer of Evidence) and `2026-10-02-vendor-ranking-design.md`.
**Stacked on:** PR #66 (`feature/vendor-ranking`).

## Why

The 36 legacy documents in `knowledge/` (cyber history, vendor cyber write-ups, pharma background, two account papers,
two vendor PDFs) reach the chat only as retrieval background. Each account declares needs (`cyber-resilience`,
`gxp-compliance`, …) with no stated reason. This adds **reviewed, cited reasons why each account has each need**.

Decided with the user:

| Question | Decision |
|---|---|
| Purpose | Justify needs **per account**: 1–3 cited facts per account need |
| Trust | **The user approves each entry**; nothing unapproved reaches the graph |
| Shape | A one-off 27B extraction script → a local proposals file → the rebuild reads approved entries as a fifth source |

Rejected: extraction in the nightly ingest (27B every night, unreviewed entries piling up) and retrieval at answer time
(unreviewed, non-deterministic, stack-dependent). The 27B never writes Neo4j: the rebuild stays the only writer.

## Extraction script

`npx tsx scripts/extract-need-evidence.ts [--only <file>] [--dry-run] [--status]`

- **Inputs:** `knowledge/*.{md,pdf,docx}` except `knowledge/vendors/` (read with `parseFile`,
  `src/services/file-parser.ts`); accounts and their declared needs from `config/accounts.local.yaml`. No accounts
  file: exit with "declare accounts first".
- **Chunks:** ~2,500-word windows split at paragraph boundaries.
- **27B call** per chunk (thinking off, active stack via `getLlmClient().chat`): the prompt lists each account with its
  needs and asks for at most 5 entries `{account, need, claim, quote}`: a one-line claim why *this* account has *this*
  need, and a sentence copied from the chunk. Sector-wide facts may be proposed for several accounts; the user decides
  per account. ~40 calls for today's documents (~30 min). One-off, run by hand.
- **Checks before proposing** (failures dropped and counted in the run report, e.g. "4 dropped: quote not in source"):
  account is one of the user's; need is one the account declares; claim non-empty and ≤ 200 characters; quote non-empty
  and found **verbatim** in the chunk after whitespace normalisation (a guard against invented quotes, not a trust
  signal).
- **Resumable:** the file records each processed document's content hash; unchanged documents are skipped.
- **Failures:** a model error or unparseable JSON for a chunk is logged and the chunk skipped; a stack that fails its
  health check before the first call stops the run.
- **`--dry-run`:** prints proposals, writes nothing. **`--status`:** read-only counts per account and need
  (proposed / approved / rejected) and the next 10 proposed entries with their quotes.

## Proposals file

`config/need-evidence.local.yaml`: gitignored (account intelligence, like `accounts.local.yaml`; `.gitignore` gains the
entry). Written by the script; the user edits only `status` (or deletes entries).

```yaml
# Written by scripts/extract-need-evidence.ts. Change status to approved or
# rejected; only approved entries reach the graph. Re-runs never touch an
# entry that is already here, so your decisions stay.
sources:
  knowledge/cyber-pharma-major-attacks.md: 3f9a1c…
entries:
  - id: ne-7c41d2
    status: proposed            # proposed | approved | rejected
    account: roche
    need: cyber-resilience
    claim: "Ransomware on a pharma peer halted production for weeks"
    quote: "Merck's manufacturing operations were disrupted for several weeks by NotPetya."
    source: knowledge/cyber-pharma-major-attacks.md
    extracted: 2026-10-02
```

- **Stable ids:** `ne-` + a short hash of account, need and quote. A re-run that meets the same quote again keeps the
  existing entry and its status; new quotes are appended as `proposed`.
- **Validation at rebuild** (fails before the wipe, naming the entry): account and need from the closed sets; the need
  declared by that account (an approved entry whose need the account no longer declares is an error listing the ids:
  "roche no longer declares data-sovereignty: reject or re-approve ne-…"); status one of the three; claim and quote
  non-empty; ids unique. A missing file is skipped and reported.

## Graph

- Approved entries only: `(Evidence {kind: "reference", claim, quote, source})-[:SUPPORTS {url, need}]->(Account)`,
  Evidence id = the entry id; `url` (the SUPPORTS identity property) = `<source>#<entry id>`.
- Watchlist Evidence gains `kind: "watchlist"`. The answer's news queries (vendor evidence, account events) match
  `coalesce(e.kind, "watchlist") = "watchlist"`, so a graph built before this change still reads its news, and
  reference entries never appear as news.
- Rebuild report line: `need-evidence.local.yaml -> 12 approved (roche 5, novartis 4, sandoz 3), 31 proposed,
  6 rejected`.

## Answer, chat, MCP

- `AnswerAccount.needEvidence: Record<need, Array<{claim, quote, source}>>`: per declared need, up to 3 approved
  entries in file order; a need without entries is absent, with no note.
- **Budget:** supporting material, trimmable. Two steps after "claim details": "need-evidence quotes" (claims kept),
  then "need evidence"; each adds its "left out" note.
- **Chat:** under the account's `needs:` line, one line per justified need, quotes omitted:
  `  why cyber-resilience: <claim> (<source file name>)`.
- **MCP:** one sentence: "`needEvidence` holds the user's approved reasons why each account has a need, with the quote
  and source document."

## Testing

Unit tests use fakes only (injected `chat()`, in-memory files; no 27B, no Neo4j).

- **Extraction:** chunking at paragraph boundaries; drops for unknown account, undeclared need, long claim, quote not
  in chunk, each counted; appends `proposed` with stable ids; a re-run skips unchanged documents and leaves existing
  entries and statuses untouched; an unparseable reply skips its chunk; `--dry-run` writes nothing; no accounts file
  exits with its message; `--status` output.
- **Proposals file:** every validation rule with its message; missing file skipped.
- **Rebuild:** approved only; `kind` on both evidence kinds; report line; a bad file throws before `clear()`.
- **Answer:** up to 3 per need in file order; reference entries never in `events`/`general`; a graph without `kind`
  still reads news; trim steps in order with notes.
- **Chat:** `why <need>:` lines.

Verification beyond tests:

1. Typechecks, `npm test`, MCP tests and typecheck.
2. **With the user's go-ahead:** extraction `--dry-run --only <one document>` (1–2 real 27B calls, nothing written).
3. **With the user's go-ahead:** full extraction (~40 calls, ~30 min); writes only `config/need-evidence.local.yaml`.
4. After the user approves entries: rebuild dry run (approved count); live rebuild and a Dell @ Roche probe only on a
   yes.

## Out of scope

- Evidence for needs no account declares; reference entries in the ranking (they justify needs, not vendors); any
  nightly extraction.
