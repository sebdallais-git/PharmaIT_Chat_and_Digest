import { afterEach, describe, expect, it } from "@jest/globals";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createStackRouter, newSwitchToken } from "../src/api/stack.js";
import { createStackSwitch } from "../src/services/stack-switch.js";
import type { StackName } from "../src/config/llm-stacks.js";
import type { SwitchProgress } from "../src/services/stack-switch.js";
import type { TelegramSendOptions } from "../src/services/telegram-notify.js";
import type { StackAvailability } from "../src/services/stack-availability.js";

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((r) => server.close(() => r()));
});

interface SentMessage {
  text: string;
  options?: TelegramSendOptions;
}

interface Fixture {
  url: string;
  messages: SentMessage[];
  spawned: StackName[];
  state: {
    active: StackName;
    benchmark: boolean;
    jobs: string[];
    progress: SwitchProgress | null;
    configured: boolean;
    sendFails: boolean;
    sendFailMessage: string;
    hermesReady: boolean;
    availability: StackAvailability | null;
  };
}

async function startApp(): Promise<Fixture> {
  const state = {
    active: "ollama" as StackName,
    benchmark: false,
    jobs: [] as string[],
    progress: null as SwitchProgress | null,
    configured: true,
    sendFails: false,
    sendFailMessage: "telegram sendMessage failed (401)",
    hermesReady: true,
    availability: null as StackAvailability | null,
  };
  const messages: SentMessage[] = [];
  const spawned: StackName[] = [];
  let counter = 0;
  const switcher = createStackSwitch({
    now: () => Date.now(),
    newId: () => `id-${++counter}`,
    newToken: () => `tok-${counter}`,
    activeStack: () => state.active,
    isBenchmarkActive: () => state.benchmark,
    runningJobs: () => state.jobs,
    // Same underlying state readProgress() below reads, matching the production wiring in
    // src/api/stack.ts (both the route and the state machine read the one progress file).
    currentProgress: () => state.progress,
  });
  const readiness = async () =>
    state.hermesReady ? { ready: true, reason: "" } : { ready: false, reason: "the Hermes gateway is not running" };
  const app = express();
  app.use(express.json());
  app.use(
    "/api/stack",
    createStackRouter({
      switcher,
      sendTelegram: async (text: string, options?: TelegramSendOptions) => {
        if (state.sendFails) throw new Error(state.sendFailMessage);
        messages.push({ text, options });
      },
      spawnSwitch: (target: StackName) => {
        spawned.push(target);
      },
      activeStack: () => state.active,
      readProgress: () => state.progress,
      telegramConfigured: () => state.configured,
      hermes: { check: readiness, cached: readiness },
      availability: async () => state.availability,
    })
  );
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, messages, spawned, state };
}

// The token rides in the buttons' callback data, never in the text
function tokenFrom(message: SentMessage): string {
  const data = message.options?.buttons?.[0]?.[0]?.callbackData ?? "";
  return data.replace(/^pls:ok:/, "");
}

async function answer(url: string, action: "confirm" | "cancel", body: unknown) {
  const res = await fetch(`${url}/api/stack/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function post(url: string, stack: string) {
  const res = await fetch(`${url}/api/stack/switch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stack }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function postRaw(url: string, body: unknown) {
  const res = await fetch(`${url}/api/stack/switch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("POST /api/stack/switch", () => {
  it("accepts a switch and sends one message with Switch and Cancel buttons, no link, and starts nothing yet", async () => {
    const fixture = await startApp();

    const { status, body } = await post(fixture.url, "omlx");

    expect(status).toBe(202);
    expect(body.status).toBe("pending_confirmation");
    expect(body.id).toBe("id-1");
    expect(typeof body.expires_at).toBe("number");
    expect(fixture.messages).toHaveLength(1);
    const [message] = fixture.messages;
    expect(message.text).toContain("from ollama to omlx");
    expect(message.text).not.toMatch(/https?:\/\//);
    expect(message.options?.buttons).toEqual([
      [
        { text: "✅ Switch to omlx", callbackData: "pls:ok:tok-1" },
        { text: "✖ Cancel", callbackData: "pls:no:tok-1" },
      ],
    ]);
    expect(fixture.spawned).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/tok-/);
  });

  it("refuses up front when Hermes cannot receive the tap, and sends nothing", async () => {
    const fixture = await startApp();
    fixture.state.hermesReady = false;

    const { status, body } = await post(fixture.url, "omlx");

    expect(status).toBe(409);
    expect(body.reason).toBe("hermes_unavailable");
    expect(String(body.error)).toContain("the Hermes gateway is not running");
    expect(String(body.error)).toContain("scripts/switch-stack.sh omlx");
    expect(fixture.messages).toEqual([]);

    // Nothing was left pending
    fixture.state.hermesReady = true;
    expect((await post(fixture.url, "omlx")).status).toBe(202);
  });

  it("refuses an unknown stack name", async () => {
    const fixture = await startApp();

    const { status, body } = await post(fixture.url, "vllm");

    expect(status).toBe(400);
    // Derived from STACK_NAMES: this must name every known stack, including splash -- the old
    // hardcoded "ollama, mlx or omlx" string silently fell out of sync when splash was added.
    expect(String(body.error)).toMatch(/ollama, mlx, omlx, splash/);
    expect(fixture.messages).toEqual([]);
  });

  it("refuses a non-string stack value and spawns nothing", async () => {
    const fixture = await startApp();

    const arrayBody = await postRaw(fixture.url, { stack: ["omlx"] });
    const missingBody = await postRaw(fixture.url, {});

    expect(arrayBody.status).toBe(400);
    expect(missingBody.status).toBe(400);
    expect(fixture.messages).toEqual([]);
    expect(fixture.spawned).toEqual([]);
  });

  it("passes the state machine's refusal through as 409", async () => {
    const fixture = await startApp();
    fixture.state.jobs = ["reindex"];

    const { status, body } = await post(fixture.url, "omlx");

    expect(status).toBe(409);
    expect(body.reason).toBe("reindex");
    expect(fixture.messages).toEqual([]);
  });

  it("refuses a switch to the already-active stack", async () => {
    const fixture = await startApp();
    fixture.state.active = "omlx";

    const { status, body } = await post(fixture.url, "omlx");

    expect(status).toBe(409);
    expect(body.reason).toBe("already_active");
    expect(fixture.messages).toEqual([]);
  });

  it("refuses a switch while a benchmark is running", async () => {
    const fixture = await startApp();
    fixture.state.benchmark = true;

    const { status, body } = await post(fixture.url, "omlx");

    expect(status).toBe(409);
    expect(body.reason).toBe("benchmark");
    expect(fixture.messages).toEqual([]);
  });

  // F1: the same 409 shape as the other three refusal reasons, for a switch that is actively
  // running (a non-terminal phase, e.g. because a second browser or a page reload posted again
  // after the Telegram link was tapped but before the switch finished).
  it("refuses a switch while a previous switch is actively running, with the same 409 shape as the other reasons", async () => {
    const fixture = await startApp();
    fixture.state.progress = { phase: "warming", target: "mlx", previous: "ollama", startedAt: Date.now() };

    const { status, body } = await post(fixture.url, "omlx");

    expect(status).toBe(409);
    expect(body.reason).toBe("switching");
    expect(typeof body.error).toBe("string");
    expect(fixture.messages).toEqual([]);
    expect(fixture.spawned).toEqual([]);
  });

  it("never leaks the bot token in a failed-send response", async () => {
    const fixture = await startApp();
    const fakeToken = "bot123456789:ABCdefGHIjkLMNOpqrSTUvwxYZ01234567890";
    fixture.state.sendFails = true;
    // Simulate an underlying error message that happens to carry a token-shaped string
    // (e.g. embedded in a leaked request URL) to prove the route never echoes it back.
    fixture.state.sendFailMessage = `telegram sendMessage failed: fetch https://api.telegram.org/${fakeToken}/sendMessage`;

    const refused = await postRaw(fixture.url, { stack: "omlx" });

    expect(refused.status).toBe(502);
    const raw = JSON.stringify(refused.body);
    expect(raw).not.toContain(fakeToken);
    expect(raw).not.toMatch(/https:\/\/api\.telegram\.org/);
  });

  it("refuses when Telegram is not configured", async () => {
    const fixture = await startApp();
    fixture.state.configured = false;

    const { status, body } = await post(fixture.url, "omlx");

    expect(status).toBe(409);
    expect(body.reason).toBe("telegram_unconfigured");
    expect(fixture.spawned).toEqual([]);
  });

  it("leaves no pending switch when the message cannot be sent", async () => {
    const fixture = await startApp();
    fixture.state.sendFails = true;

    const refused = await post(fixture.url, "omlx");

    expect(refused.status).toBe(502);
    expect(String(refused.body.error)).toMatch(/Could not send the Telegram confirmation/);
    expect(fixture.spawned).toEqual([]);

    // Nobody was asked, so nobody can confirm: the next request must be accepted
    fixture.state.sendFails = false;
    expect((await post(fixture.url, "omlx")).status).toBe(202);
  });
});

describe("POST /api/stack/confirm", () => {
  it("spawns the switch once for a good token", async () => {
    const fixture = await startApp();
    await post(fixture.url, "omlx");
    const token = tokenFrom(fixture.messages[0]);

    const first = await answer(fixture.url, "confirm", { token });
    const second = await answer(fixture.url, "confirm", { token });

    expect(first).toEqual({ status: 200, body: { status: "switching", target: "omlx" } });
    expect(second.status).toBe(410);
    expect(fixture.spawned).toEqual(["omlx"]);
  });

  it("refuses an unknown, missing or non-string token without spawning", async () => {
    const fixture = await startApp();
    await post(fixture.url, "omlx");

    expect((await answer(fixture.url, "confirm", { token: "nope" })).status).toBe(410);
    expect((await answer(fixture.url, "confirm", {})).status).toBe(410);
    expect((await answer(fixture.url, "confirm", { token: ["tok-1"] })).status).toBe(410);
    expect(fixture.spawned).toEqual([]);
  });
});

describe("POST /api/stack/cancel", () => {
  it("drops the pending switch, starts nothing, and reports which request was cancelled", async () => {
    const fixture = await startApp();
    const requested = await post(fixture.url, "omlx");
    const token = tokenFrom(fixture.messages[0]);

    const cancelled = await answer(fixture.url, "cancel", { token });
    const status = (await (await fetch(`${fixture.url}/api/stack/status`)).json()) as Record<string, unknown>;

    expect(cancelled).toEqual({ status: 200, body: { status: "cancelled", target: "omlx" } });
    expect(status.pending).toBeNull();
    expect(status.cancelled).toEqual({ id: requested.body.id, target: "omlx" });
    expect((await answer(fixture.url, "confirm", { token })).status).toBe(410);
    expect(fixture.spawned).toEqual([]);
  });

  it("answers 410 for a token that is not pending", async () => {
    const fixture = await startApp();
    expect((await answer(fixture.url, "cancel", { token: "nope" })).status).toBe(410);
  });
});

describe("GET /api/stack/status", () => {
  it("reports the active stack, the pending target and the progress, never the token", async () => {
    const fixture = await startApp();
    await post(fixture.url, "omlx");
    fixture.state.progress = { phase: "warming", target: "omlx", previous: "ollama", startedAt: 10 };

    const res = await fetch(`${fixture.url}/api/stack/status`);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.active).toBe("ollama");
    expect(body.stacks).toEqual(["ollama", "mlx", "omlx", "splash"]);
    expect((body.pending as Record<string, unknown>).target).toBe("omlx");
    expect((body.progress as Record<string, unknown>).phase).toBe("warming");
    expect(JSON.stringify(body)).not.toMatch(/tok-/);
    expect(body.hermes_ready).toBe(true);
    expect(body.cancelled).toBeNull();
  });

  it("reports why Hermes is not ready", async () => {
    const fixture = await startApp();
    fixture.state.hermesReady = false;

    const body = (await (await fetch(`${fixture.url}/api/stack/status`)).json()) as Record<string, unknown>;

    expect(body.hermes_ready).toBe(false);
    expect(body.hermes_reason).toBe("the Hermes gateway is not running");
  });
});

describe("newSwitchToken", () => {
  // The Hermes plugin only claims taps matching ^pls:(ok|no):[0-9a-f]{32}$, and Telegram caps
  // callback_data at 64 bytes: a token outside either contract makes the buttons dead.
  it("makes tokens the plugin's pattern accepts and that fit Telegram's callback data", () => {
    const tokens = Array.from({ length: 50 }, () => newSwitchToken());
    for (const token of tokens) {
      expect(token).toMatch(/^[0-9a-f]{32}$/);
      expect(Buffer.byteLength(`pls:ok:${token}`, "utf8")).toBeLessThanOrEqual(64);
    }
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});

// On 2026-09-29 the UI offered Splash, which cannot build without Xcode: the
// user was asked to confirm on Telegram, then the switch refused. A stack the
// switch script already knows cannot start is refused here, before anything.
describe("stack availability", () => {
  const splashMissing: StackAvailability = {
    ollama: { available: true },
    mlx: { available: true },
    splash: { available: false, reason: "Splash cannot build its engine: Xcode is missing" },
  };

  it("reports it in the status", async () => {
    const f = await startApp();
    f.state.availability = splashMissing;
    const status = (await (await fetch(`${f.url}/api/stack/status`)).json()) as Record<string, unknown>;
    expect(status.availability).toEqual(splashMissing);
  });

  it("refuses a switch to an unavailable stack with the reason, sending nothing to Telegram", async () => {
    const f = await startApp();
    f.state.availability = splashMissing;
    const res = await post(f.url, "splash");
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ reason: "stack_unavailable", error: "Splash cannot build its engine: Xcode is missing" });
    expect(f.messages).toEqual([]);
  });

  it("still asks for confirmation for an available stack, or when availability is unknown", async () => {
    const f = await startApp();
    f.state.availability = splashMissing;
    expect((await post(f.url, "mlx")).status).toBe(202);
    const g = await startApp();
    g.state.availability = null;
    expect((await post(g.url, "splash")).status).toBe(202);
  });
});
