# System One Decision Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 27B's "is this gap resolved?" judgment with a typed yes/no from a local `open-jev` scorer, reached through a new `POST /api/decide` route.

**Architecture:** A launchd-managed `open-jev` service (Gemma 3 4B, MLX, port 8000) answers `POST /v1/systemone` with a `noul` probability. PharmaITChat fronts it at `POST /api/decide`, holding both tokens, exactly as `/api/llm/complete` fronts the LLM stack. The gap-resolution handler swaps `checkConfidence()` for `decide()`; the 27B still writes the answer.

**Tech Stack:** TypeScript (strict, ESM), Express, better-sqlite3, `yaml`, Jest. The scorer is Python/FastAPI/MLX, run natively, never containerised.

**Spec:** `docs/superpowers/specs/2026-09-22-system-one-decision-design.md`

## Global Constraints

- TypeScript strict; ES modules (import/export), never CommonJS. Relative imports end in `.js`.
- No `any` — use `unknown` with type guards. Prefer interfaces over type aliases (string-literal unions are the legitimate exception).
- Filenames kebab-case; functions camelCase; comments in English.
- **No test may touch a live service** — no `open-jev`, no MLX, no network, no real `gap_log.db`. A subagent's tests twice destroyed live data in this project.
- Both `npm run typecheck` and `npm run typecheck:tests` must be clean. `npm test` transpiles without typechecking, so a type error in a test file will NOT fail the suite.
- Run the full suite and check its real exit code: `npm test > /tmp/out.txt 2>&1; echo $?`. Never judge success by piping into grep or tail.
- After each test run, check `git status`. A test that creates a file or database on disk is a defect even when the suite is green.
- Secrets live in `data/run/` at mode 600, are exported through the environment, and are never written to `.env`, never passed as command arguments, and never logged.
- Do not read or modify `.env`. Do not modify anything under `/legacy`.
- Thresholds are config, never literals in code: `resolved >= 0.85`, `unresolved < 0.5`, `review` in between.
- The scorer is a **non-critical** dependency. `CRITICAL_CHECKS` in `src/services/health.ts` stays `["llm_chat", "llm_embed", "search_index"]`.
- A failed or unreachable scorer must produce an **explicit failure**, never a default verdict.

---

### Task 1: Decision vocabulary and config

**Files:**
- Create: `config/decide.yaml`
- Create: `src/services/decide-config.ts`
- Test: `__tests__/decide-config.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `VERDICTS`, `Verdict`, `isVerdict(value: unknown): value is Verdict`, `DecideConfig`, `parseDecideConfig(raw: unknown): DecideConfig`, `loadDecideConfig(path?: string): DecideConfig`

`DecideConfig` is `{ baseUrl: string; model: string; timeoutMs: number; thresholds: { resolved: number; unresolved: number } }`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "@jest/globals";
import { isVerdict, parseDecideConfig, VERDICTS } from "../src/services/decide-config.js";

const good = {
  base_url: "http://127.0.0.1:8000",
  model: "jev-latest",
  timeout_ms: 15000,
  thresholds: { resolved: 0.85, unresolved: 0.5 },
};

describe("isVerdict", () => {
  it("accepts the three declared verdicts and rejects anything else", () => {
    expect(VERDICTS).toEqual(["resolved", "review", "unresolved"]);
    expect(isVerdict("review")).toBe(true);
    expect(isVerdict("confident")).toBe(false);
    expect(isVerdict(undefined)).toBe(false);
  });
});

describe("parseDecideConfig", () => {
  it("reads a complete document", () => {
    const config = parseDecideConfig(good);

    expect(config.baseUrl).toBe("http://127.0.0.1:8000");
    expect(config.thresholds).toEqual({ resolved: 0.85, unresolved: 0.5 });
  });

  // The band only exists if resolved sits strictly above unresolved. Inverted
  // thresholds would silently delete the review band and turn every decision
  // into resolved-or-unresolved, which is the opposite of the design.
  it("rejects thresholds that do not leave a review band", () => {
    expect(() => parseDecideConfig({ ...good, thresholds: { resolved: 0.5, unresolved: 0.85 } })).toThrow(/threshold/i);
    expect(() => parseDecideConfig({ ...good, thresholds: { resolved: 0.5, unresolved: 0.5 } })).toThrow(/threshold/i);
  });

  it("rejects a threshold outside 0..1", () => {
    expect(() => parseDecideConfig({ ...good, thresholds: { resolved: 1.5, unresolved: 0.5 } })).toThrow(/threshold/i);
    expect(() => parseDecideConfig({ ...good, thresholds: { resolved: 0.85, unresolved: -0.1 } })).toThrow(/threshold/i);
  });

  it("rejects a missing or non-string base url", () => {
    const { base_url: _drop, ...noUrl } = good;
    expect(() => parseDecideConfig(noUrl)).toThrow(/base_url/i);
    expect(() => parseDecideConfig({ ...good, base_url: 8000 })).toThrow(/base_url/i);
  });

  it("rejects a non-object document", () => {
    expect(() => parseDecideConfig(null)).toThrow();
    expect(() => parseDecideConfig("thresholds")).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- decide-config`
Expected: FAIL — "Could not locate module ../src/services/decide-config.js"

- [ ] **Step 3: Write `config/decide.yaml`**

```yaml
# System One decision service. See
# docs/superpowers/specs/2026-09-22-system-one-decision-design.md
#
# thresholds.resolved   : noul at or above this closes the gap
# thresholds.unresolved : noul below this reopens it and spends a retry
# Between the two the gap is parked for review and spends no retry, because
# the middle of a 4B's distribution is the part least worth acting on.
base_url: http://127.0.0.1:8000
model: jev-latest
timeout_ms: 15000
thresholds:
  resolved: 0.85
  unresolved: 0.5
```

- [ ] **Step 4: Write minimal implementation**

```typescript
// System One decision config: the verdict vocabulary and the thresholds that
// map a scorer probability onto it.
//
// Thresholds are config rather than constants because they are judgement, not
// statistics: open-jev's noul is a softmax over log-probs, not a calibrated
// confidence, so the numbers are expected to move once the replay harness
// reports how they actually distribute.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYamlDocument } from "yaml";

export const VERDICTS = ["resolved", "review", "unresolved"] as const;
export type Verdict = (typeof VERDICTS)[number];

export function isVerdict(value: unknown): value is Verdict {
  return typeof value === "string" && (VERDICTS as readonly string[]).includes(value);
}

export interface DecideThresholds {
  resolved: number;
  unresolved: number;
}

export interface DecideConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  thresholds: DecideThresholds;
}

function requireString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`decide config: "${key}" must be a non-empty string`);
  }
  return value;
}

function requireProbability(raw: Record<string, unknown>, key: string): number {
  const value = raw[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`decide config: threshold "${key}" must be a number between 0 and 1`);
  }
  return value;
}

export function parseDecideConfig(raw: unknown): DecideConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("decide config: expected a YAML mapping");
  }
  const doc = raw as Record<string, unknown>;
  const thresholdsRaw = doc.thresholds;
  if (typeof thresholdsRaw !== "object" || thresholdsRaw === null) {
    throw new Error("decide config: thresholds must be a mapping");
  }
  const t = thresholdsRaw as Record<string, unknown>;
  const resolved = requireProbability(t, "resolved");
  const unresolved = requireProbability(t, "unresolved");
  // Strictly greater: equal thresholds collapse the review band to nothing,
  // and inverted ones invert every verdict.
  if (!(resolved > unresolved)) {
    throw new Error(
      `decide config: threshold "resolved" (${resolved}) must be strictly greater than "unresolved" (${unresolved})`,
    );
  }

  const timeout = doc.timeout_ms;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(`decide config: "timeout_ms" must be a positive number`);
  }

  return {
    baseUrl: requireString(doc, "base_url"),
    model: requireString(doc, "model"),
    timeoutMs: timeout,
    thresholds: { resolved, unresolved },
  };
}

export function loadDecideConfig(path: string = resolve(process.cwd(), "config", "decide.yaml")): DecideConfig {
  return parseDecideConfig(parseYamlDocument(readFileSync(path, "utf8")));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- decide-config`
Expected: PASS (6 tests)

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck && npm run typecheck:tests
git add config/decide.yaml src/services/decide-config.ts __tests__/decide-config.test.ts
git commit -m "feat: decision verdict vocabulary and threshold config"
```

---

### Task 2: The decide client

**Files:**
- Create: `src/services/decide.ts`
- Test: `__tests__/decide.test.ts`

**Interfaces:**
- Consumes: `DecideConfig`, `Verdict` from Task 1
- Produces: `DecideDeps`, `Decision`, `DecisionQuestion`, `decide(question: DecisionQuestion, state: string, deps: DecideDeps): Promise<Decision>`, `ScorerUnavailableError`

```ts
interface DecisionQuestion { id: string; instructions: string; whenTrue: string; whenFalse: string }
interface Decision { verdict: Verdict; probability: number }
interface DecideDeps { config: DecideConfig; apiKey: string | null; fetchImpl: typeof fetch }
```

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "@jest/globals";
import { decide, ScorerUnavailableError } from "../src/services/decide.js";
import type { DecideDeps, DecisionQuestion } from "../src/services/decide.js";

const question: DecisionQuestion = {
  id: "resolved",
  instructions: "Did the answer address the question with specific information?",
  whenTrue: "The answer is specific and addresses the question.",
  whenFalse: "The answer hedges, is vague, or says it does not know.",
};

function depsReturning(noul: number, seen?: { body?: unknown; url?: string; auth?: string | null }): DecideDeps {
  return {
    config: {
      baseUrl: "http://127.0.0.1:8000",
      model: "jev-latest",
      timeoutMs: 15000,
      thresholds: { resolved: 0.85, unresolved: 0.5 },
    },
    apiKey: "secret-key",
    fetchImpl: (async (url: string, init?: RequestInit) => {
      if (seen) {
        seen.url = String(url);
        seen.body = JSON.parse(String(init?.body ?? "{}"));
        seen.auth = new Headers(init?.headers).get("authorization");
      }
      return new Response(JSON.stringify({ answers: { resolved: { noul } } }), { status: 200 });
    }) as unknown as typeof fetch,
  };
}

describe("decide", () => {
  it("sends a noul question to /v1/systemone with the scorer key", async () => {
    const seen: { body?: unknown; url?: string; auth?: string | null } = {};

    await decide(question, "Q: x\nA: y", depsReturning(0.9, seen));

    expect(seen.url).toBe("http://127.0.0.1:8000/v1/systemone");
    expect(seen.auth).toBe("Bearer secret-key");
    expect(seen.body).toEqual({
      state: "Q: x\nA: y",
      model: "jev-latest",
      questions: {
        resolved: {
          type: "noul",
          instructions: question.instructions,
          criteria: { true: question.whenTrue, false: question.whenFalse },
        },
      },
    });
  });

  // Both edges are named explicitly: an off-by-one on either boundary silently
  // moves gaps between "closed" and "spend a retry".
  it.each([
    [0.95, "resolved"],
    [0.85, "resolved"],
    [0.8499, "review"],
    [0.6, "review"],
    [0.5, "review"],
    [0.4999, "unresolved"],
    [0.0, "unresolved"],
  ])("maps noul %s to %s", async (noul: number, expected: string) => {
    const decision = await decide(question, "state", depsReturning(noul));

    expect(decision.verdict).toBe(expected);
    expect(decision.probability).toBe(noul);
  });

  // The bug this service replaces: checkConfidence() returned
  // { confident: true } whenever it could not parse the model, so an
  // unparseable judgment silently marked a gap resolved. A scorer that cannot
  // answer must stop the decision, never supply one.
  it("throws rather than returning a verdict when the scorer is unreachable", async () => {
    const deps = depsReturning(0.9);
    deps.fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    await expect(decide(question, "state", deps)).rejects.toBeInstanceOf(ScorerUnavailableError);
  });

  it("throws on a non-ok response", async () => {
    const deps = depsReturning(0.9);
    deps.fetchImpl = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;

    await expect(decide(question, "state", deps)).rejects.toBeInstanceOf(ScorerUnavailableError);
  });

  it.each([
    ["missing answers", {}],
    ["missing the question id", { answers: {} }],
    ["a non-numeric noul", { answers: { resolved: { noul: "yes" } } }],
    ["a noul outside 0..1", { answers: { resolved: { noul: 1.4 } } }],
  ])("throws on %s", async (_label: string, body: unknown) => {
    const deps = depsReturning(0.9);
    deps.fetchImpl = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

    await expect(decide(question, "state", deps)).rejects.toThrow();
  });

  it("omits the Authorization header when no key is configured", async () => {
    const seen: { auth?: string | null } = {};
    const deps = depsReturning(0.9, seen);
    deps.apiKey = null;

    await decide(question, "state", deps);

    expect(seen.auth).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- "__tests__/decide.test.ts"`
Expected: FAIL — "Could not locate module ../src/services/decide.js"

- [ ] **Step 3: Write minimal implementation**

```typescript
// Client for the open-jev System One scorer.
//
// open-jev answers POST /v1/systemone with three question types; a yes/no is a
// "noul", whose answer is the probability of yes. That probability maps onto a
// verdict by threshold, with no parsing step -- which is the point of this
// service. The judgment it replaces (gap-detector.ts checkConfidence) pulled
// JSON out of free text with a regex and defaulted to "confident" when the
// regex missed, silently marking gaps resolved.
//
// R1: every failure throws. There is deliberately no fallback verdict. A
// decision this service cannot make is the caller's problem to report, not
// something to guess at, because both guesses are wrong in an expensive way:
// a false "resolved" closes an open gap, a false "unresolved" burns a retry
// and re-runs the whole ingest.

import type { DecideConfig, Verdict } from "./decide-config.js";

export interface DecisionQuestion {
  id: string;
  instructions: string;
  whenTrue: string;
  whenFalse: string;
}

export interface Decision {
  verdict: Verdict;
  probability: number;
}

export interface DecideDeps {
  config: DecideConfig;
  apiKey: string | null;
  fetchImpl: typeof fetch;
}

export class ScorerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScorerUnavailableError";
  }
}

function readNoul(body: unknown, questionId: string): number {
  if (typeof body !== "object" || body === null) {
    throw new Error("decide: scorer returned a non-object body");
  }
  const answers = (body as Record<string, unknown>).answers;
  if (typeof answers !== "object" || answers === null) {
    throw new Error("decide: scorer response has no answers");
  }
  const answer = (answers as Record<string, unknown>)[questionId];
  if (typeof answer !== "object" || answer === null) {
    throw new Error(`decide: scorer response has no answer for "${questionId}"`);
  }
  const noul = (answer as Record<string, unknown>).noul;
  if (typeof noul !== "number" || !Number.isFinite(noul) || noul < 0 || noul > 1) {
    throw new Error(`decide: scorer returned an invalid noul for "${questionId}": ${JSON.stringify(noul)}`);
  }
  return noul;
}

export function verdictFor(noul: number, thresholds: DecideConfig["thresholds"]): Verdict {
  if (noul >= thresholds.resolved) return "resolved";
  if (noul < thresholds.unresolved) return "unresolved";
  return "review";
}

export async function decide(
  question: DecisionQuestion,
  state: string,
  deps: DecideDeps,
): Promise<Decision> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (deps.apiKey !== null) headers.Authorization = `Bearer ${deps.apiKey}`;

  let resp: Response;
  try {
    resp = await deps.fetchImpl(`${deps.config.baseUrl}/v1/systemone`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        state,
        model: deps.config.model,
        questions: {
          [question.id]: {
            type: "noul",
            instructions: question.instructions,
            criteria: { true: question.whenTrue, false: question.whenFalse },
          },
        },
      }),
      signal: AbortSignal.timeout(deps.config.timeoutMs),
    });
  } catch (err) {
    // The message never carries the key, only the address.
    throw new ScorerUnavailableError(
      `decide: scorer at ${deps.config.baseUrl} is unreachable (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  if (!resp.ok) {
    throw new ScorerUnavailableError(`decide: scorer returned ${resp.status}`);
  }

  const noul = readNoul(await resp.json(), question.id);
  return { verdict: verdictFor(noul, deps.config.thresholds), probability: noul };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- "__tests__/decide.test.ts"`
Expected: PASS (all cases)

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck && npm run typecheck:tests
git add src/services/decide.ts __tests__/decide.test.ts
git commit -m "feat: typed yes/no decisions from the open-jev scorer"
```

---

### Task 3: The /api/decide route

**Files:**
- Create: `src/api/decide.ts`
- Modify: `src/server.ts` (add the router beside the others, around line 62)
- Test: `__tests__/decide-route.test.ts`

**Interfaces:**
- Consumes: `decide`, `DecideDeps`, `ScorerUnavailableError` (Task 2); `loadDecideConfig` (Task 1)
- Produces: `parseDecideRequest(body: unknown): DecideRequest | { error: string }`, `createDecideRouter(deps: DecideRouterDeps): Router`, default export (the wired router)

```ts
interface DecideRequest { question: DecisionQuestion; state: string }
interface DecideRouterDeps { decide: (q: DecisionQuestion, state: string) => Promise<Decision> }
```

- [ ] **Step 1: Write the failing test**

```typescript
import { afterEach, describe, expect, it } from "@jest/globals";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createDecideRouter, parseDecideRequest } from "../src/api/decide.js";
import { ScorerUnavailableError } from "../src/services/decide.js";
import { isProtectedRequest } from "../src/api/auth.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

const good = {
  state: "Q: what is x?\nA: x is y.",
  question: { id: "resolved", instructions: "Did it answer?", whenTrue: "yes", whenFalse: "no" },
};

function startApp(decideImpl: DecideImpl): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use("/api/decide", createDecideRouter({ decide: decideImpl }));
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

type DecideImpl = Parameters<typeof createDecideRouter>[0]["decide"];

describe("parseDecideRequest", () => {
  it("accepts a complete request", () => {
    const parsed = parseDecideRequest(good);

    expect("error" in parsed).toBe(false);
  });

  it.each([
    ["no state", { ...good, state: undefined }],
    ["an empty state", { ...good, state: "   " }],
    ["no question", { state: "x" }],
    ["a question with no id", { ...good, question: { ...good.question, id: "" } }],
    ["a non-object body", null],
  ])("rejects %s", (_label: string, body: unknown) => {
    const parsed = parseDecideRequest(body);

    expect("error" in parsed).toBe(true);
  });
});

describe("POST /api/decide", () => {
  it("returns the verdict and probability", async () => {
    const url = await startApp(async () => ({ verdict: "resolved", probability: 0.92 }));

    const res = await fetch(`${url}/api/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(good),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verdict: "resolved", probability: 0.92 });
  });

  it("returns 400 for an invalid body", async () => {
    const url = await startApp(async () => ({ verdict: "resolved", probability: 1 }));

    const res = await fetch(`${url}/api/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "" }),
    });

    expect(res.status).toBe(400);
  });

  // 503, not 500: the scorer being down is a dependency outage, and the caller
  // (n8n) should treat it as retryable rather than as a bad request.
  it("returns 503 when the scorer is unavailable", async () => {
    const url = await startApp(async () => {
      throw new ScorerUnavailableError("decide: scorer at http://127.0.0.1:8000 is unreachable");
    });

    const res = await fetch(`${url}/api/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(good),
    });

    expect(res.status).toBe(503);
  });

  it("never echoes the scorer key in an error body", async () => {
    const url = await startApp(async () => {
      throw new ScorerUnavailableError("decide: scorer returned 401");
    });

    const res = await fetch(`${url}/api/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(good),
    });

    expect(JSON.stringify(await res.json())).not.toMatch(/bearer|token|key/i);
  });
});

// BROWSER_ROUTES in src/api/auth.ts is an allowlist of UNPROTECTED routes.
// /api/decide must stay out of it: it fronts a scorer whose key the app holds.
// This test fails if someone later "fixes" that list.
describe("auth", () => {
  it("keeps /api/decide behind the API token", () => {
    expect(isProtectedRequest("POST", "/api/decide")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- decide-route`
Expected: FAIL — "Could not locate module ../src/api/decide.js"

- [ ] **Step 3: Write minimal implementation**

```typescript
// Decision endpoint for external workflows (n8n), so they reach the scorer
// through the app instead of calling it directly -- the same arrangement as
// /api/llm/complete. The scorer's address and key stay here; n8n sends only
// the app's API token.
//
// This file does NOT add /api/decide to src/api/auth.ts's BROWSER_ROUTES.
// That list is an allowlist of UNPROTECTED routes; absence from it already
// means protected, which is what a route holding another service's key needs.

import { Router } from "express";
import type { Request, Response } from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decide, ScorerUnavailableError } from "../services/decide.js";
import type { Decision, DecisionQuestion } from "../services/decide.js";
import { loadDecideConfig } from "../services/decide-config.js";

export interface DecideRequest {
  question: DecisionQuestion;
  state: string;
}

export function parseDecideRequest(body: unknown): DecideRequest | { error: string } {
  const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (typeof fields.state !== "string" || fields.state.trim() === "") {
    return { error: "The 'state' field is required" };
  }
  const q = typeof fields.question === "object" && fields.question !== null
    ? (fields.question as Record<string, unknown>)
    : {};
  for (const key of ["id", "instructions", "whenTrue", "whenFalse"]) {
    if (typeof q[key] !== "string" || (q[key] as string).trim() === "") {
      return { error: `question.${key} is required` };
    }
  }
  return {
    state: fields.state,
    question: {
      id: q.id as string,
      instructions: q.instructions as string,
      whenTrue: q.whenTrue as string,
      whenFalse: q.whenFalse as string,
    },
  };
}

export interface DecideRouterDeps {
  decide(question: DecisionQuestion, state: string): Promise<Decision>;
}

export function createDecideRouter(deps: DecideRouterDeps): Router {
  const router = Router();

  router.post("/", async (req: Request, res: Response): Promise<void> => {
    const parsed = parseDecideRequest(req.body);
    if ("error" in parsed) {
      res.status(400).json(parsed);
      return;
    }
    try {
      const decision = await deps.decide(parsed.question, parsed.state);
      res.json(decision);
    } catch (err) {
      // 503 for an outage so n8n retries; the message names the address, never
      // the key (see decide.ts).
      const unavailable = err instanceof ScorerUnavailableError;
      res.status(unavailable ? 503 : 500).json({
        error: err instanceof Error ? err.message : "Decision failed",
      });
    }
  });

  return router;
}

// Reads data/run/jev-token if present. Mode 600, never .env, never an argument.
// Exported because src/api/knowledge.ts (Task 5) reuses it rather than
// re-deriving the token path.
export function readScorerKey(): string | null {
  const path = join(process.env.PHARMALLM_RUN_DIR ?? join(process.cwd(), "data", "run"), "jev-token");
  try {
    const value = readFileSync(path, "utf8").trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

// Lazily built so that importing this module opens no file and reads no
// config: every test imports it for parseDecideRequest or createDecideRouter.
let live: DecideRouterDeps | null = null;
function liveDeps(): DecideRouterDeps {
  return (live ??= {
    decide: (question, state) =>
      decide(question, state, { config: loadDecideConfig(), apiKey: readScorerKey(), fetchImpl: fetch }),
  });
}

export default createDecideRouter({
  decide: (question, state) => liveDeps().decide(question, state),
});
```

- [ ] **Step 4: Register the router**

In `src/server.ts`, beside the other router imports:

```typescript
import decideRouter from "./api/decide.js";
```

and beside the other `app.use` calls (near line 62):

```typescript
app.use("/api/decide", decideRouter);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- decide-route`
Expected: PASS

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck && npm run typecheck:tests
git add src/api/decide.ts src/server.ts __tests__/decide-route.test.ts
git commit -m "feat: POST /api/decide fronting the scorer"
```

---

### Task 4: Health as a non-critical dependency

**Files:**
- Modify: `src/api/dashboard.ts` (the `/health` handler, after the `chromadb` block)
- Test: `__tests__/health.test.ts` (add cases to the existing file)

**Interfaces:**
- Consumes: `probeUrl`, `aggregateHealth`, `CRITICAL_CHECKS` from `src/services/health.ts`
- Produces: a `jev` key in the `/api/health` `checks` object

- [ ] **Step 1: Write the failing test**

Add to `__tests__/health.test.ts`:

```typescript
import { aggregateHealth, CRITICAL_CHECKS } from "../src/services/health.js";

describe("the scorer is a non-critical dependency", () => {
  // Chat must keep working with the scorer down: only the gap-resolution loop
  // depends on it, and that loop degrades to "no decision" rather than to a
  // wrong one.
  it("is not in CRITICAL_CHECKS", () => {
    expect(CRITICAL_CHECKS).toEqual(["llm_chat", "llm_embed", "search_index"]);
    expect(CRITICAL_CHECKS).not.toContain("jev");
  });

  it("degrades rather than fails the app when the scorer is unreachable", () => {
    const status = aggregateHealth({
      llm_chat: { status: "ok" },
      llm_embed: { status: "ok" },
      search_index: { status: "ok" },
      jev: { status: "unreachable" },
    });

    expect(status).toBe("degraded");
  });

  it("still reports unhealthy when a critical check is down, scorer or not", () => {
    expect(
      aggregateHealth({
        llm_chat: { status: "unreachable" },
        llm_embed: { status: "ok" },
        search_index: { status: "ok" },
        jev: { status: "ok" },
      }),
    ).toBe("unhealthy");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- health`
Expected: FAIL only if `CRITICAL_CHECKS` is wrong. The `aggregateHealth` cases pass already — that is correct and expected, because `aggregateHealth` is generic over check names. They are here as regression pins for Step 3, which adds the `jev` key to the live handler. Record in the task report that two of the three assertions were green before the change, and why that is intended.

- [ ] **Step 3: Add the probe to the health handler**

In `src/api/dashboard.ts`, after the `chromadb` block:

```typescript
  // The scorer (open-jev). Deliberately NOT in CRITICAL_CHECKS: only the
  // gap-resolution loop uses it, and that loop degrades to "no decision"
  // rather than to a wrong one.
  //
  // A GET /health is enough here, unlike llm_chat above. A wedged chat server
  // serves /v1/models while generating nothing, so its probe has to ask for a
  // token; a wedged scorer simply fails the decision, and the gap stays open --
  // it cannot quietly produce a bad answer, so liveness is the right question.
  try {
    checks.jev = await probeUrl(`${loadDecideConfig().baseUrl}/health`);
  } catch {
    // A missing or invalid config/decide.yaml must not take down /api/health.
    checks.jev = { status: "error", detail: "decide config unreadable" };
  }
```

and add to the imports at the top of the file:

```typescript
import { loadDecideConfig } from "../services/decide-config.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- health`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck && npm run typecheck:tests
git add src/api/dashboard.ts __tests__/health.test.ts
git commit -m "feat: report the scorer in health as a degraded-only dependency"
```

---

### Task 5: Swap the judgment, and add the review status

**Files:**
- Create: `src/services/gap-outcome.ts`
- Modify: `src/services/gap-detector.ts` (add `markForReview` beside `markUnresolved`, line 247)
- Modify: `src/api/knowledge.ts:344-361` (the `checkConfidence` call and its two branches)
- Test: `__tests__/gap-review.test.ts`

**No schema migration is needed, and you must not add one.** The spec describes
`review` as "a fourth `gap_log.status`, added by a guarded `ALTER`". That is
wrong about the mechanism: `status` is already a free `TEXT NOT NULL DEFAULT
'detected'` column (`src/services/gap-detector.ts:27`), so a new *value* needs
no schema change — only the existing `retry_count` / `resolved_at` *columns*
required one. Writing `'review'` into the existing column is the whole change.

**Interfaces:**
- Consumes: `decide`, `Decision` (Task 2)
- Produces: `markForReview(gapId: number): void`, and `resolveGapByVerdict(verdict, gapId, newResponse, deps)` — the branch logic, extracted so it is testable without an HTTP server

`GapOutcomeDeps` is `{ resolveGap(id: number, response: string): void; markUnresolved(id: number): void; markForReview(id: number): void }`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "@jest/globals";
import { applyGapVerdict } from "../src/services/gap-outcome.js";
import type { GapOutcomeDeps } from "../src/services/gap-outcome.js";

function spyDeps(): GapOutcomeDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resolveGap: (id, response) => calls.push(`resolve:${id}:${response}`),
    markUnresolved: (id) => calls.push(`unresolved:${id}`),
    markForReview: (id) => calls.push(`review:${id}`),
  };
}

describe("applyGapVerdict", () => {
  it("resolves the gap and stores the new answer", () => {
    const deps = spyDeps();

    applyGapVerdict("resolved", 7, "the answer", deps);

    expect(deps.calls).toEqual(["resolve:7:the answer"]);
  });

  it("marks the gap unresolved so the loop spends a retry", () => {
    const deps = spyDeps();

    applyGapVerdict("unresolved", 7, "the answer", deps);

    expect(deps.calls).toEqual(["unresolved:7"]);
  });

  // The whole reason the review band exists: a gap nobody is confident about
  // should wait for a human, not consume a retry and re-run the ingest.
  it("parks a review gap without spending a retry", () => {
    const deps = spyDeps();

    applyGapVerdict("review", 7, "the answer", deps);

    expect(deps.calls).toEqual(["review:7"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- gap-review`
Expected: FAIL — "Could not locate module ../src/services/gap-outcome.js"

- [ ] **Step 3: Write the outcome module**

Create `src/services/gap-outcome.ts`:

```typescript
// What a verdict does to a gap row.
//
// Extracted from the route handler so the branch logic is testable without an
// HTTP server or a database: the three store functions arrive as dependencies.

import type { Verdict } from "./decide-config.js";

export interface GapOutcomeDeps {
  resolveGap(id: number, response: string): void;
  markUnresolved(id: number): void;
  markForReview(id: number): void;
}

export function applyGapVerdict(
  verdict: Verdict,
  gapId: number,
  newResponse: string,
  deps: GapOutcomeDeps,
): void {
  switch (verdict) {
    case "resolved":
      deps.resolveGap(gapId, newResponse);
      return;
    case "unresolved":
      // markUnresolved increments retry_count; the loop tries again.
      deps.markUnresolved(gapId);
      return;
    case "review":
      // Deliberately no retry: the middle of the scorer's distribution is the
      // part least worth acting on, so the gap waits for a human instead of
      // burning an ingest cycle.
      deps.markForReview(gapId);
      return;
    default: {
      const never: never = verdict;
      throw new Error(`unknown verdict ${String(never)}`);
    }
  }
}
```

- [ ] **Step 4: Add `markForReview` to the gap store**

In `src/services/gap-detector.ts`, beside `markUnresolved` (line 247):

```typescript
// Parks a gap the scorer was not confident about. Unlike markUnresolved this
// does NOT touch retry_count: a gap nobody is sure about should not consume an
// ingest cycle.
export function markForReview(gapId: number): void {
  db.prepare("UPDATE gap_log SET status = 'review' WHERE id = ?").run(gapId);
}
```

- [ ] **Step 5: Wire it into the handler**

In `src/api/knowledge.ts`, replace lines 344-361 (the `checkConfidence` call and its `if/else`) with:

```typescript
    // The 27B still writes the answer above; only the judgment moved. decide()
    // throws rather than guessing when the scorer cannot answer, so a scorer
    // outage leaves the gap untouched instead of silently closing it -- the
    // failure mode of the checkConfidence() call this replaces.
    const decision = await decide(
      {
        id: "resolved",
        instructions:
          "Did the assistant answer the question with specific, confident information, rather than hedging, saying it does not know, or giving only vague generic information?",
        whenTrue: "The answer is specific and addresses the question.",
        whenFalse: "The answer hedges, is vague, or does not address the question.",
      },
      `Question: ${original_query}\nAnswer: ${newResponse}`,
      { config: loadDecideConfig(), apiKey: readScorerKey(), fetchImpl: fetch },
    );

    applyGapVerdict(decision.verdict, gap_id, newResponse, { resolveGap, markUnresolved, markForReview });
    console.log(
      `[Gap Resolution] Gap ${gap_id} ${decision.verdict.toUpperCase()} (noul ${decision.probability.toFixed(3)}) for topic: "${search_topic ?? ""}"`,
    );
    res.json({
      resolved: decision.verdict === "resolved",
      verdict: decision.verdict,
      probability: decision.probability,
      new_response: newResponse,
    });
```

`readScorerKey` is already exported from `src/api/decide.ts` (Task 3). Add the imports:

```typescript
import { decide } from "../services/decide.js";
import { loadDecideConfig } from "../services/decide-config.js";
import { applyGapVerdict } from "../services/gap-outcome.js";
import { markForReview } from "../services/gap-detector.js";
import { readScorerKey } from "./decide.js";
```

`resolved` stays in the response body for backward compatibility: the n8n node reads it today, and Task 7 updates that node in the same branch.

- [ ] **Step 6: Run tests**

Run: `npm test -- gap-review` — Expected: PASS (3 tests)
Run: `npm test` — Expected: all suites pass

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck && npm run typecheck:tests
git add src/services/gap-outcome.ts src/services/gap-detector.ts src/api/knowledge.ts src/api/decide.ts __tests__/gap-review.test.ts
git commit -m "feat: decide gap resolution with the scorer, and park review gaps"
```

---

### Task 6: The launchd service

**Files:**
- Create: `scripts/run-jev.sh`
- Create: `hermes/com.pharmaitchat.jev.plist.template`
- Modify: `scripts/hermes-setup.sh` (an `install_jev_service` beside `install_mcp_service`)
- Modify: `scripts/check-services.sh` (add the scorer to the checked list)
- Test: `__tests__/run-jev.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: a service on `127.0.0.1:8000`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(process.cwd(), "scripts", "run-jev.sh");

// RUN_JEV_EXEC replaces the real server with a stub, the same hook
// scripts/run-mcp.sh uses (RUN_MCP_EXEC). No test starts open-jev.
function run(env: Record<string, string>): { stdout: string; status: number } {
  const runDir = mkdtempSync(join(tmpdir(), "run-jev-test-"));
  const stub = join(runDir, "stub.sh");
  writeFileSync(stub, "#!/usr/bin/env bash\nenv | grep -E '^(OPENJEV_API_KEY|HF_TOKEN|JEV_PORT|JEV_HOST)=' | sort\n");
  chmodSync(stub, 0o755);
  for (const [name, value] of Object.entries(env.tokens ? JSON.parse(env.tokens) : {})) {
    const p = join(runDir, name);
    writeFileSync(p, String(value));
    chmodSync(p, 0o600);
  }
  try {
    const stdout = execFileSync("bash", [SCRIPT], {
      env: { ...process.env, PHARMALLM_RUN_DIR: runDir, RUN_JEV_EXEC: stub, ...env },
      encoding: "utf8",
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: `${e.stdout ?? ""}${e.stderr ?? ""}`, status: e.status ?? 1 };
  }
}

describe("run-jev.sh", () => {
  it("exports the scorer key and the HF token from data/run", () => {
    const { stdout, status } = run({ tokens: JSON.stringify({ "jev-token": "k1", "hf-token": "h1" }) });

    expect(status).toBe(0);
    expect(stdout).toContain("OPENJEV_API_KEY=k1");
    expect(stdout).toContain("HF_TOKEN=h1");
  });

  it("defaults to loopback on port 8000", () => {
    const { stdout } = run({ tokens: JSON.stringify({ "jev-token": "k1", "hf-token": "h1" }) });

    expect(stdout).toContain("JEV_HOST=127.0.0.1");
    expect(stdout).toContain("JEV_PORT=8000");
  });

  // Mirrors run-mcp.sh: a service that holds a gated model and answers
  // decisions must not listen beyond loopback without a key.
  it("refuses a non-loopback host with no scorer key", () => {
    const { stdout, status } = run({ JEV_HOST: "0.0.0.0", tokens: JSON.stringify({ "hf-token": "h1" }) });

    expect(status).not.toBe(0);
    expect(stdout).toMatch(/refusing to listen/i);
  });

  it("refuses to start with no Hugging Face token, because the model is gated", () => {
    const { stdout, status } = run({ tokens: JSON.stringify({ "jev-token": "k1" }) });

    expect(status).not.toBe(0);
    expect(stdout).toMatch(/hf-token/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- run-jev`
Expected: FAIL — the script does not exist

- [ ] **Step 3: Write the script**

Create `scripts/run-jev.sh` (then `chmod +x`):

```bash
#!/usr/bin/env bash
# launchd entry point for pharmaitchat-jev: reads the scorer and Hugging Face
# tokens from data/run and starts open-jev. Tokens are passed through the
# environment only, never as arguments.
#
# Follows scripts/run-mcp.sh, including its refusal to listen beyond loopback
# without a token.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RUN_DIR="${PHARMALLM_RUN_DIR:-$PROJECT_DIR/data/run}"
JEV_DIR="${JEV_DIR:-$PROJECT_DIR/../open-jev}"

read_token() {
  if [ -s "$1" ]; then tr -d '[:space:]' <"$1"; fi
}

export JEV_HOST="${JEV_HOST:-127.0.0.1}"
export JEV_PORT="${JEV_PORT:-8000}"
OPENJEV_API_KEY="$(read_token "$RUN_DIR/jev-token")"
HF_TOKEN="$(read_token "$RUN_DIR/hf-token")"
export OPENJEV_API_KEY HF_TOKEN

# Gemma 3 4B is gated on Hugging Face: without a token the server starts and
# then fails to load a model, which looks like a hang. Fail here instead.
if [ -z "$HF_TOKEN" ]; then
  echo "run-jev: $RUN_DIR/hf-token is missing or empty; Gemma 3 4B is a gated model and will not download" >&2
  exit 1
fi

case "$JEV_HOST" in
  127.0.0.1|localhost|::1) ;;
  *)
    if [ -z "$OPENJEV_API_KEY" ]; then
      echo "run-jev: refusing to listen on $JEV_HOST without $RUN_DIR/jev-token" >&2
      exit 1
    fi
    ;;
esac

# Test hook: a stub replaces the real service
if [ -n "${RUN_JEV_EXEC:-}" ]; then
  exec "$RUN_JEV_EXEC"
fi

cd "$JEV_DIR"
exec .venv/bin/openjev serve --host "$JEV_HOST" --port "$JEV_PORT"
```

- [ ] **Step 4: Write the plist template**

Plists are NOT committed to `~/Library/LaunchAgents` directly. This project
renders them from templates in `hermes/` with `sed`, substituting `__NAME__`
placeholders, and bootstraps them from `scripts/hermes-setup.sh`. Follow that
exactly — do not write a plist into `scripts/`.

Create `hermes/com.pharmaitchat.jev.plist.template`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Rendered by scripts/hermes-setup.sh install-services; holds no secrets (run-jev.sh reads the token files) -->
<plist version="1.0">
<dict>
  <key>Label</key><string>com.pharmaitchat.jev</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>__PROJECT_DIR__/scripts/run-jev.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>JEV_DIR</key><string>__JEV_DIR__</string>
    <key>JEV_HOST</key><string>__JEV_HOST__</string>
    <key>PATH</key><string>__PATH__</string>
  </dict>
  <key>WorkingDirectory</key><string>__PROJECT_DIR__</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>__PROJECT_DIR__/data/logs/jev.log</string>
  <key>StandardErrorPath</key><string>__PROJECT_DIR__/data/logs/jev.log</string>
</dict>
</plist>
```

Then add `install_jev_service()` to `scripts/hermes-setup.sh`, modelled line for
line on `install_mcp_service()` at line 158. Keep its five-attempt bootstrap
retry: `launchctl bootstrap` returns "Input/output error" while the old job is
still tearing down, and a single attempt fails intermittently.

```bash
install_jev_service() {
  local plist domain jev_dir
  jev_dir="${JEV_DIR:-$PROJECT_DIR/../open-jev}"
  [ -x "$jev_dir/.venv/bin/openjev" ] || { log "No open-jev venv at $jev_dir (run: cd $jev_dir && make setup)"; exit 1; }
  [ -s "$RUN_DIR/hf-token" ] || { log "No $RUN_DIR/hf-token — Gemma 3 4B is gated and will not download"; exit 1; }
  mkdir -p "$LAUNCH_AGENTS_DIR" "$PROJECT_DIR/data/logs"
  plist="$LAUNCH_AGENTS_DIR/com.pharmaitchat.jev.plist"
  sed -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" \
      -e "s|__JEV_DIR__|$jev_dir|g" \
      -e "s|__JEV_HOST__|${JEV_HOST:-127.0.0.1}|g" \
      -e "s|__PATH__|/usr/bin:/bin:/usr/sbin:/sbin|g" \
      "$TEMPLATE_DIR/com.pharmaitchat.jev.plist.template" >"$plist"
  domain="gui/$(id -u)"
  "$LAUNCHCTL_BIN" bootout "$domain/com.pharmaitchat.jev" >/dev/null 2>&1 || true
  local attempt
  for attempt in 1 2 3 4 5; do
    if "$LAUNCHCTL_BIN" bootstrap "$domain" "$plist"; then break; fi
    if [ "$attempt" -eq 5 ]; then log "launchctl bootstrap failed 5 times for com.pharmaitchat.jev"; exit 1; fi
    sleep 1
  done
  log "Installed and started com.pharmaitchat.jev"
}
```

Call it from the same `install-services` path that calls `install_mcp_service`.

- [ ] **Step 5: Add the scorer to check-services.sh**

The file has exactly two helpers, `check_port` (line 21) and `check_job`
(line 25) — there is no `check_http`, so do not add one. The scorer is a
launchd job listening on a port, so it gets both, matching how the MCP service
is listed:

In the `launchd services (these restart themselves)` block, after
`check_job com.pharmaitchat.n8n`:

```bash
check_job com.pharmaitchat.jev
```

and in the port block, after the MLX lines:

```bash
check_port 8000 "jev scorer" "  -> gap decisions degrade; chat is unaffected"
```

The trailing hint matters: this is the one service in that list whose absence
is not an outage. Someone reading a red line needs to know chat still works.

- [ ] **Step 6: Run tests**

Run: `chmod +x scripts/run-jev.sh && npm test -- run-jev`
Expected: PASS (4 tests)

- [ ] **Step 7: Commit**

```bash
git add scripts/run-jev.sh hermes/com.pharmaitchat.jev.plist.template scripts/hermes-setup.sh scripts/check-services.sh __tests__/run-jev.test.ts
git commit -m "feat: launchd service for the open-jev scorer"
```

---

### Task 7: The n8n workflow

**Files:**
- Modify: `n8n/knowledge_gap_workflow_v2.json` (the `Resolution Result Log` node)
- Modify: `n8n/README.md` (document the three-way verdict)
- Test: `__tests__/gap-workflow.test.ts`

**Interfaces:**
- Consumes: the `{ resolved, verdict, probability }` body from Task 5
- Produces: nothing consumed by later tasks

The `Check Gap Resolution` node keeps its URL — the app already fronts this call, and Task 5 changed what the app does behind it.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface WorkflowNode {
  name: string;
  parameters?: { jsCode?: string; url?: string };
}

const workflow = JSON.parse(
  readFileSync(join(process.cwd(), "n8n", "knowledge_gap_workflow_v2.json"), "utf8"),
) as { nodes: WorkflowNode[] };

function node(name: string): WorkflowNode {
  const found = workflow.nodes.find((n) => n.name === name);
  if (found === undefined) throw new Error(`no node named ${name}`);
  return found;
}

describe("knowledge gap workflow", () => {
  it("still posts the resolution check at the app, not the scorer", () => {
    expect(node("Check Gap Resolution").parameters?.url).toBe(
      "http://localhost:3000/api/knowledge/gaps/check-resolution",
    );
  });

  // The log node used to branch on a boolean. A three-way verdict read as a
  // boolean silently collapses "review" into "still open", which would spend
  // the retry the review band exists to save.
  it("logs the three-way verdict rather than a boolean", () => {
    const code = node("Resolution Result Log").parameters?.jsCode ?? "";

    expect(code).toContain("verdict");
    expect(code).toContain("gap_review");
    expect(code).toContain("probability");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- gap-workflow`
Expected: FAIL — the code does not mention `verdict`

- [ ] **Step 3: Update the node**

Replace the `jsCode` parameter of `Resolution Result Log` with (as a JSON string in the workflow file):

```javascript
// Log the resolution result. The app returns a three-way verdict; "review"
// means the scorer was not confident either way, so the gap is parked for a
// human and does NOT spend a retry.
const resolution = $input.first().json;
const summary = $('Summary & Log').first().json;

const verdict = resolution.verdict || (resolution.resolved ? 'resolved' : 'unresolved');
const statusByVerdict = {
  resolved: 'gap_resolved',
  review: 'gap_review',
  unresolved: 'gap_still_open',
};

const result = {
  status: statusByVerdict[verdict] || 'gap_still_open',
  verdict: verdict,
  probability: resolution.probability ?? null,
  gap_id: summary.gap_id,
  search_topic: summary.search_topic,
  original_query: summary.original_query,
  resolved: verdict === 'resolved',
  ingestion_stats: summary.stats,
  timestamp: new Date().toISOString()
};

console.log('[N8N Resolution] ' + JSON.stringify(result));

return [{ json: result }];
```

- [ ] **Step 4: Document it**

Add to `n8n/README.md`, in the section describing the resolution check:

```markdown
The resolution check returns a three-way verdict from the local scorer
(`resolved` / `review` / `unresolved`) plus the probability behind it. A
`review` gap is parked for a human and does **not** increment `retry_count`:
the middle of the scorer's distribution is the part least worth acting on.
Thresholds live in `config/decide.yaml`.
```

- [ ] **Step 5: Run tests**

Run: `npm test -- gap-workflow`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add n8n/knowledge_gap_workflow_v2.json n8n/README.md __tests__/gap-workflow.test.ts
git commit -m "feat: three-way gap verdict in the n8n workflow"
```

---

### Task 8: The replay harness

**Files:**
- Create: `scripts/replay-gap-decisions.ts`
- Create: `src/services/replay-report.ts`
- Test: `__tests__/replay-report.test.ts`

**Interfaces:**
- Consumes: `Verdict` (Task 1)
- Produces: `buildReplayReport(rows: ReplayRow[]): ReplayReport`

```ts
interface ReplayRow { gapId: number; baseline: "resolved" | "unresolved"; verdict: Verdict; probability: number }
interface ReplayReport {
  total: number;
  agreed: number;
  agreementRate: number;
  falseResolved: number;   // baseline unresolved, scorer resolved -- closes an open gap
  falseUnresolved: number; // baseline resolved, scorer unresolved -- burns a retry
  review: number;
  histogram: Record<string, number>; // 10 buckets of 0.1
}
```

The pure reporting logic lives in `src/services/replay-report.ts` so it is unit-tested; the script is the I/O shell around it.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "@jest/globals";
import { buildReplayReport } from "../src/services/replay-report.js";
import type { ReplayRow } from "../src/services/replay-report.js";

const rows: ReplayRow[] = [
  { gapId: 1, baseline: "resolved", verdict: "resolved", probability: 0.95 },
  { gapId: 2, baseline: "unresolved", verdict: "unresolved", probability: 0.1 },
  { gapId: 3, baseline: "unresolved", verdict: "resolved", probability: 0.9 },
  { gapId: 4, baseline: "resolved", verdict: "unresolved", probability: 0.2 },
  { gapId: 5, baseline: "resolved", verdict: "review", probability: 0.7 },
];

describe("buildReplayReport", () => {
  it("counts agreement only where the scorer committed to a verdict", () => {
    const report = buildReplayReport(rows);

    expect(report.total).toBe(5);
    expect(report.agreed).toBe(2);
    expect(report.review).toBe(1);
  });

  // The two errors are not equal: a false "resolved" closes a gap that is
  // still open, which nothing later reopens. A false "unresolved" only costs
  // another ingest cycle. The report must separate them.
  it("separates the two directions of disagreement", () => {
    const report = buildReplayReport(rows);

    expect(report.falseResolved).toBe(1);
    expect(report.falseUnresolved).toBe(1);
  });

  // The distribution is the point of the exercise: if most gaps land in the
  // review band the thresholds are making the decision, not the model.
  it("buckets the probabilities into tenths", () => {
    const report = buildReplayReport(rows);

    expect(report.histogram["0.9-1.0"]).toBe(2);
    expect(report.histogram["0.7-0.8"]).toBe(1);
    expect(report.histogram["0.1-0.2"]).toBe(1);
    expect(report.histogram["0.2-0.3"]).toBe(1);
  });

  it("reports an empty set without dividing by zero", () => {
    const report = buildReplayReport([]);

    expect(report.total).toBe(0);
    expect(report.agreementRate).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- replay-report`
Expected: FAIL — "Could not locate module ../src/services/replay-report.js"

- [ ] **Step 3: Write the report module**

```typescript
// Reporting for the scorer replay. Pure: the script supplies the rows.
//
// The agreement rate alone is not the result. A scorer that answers "review"
// to everything agrees with nothing and disagrees with nothing, and a scorer
// whose probabilities all cluster in the review band is being decided by the
// thresholds rather than deciding anything. The histogram is what shows that,
// which is why it is part of the report rather than a debugging aid.

import type { Verdict } from "./decide-config.js";

export interface ReplayRow {
  gapId: number;
  baseline: "resolved" | "unresolved";
  verdict: Verdict;
  probability: number;
}

export interface ReplayReport {
  total: number;
  agreed: number;
  agreementRate: number;
  falseResolved: number;
  falseUnresolved: number;
  review: number;
  histogram: Record<string, number>;
}

function bucketOf(p: number): string {
  const lower = Math.min(0.9, Math.floor(p * 10) / 10);
  return `${lower.toFixed(1)}-${(lower + 0.1).toFixed(1)}`;
}

export function buildReplayReport(rows: ReplayRow[]): ReplayReport {
  const histogram: Record<string, number> = {};
  for (let i = 0; i < 10; i += 1) {
    histogram[`${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}`] = 0;
  }

  let agreed = 0;
  let falseResolved = 0;
  let falseUnresolved = 0;
  let review = 0;

  for (const row of rows) {
    histogram[bucketOf(row.probability)] += 1;
    if (row.verdict === "review") {
      review += 1;
      continue;
    }
    if (row.verdict === row.baseline) {
      agreed += 1;
    } else if (row.verdict === "resolved") {
      falseResolved += 1;
    } else {
      falseUnresolved += 1;
    }
  }

  const committed = rows.length - review;
  return {
    total: rows.length,
    agreed,
    agreementRate: committed === 0 ? 0 : agreed / committed,
    falseResolved,
    falseUnresolved,
    review,
    histogram,
  };
}
```

- [ ] **Step 4: Write the script**

Create `scripts/replay-gap-decisions.ts`:

```typescript
#!/usr/bin/env -S node --import tsx
// Acceptance harness for the System One scorer.
//
// Stage 1 (--backfill): runs the existing 27B checkConfidence() over gaps that
// have a gemma_response but no verdict, writing the result to a local baseline
// file. Slow and sequential, and it competes with live chat -- run it when
// nobody is using the app.
//
// Stage 2 (default): replays those gaps through /api/decide and reports
// agreement, the two directions of disagreement, and the probability
// distribution.
//
// The baseline is the 27B's opinion, not ground truth. This measures whether a
// 4B can stand in for the 27B on this task; it does not measure whether the
// 27B was right.
//
// Usage:
//   npx tsx scripts/replay-gap-decisions.ts --backfill [--limit 63]
//   npx tsx scripts/replay-gap-decisions.ts [--limit 63]

import Database from "better-sqlite3";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkConfidence } from "../src/services/gap-detector.js";
import { buildReplayReport } from "../src/services/replay-report.js";
import type { ReplayRow } from "../src/services/replay-report.js";
import type { Verdict } from "../src/services/decide-config.js";

const BASELINE_PATH = join(process.cwd(), "data", "run", "gap-baseline.json");
const DB_PATH = join(process.cwd(), "data", "gap_log.db");

interface GapRow {
  id: number;
  original_query: string;
  gemma_response: string;
  status: string;
}

interface Baseline {
  [gapId: string]: "resolved" | "unresolved";
}

function gapsWithAnswers(limit: number): GapRow[] {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT id, original_query, gemma_response, status
           FROM gap_log
          WHERE gemma_response IS NOT NULL AND gemma_response != ''
          ORDER BY id DESC
          LIMIT ?`,
      )
      .all(limit) as GapRow[];
  } finally {
    db.close();
  }
}

async function backfill(limit: number): Promise<void> {
  const rows = gapsWithAnswers(limit);
  const baseline: Baseline = {};
  console.log(`[backfill] labelling ${rows.length} gaps with the 27B -- this is slow and uses the shared model`);
  for (const [i, row] of rows.entries()) {
    // A gap that already carries a verdict keeps it; the rest are labelled.
    if (row.status === "resolved" || row.status === "unresolved") {
      baseline[String(row.id)] = row.status;
    } else {
      const confidence = await checkConfidence(row.original_query, row.gemma_response);
      baseline[String(row.id)] = confidence.confident ? "resolved" : "unresolved";
    }
    console.log(`[backfill] ${i + 1}/${rows.length} gap ${row.id} -> ${baseline[String(row.id)]}`);
  }
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2));
  console.log(`[backfill] wrote ${BASELINE_PATH}`);
}

async function replay(limit: number): Promise<void> {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
  const token = readFileSync(join(process.cwd(), "data", "run", "api-token"), "utf8").trim();
  const rows: ReplayRow[] = [];

  for (const row of gapsWithAnswers(limit)) {
    const label = baseline[String(row.id)];
    if (label === undefined) continue;

    const resp = await fetch("http://127.0.0.1:3000/api/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        state: `Question: ${row.original_query}\nAnswer: ${row.gemma_response}`,
        question: {
          id: "resolved",
          instructions:
            "Did the assistant answer the question with specific, confident information, rather than hedging, saying it does not know, or giving only vague generic information?",
          whenTrue: "The answer is specific and addresses the question.",
          whenFalse: "The answer hedges, is vague, or does not address the question.",
        },
      }),
    });
    if (!resp.ok) {
      console.error(`gap ${row.id}: /api/decide returned ${resp.status}`);
      continue;
    }
    const decision = (await resp.json()) as { verdict: Verdict; probability: number };
    rows.push({ gapId: row.id, baseline: label, verdict: decision.verdict, probability: decision.probability });
  }

  const report = buildReplayReport(rows);
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nagreement (of ${report.total - report.review} committed): ${(report.agreementRate * 100).toFixed(1)}%`);
  console.log(`false resolved (closes an open gap): ${report.falseResolved}`);
  console.log(`false unresolved (burns a retry):    ${report.falseUnresolved}`);
  console.log(`parked for review:                   ${report.review} of ${report.total}`);
  console.log(`\nIf most rows sit in the 0.5-0.8 buckets, the thresholds are deciding, not the model.`);
}

const args = process.argv.slice(2);
const limitArg = args.indexOf("--limit");
const limit = limitArg === -1 ? 100 : Number(args[limitArg + 1] ?? 100);
await (args.includes("--backfill") ? backfill(limit) : replay(limit));
```

- [ ] **Step 5: Run tests**

Run: `npm test -- replay-report` — Expected: PASS (5 tests)
Run: `npm test` — Expected: all suites pass
Run: `npm run typecheck && npm run typecheck:tests` — Expected: clean

- [ ] **Step 6: Commit**

```bash
git add scripts/replay-gap-decisions.ts src/services/replay-report.ts __tests__/replay-report.test.ts
git commit -m "feat: replay harness comparing scorer verdicts with the 27B baseline"
```

---

## Manual steps the user must perform

These are not tasks — no implementer can do them.

1. **Accept the Gemma 3 4B licence** on Hugging Face and create a token, then:
   `printf '%s' '<token>' > data/run/hf-token && chmod 600 data/run/hf-token`
2. **Create the scorer key:** `openssl rand -hex 32 > data/run/jev-token && chmod 600 data/run/jev-token`
3. **Install open-jev** beside this repo (`../open-jev`): `make setup` downloads the model into a Python 3.12 venv. Set `JEV_DIR` in the plist if it lives elsewhere.
4. **Install the launchd agent:** `scripts/hermes-setup.sh install-services` (renders the template and bootstraps it).
5. **Pick a quiet window for the backfill** — ~63 sequential 27B calls on the shared MLX server.
