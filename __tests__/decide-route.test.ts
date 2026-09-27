import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createDecideRouter, DECIDE_ERROR_MESSAGES, parseDecideRequest } from "../src/api/decide.js";
import { ScorerResponseError, ScorerUnavailableError } from "../src/services/decide.js";
import { isProtectedRequest } from "../src/api/auth.js";

const servers: Server[] = [];

// The route logs the failure detail instead of returning it, so the suite
// captures console.error rather than printing it.
const realConsoleError = console.error;
let errorLog: string[] = [];

beforeEach(() => {
  errorLog = [];
  console.error = (...args: unknown[]): void => {
    errorLog.push(args.map((arg) => String(arg)).join(" "));
  };
});

afterEach(async () => {
  console.error = realConsoleError;
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

  it("returns 500 with its own message when the scorer answers with nonsense", async () => {
    const url = await startApp(async () => {
      throw new ScorerResponseError('decide: scorer returned an invalid noul for "resolved": "yes"');
    });

    const res = await fetch(`${url}/api/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(good),
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: DECIDE_ERROR_MESSAGES.invalidResponse });
  });

  // The old version of this test threw an error whose message contained nothing
  // secret, so it could not fail: it asserted that text nobody put in was not
  // coming out. What has to hold is stronger -- the body is a FIXED string, and
  // the detail it was handed is not in it -- because decide.ts interpolates a
  // scorer-controlled body and undici's own messages into its errors, and
  // neither string is authored here.
  it.each([
    [
      "a scorer-controlled body",
      new ScorerUnavailableError('decide: scorer at http://127.0.0.1:8000 said {"hint":"send Bearer sk-live-9f3a"}'),
      503,
      DECIDE_ERROR_MESSAGES.unavailable,
    ],
    [
      "an undici message",
      new ScorerUnavailableError("decide: scorer at http://10.0.0.4:8000 is unreachable (ECONNREFUSED 10.0.0.4:8000)"),
      503,
      DECIDE_ERROR_MESSAGES.unavailable,
    ],
    [
      "an unexpected internal error",
      new Error("ENOENT: no such file or directory, open '/Users/seb/claude/PharmaLLM/data/run/jev-token'"),
      500,
      DECIDE_ERROR_MESSAGES.internal,
    ],
  ])("answers %s with a fixed message that omits the detail", async (
    _label: string,
    thrown: Error,
    status: number,
    message: string,
  ) => {
    const url = await startApp(async () => {
      throw thrown;
    });

    const res = await fetch(`${url}/api/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(good),
    });
    const body = JSON.stringify(await res.json());

    expect(res.status).toBe(status);
    expect(JSON.parse(body)).toEqual({ error: message });
    // Nothing from the thrown message survives into the response.
    expect(body).not.toContain("sk-live-9f3a");
    expect(body).not.toContain("jev-token");
    expect(body).not.toMatch(/bearer|token|key|ECONNREFUSED|127\.0\.0\.1|10\.0\.0\.4/i);
    for (const word of thrown.message.split(/\s+/).filter((w) => w.length > 6)) {
      expect(body).not.toContain(word);
    }
  });

  // The other half of the ruling: the detail is not discarded, it moves to the
  // server log, where an operator can read it and n8n cannot.
  it("logs the detail server-side instead of returning it", async () => {
    const url = await startApp(async () => {
      throw new ScorerUnavailableError("decide: scorer at http://127.0.0.1:8000 rejected Bearer sk-live-9f3a");
    });

    const res = await fetch(`${url}/api/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(good),
    });

    expect(await res.json()).toEqual({ error: DECIDE_ERROR_MESSAGES.unavailable });
    expect(errorLog.join("\n")).toContain("sk-live-9f3a");
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
