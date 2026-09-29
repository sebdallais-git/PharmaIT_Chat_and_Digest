// Stack switching for the browser UI. Requesting a switch needs no token; approval arrives out of
// band, as a tap on a Telegram button. Hermes' gateway receives the tap (it is the shared bot's only
// update consumer) and its pharmaitchat-switch plugin calls /confirm or /cancel here with the API token.
// The spawned script outlives the app it restarts.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Router } from "express";
import type { Request, Response } from "express";
import { getActiveStack, isStackName, STACK_NAMES } from "../config/llm-stacks.js";
import type { StackName } from "../config/llm-stacks.js";
import { getRunningJobs, isBenchmarkActive } from "../services/bench-mode.js";
import { createHermesReadiness, hermesHome, queryGatewayStatus, readPluginReadyFile } from "../services/hermes-readiness.js";
import type { HermesReadinessChecker } from "../services/hermes-readiness.js";
import { createStackSwitch, parseProgress } from "../services/stack-switch.js";
import type { StackSwitch, SwitchProgress } from "../services/stack-switch.js";
import { createAvailabilityReader, runAvailabilityScript } from "../services/stack-availability.js";
import type { StackAvailability } from "../services/stack-availability.js";
import { createTelegramSender, isTelegramConfigured, readTelegramConfig } from "../services/telegram-notify.js";
import type { TelegramSender } from "../services/telegram-notify.js";

const PROGRESS_FILE = join(process.cwd(), "data", "run", "stack-switch.json");

export interface StackRouterDeps {
  switcher: StackSwitch;
  sendTelegram: TelegramSender;
  spawnSwitch(target: StackName): void;
  activeStack(): StackName;
  readProgress(): SwitchProgress | null;
  telegramConfigured(): boolean;
  hermes: HermesReadinessChecker;
  // Which stacks can start (scripts/switch-stack.sh availability); null when unknown
  availability(): Promise<StackAvailability | null>;
}

export function createStackRouter(deps: StackRouterDeps): Router {
  const router = Router();

  router.post("/switch", async (req: Request, res: Response): Promise<void> => {
    const target = (req.body as { stack?: unknown } | undefined)?.stack;
    if (!isStackName(target)) {
      // Derived from STACK_NAMES rather than spelled out, so this message cannot drift from
      // isStackName again the way it did when splash was added but this string was not updated.
      res.status(400).json({ error: `Unknown stack (expected one of: ${STACK_NAMES.join(", ")})` });
      return;
    }
    // Before anything is pending or sent: asking to confirm a switch the script will refuse
    // (Splash without Xcode, a stack whose models were never downloaded) only wastes a tap
    const unavailable = (await deps.availability())?.[target];
    if (unavailable && !unavailable.available) {
      res.status(409).json({ reason: "stack_unavailable", error: unavailable.reason ?? `${target} cannot start` });
      return;
    }
    if (!deps.telegramConfigured()) {
      res.status(409).json({
        reason: "telegram_unconfigured",
        error: "Telegram confirmation is not configured (scripts/switch-stack.sh telegram)",
      });
      return;
    }
    // Refuse before anything is pending or sent: a button nobody can receive would only expire
    const hermes = await deps.hermes.check();
    if (!hermes.ready) {
      res.status(409).json({
        reason: "hermes_unavailable",
        error: `Hermes cannot receive the Telegram confirmation: ${hermes.reason}. Switch with scripts/switch-stack.sh ${target}`,
      });
      return;
    }
    const outcome = deps.switcher.request(target);
    if (!outcome.ok) {
      res.status(409).json({ reason: outcome.reason, error: outcome.message });
      return;
    }
    const { token } = outcome.pending;
    try {
      await deps.sendTelegram(
        `PharmaITChat: switch the LLM stack from ${deps.activeStack()} to ${target}?\n` +
          `Confirm within 5 minutes. If you did not ask for this, tap Cancel or ignore it.`,
        {
          buttons: [
            [
              { text: `✅ Switch to ${target}`, callbackData: `pls:ok:${token}` },
              { text: "✖ Cancel", callbackData: `pls:no:${token}` },
            ],
          ],
        }
      );
    } catch (err) {
      // Drop the pending switch: nobody was asked, so nobody can confirm
      deps.switcher.confirm(outcome.pending.token);
      // Log the detail server-side only: the underlying error can carry the bot token (e.g. in a
      // fetch failure's URL), and this response reaches the browser
      console.error(`stack switch: Telegram send failed: ${err instanceof Error ? err.message : "unknown error"}`);
      res.status(502).json({ error: "Could not send the Telegram confirmation. Check the Telegram bot configuration and try again." });
      return;
    }
    res.status(202).json({
      status: "pending_confirmation",
      id: outcome.pending.id,
      target,
      expires_at: outcome.pending.expiresAt,
    });
  });

  router.post("/confirm", (req: Request, res: Response): void => {
    const pending = deps.switcher.confirm(bodyToken(req));
    if (!pending) {
      res.status(410).json({ error: "This switch request expired or was already answered" });
      return;
    }
    deps.spawnSwitch(pending.target);
    res.json({ status: "switching", target: pending.target });
  });

  router.post("/cancel", (req: Request, res: Response): void => {
    const pending = deps.switcher.cancel(bodyToken(req));
    if (!pending) {
      res.status(410).json({ error: "This switch request expired or was already answered" });
      return;
    }
    res.json({ status: "cancelled", target: pending.target });
  });

  router.get("/status", async (_req: Request, res: Response): Promise<void> => {
    const pending = deps.switcher.pending();
    const hermes = await deps.hermes.cached();
    res.json({
      active: deps.activeStack(),
      stacks: STACK_NAMES,
      telegram_configured: deps.telegramConfigured(),
      hermes_ready: hermes.ready,
      hermes_reason: hermes.reason,
      pending: pending ? { target: pending.target, expires_at: pending.expiresAt } : null,
      cancelled: deps.switcher.lastCancelled(),
      progress: deps.readProgress(),
      availability: await deps.availability(),
    });
  });

  return router;
}

function bodyToken(req: Request): string {
  const token = (req.body as { token?: unknown } | undefined)?.token;
  return typeof token === "string" ? token : "";
}

function readProgressFile(): SwitchProgress | null {
  try {
    return parseProgress(JSON.parse(readFileSync(PROGRESS_FILE, "utf-8")) as unknown);
  } catch {
    return null;
  }
}

// 32 lowercase hex chars: the Hermes plugin only claims taps matching ^pls:(ok|no):[0-9a-f]{32}$, and
// "pls:ok:<token>" must fit Telegram's 64-byte callback_data limit
export function newSwitchToken(): string {
  return randomUUID().replace(/-/g, "");
}

const telegramConfig = readTelegramConfig();

export default createStackRouter({
  switcher: createStackSwitch({
    now: () => Date.now(),
    newId: () => randomUUID(),
    newToken: newSwitchToken,
    activeStack: () => getActiveStack().name,
    isBenchmarkActive: () => isBenchmarkActive(),
    runningJobs: () => getRunningJobs(),
    currentProgress: readProgressFile,
  }),
  sendTelegram: createTelegramSender(telegramConfig),
  spawnSwitch: (target) => {
    // Detached: switch-stack.sh stops this very app, so the child must outlive it
    const child = spawn(join(process.cwd(), "scripts", "switch-stack.sh"), [target], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
    });
    // Without this, a missing script or a lost executable bit throws an unhandled 'error' event
    // after the Telegram message already told the owner it worked
    child.on("error", (err) => console.error(`stack switch spawn failed: ${err.message}`));
    child.unref();
  },
  activeStack: () => getActiveStack().name,
  readProgress: readProgressFile,
  telegramConfigured: () => isTelegramConfigured(telegramConfig),
  hermes: createHermesReadiness({
    queryGatewayStatus: () => queryGatewayStatus(join(hermesHome(), "gateway.sock")),
    readPluginReadyFile: () => readPluginReadyFile(join(hermesHome(), "pharmaitchat-switch.ready.json")),
    now: () => Date.now(),
  }),
  availability: (() => {
    const reader = createAvailabilityReader({ run: runAvailabilityScript, now: () => Date.now(), ttlMs: 30_000 });
    return () => reader.get();
  })(),
});
