// Stack-aware health checks: only the active stack's endpoints are probed

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { StackConfig } from "../config/llm-stacks.js";

// "not_configured" is for an OPTIONAL dependency that was never installed, as
// opposed to one that is installed and down ("unreachable"). The distinction
// matters because a probe cannot draw it: a port nobody ever listened on and a
// service that just crashed look identical from the outside.
export interface HealthCheck {
  status: "ok" | "error" | "unreachable" | "not_configured";
  latency_ms?: number;
  detail?: string;
}

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

// scripts/check-services.sh must wait longer than this for /api/health
export const GENERATION_PROBE_TIMEOUT_MS = 20000;

// Chat can't work without these; anything else only degrades answers
export const CRITICAL_CHECKS: readonly string[] = ["llm_chat", "llm_embed", "search_index"];

export function stackProbeUrls(stack: StackConfig): { llm_chat: string; llm_embed: string } {
  return {
    llm_chat: `${stack.chatBaseUrl}/v1/models`,
    llm_embed: `${stack.embedBaseUrl}/v1/models`,
  };
}

/**
 * Ask the model for a single token.
 *
 * /v1/models answers from a wedged server: on 2026-09-22 MLX sat at 0% CPU,
 * accepted connections and served /v1/models while a 5-token generation timed
 * out at 90s -- and /api/health reported llm_chat "ok" the whole time. A port
 * being open is liveness; producing a token is readiness, and only the second
 * one means chat works.
 */
export async function probeGeneration(
  stack: Pick<StackConfig, "chatBaseUrl" | "chatModel">,
  timeoutMs: number = GENERATION_PROBE_TIMEOUT_MS,
): Promise<HealthCheck> {
  const start = Date.now();
  try {
    const resp = await fetch(`${stack.chatBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // max_tokens 1 keeps this cheap when healthy; when wedged it costs the
      // timeout, which is the point. The model is required by every stack
      // except mlx_lm.server, which falls back to the one it loaded.
      body: JSON.stringify({
        model: stack.chatModel,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: resp.ok ? "ok" : "error", latency_ms: Date.now() - start };
  } catch (err) {
    // The chat server takes one request at a time, so a long chat turn or an
    // export makes this time out too. It cannot tell the two apart; say so.
    // By name, not instanceof: the DOMException may come from another realm.
    if (typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError") {
      return { status: "unreachable", detail: `no token within ${timeoutMs / 1000}s: busy with another request, or wedged` };
    }
    return { status: "unreachable" };
  }
}

export async function probeUrl(url: string, timeoutMs: number = 3000): Promise<HealthCheck> {
  const start = Date.now();
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { status: resp.ok ? "ok" : "error", latency_ms: Date.now() - start };
  } catch {
    return { status: "unreachable" };
  }
}

export function aggregateHealth(checks: Record<string, HealthCheck>): HealthStatus {
  const entries = Object.entries(checks);
  // Critical first, and strictly "ok": nothing excuses a critical check, least
  // of all a claim that it was never configured.
  const criticalDown = entries.some(([name, check]) => CRITICAL_CHECKS.includes(name) && check.status !== "ok");
  if (criticalDown) return "unhealthy";
  // An optional dependency that was never installed is not a fault, so it does
  // not degrade the app. Anything installed and misbehaving still does.
  const fine = entries.every(([, check]) => check.status === "ok" || check.status === "not_configured");
  return fine ? "healthy" : "degraded";
}

export interface ScorerInstallPaths {
  plist: string;
  binary: string;
}

/**
 * Where the scorer's two artifacts live, read from the same env vars and the
 * same defaults as scripts/hermes-setup.sh: the launch agent it renders, and
 * the open-jev venv it refuses to install without.
 *
 * Only the venv decides whether a scorer exists -- see isScorerConfigured.
 * The plist is derived here because the installer owns it and a future caller
 * may want to distinguish "launchd runs it" from "it exists".
 *
 * Asking about files rather than about a port is what lets /api/health tell
 * "never installed" from "installed and down": the scorer is optional by
 * design, and only the second one is a fault. A port nobody ever listened on
 * and a port that just died look identical from the outside.
 */
export function scorerInstallPaths(env: NodeJS.ProcessEnv = process.env): ScorerInstallPaths {
  const launchAgentsDir = env.LAUNCH_AGENTS_DIR ?? join(homedir(), "Library", "LaunchAgents");
  const jevDir = env.JEV_DIR ?? resolve(process.cwd(), "..", "open-jev");
  return {
    plist: join(launchAgentsDir, "com.pharmaitchat.jev.plist"),
    binary: join(jevDir, ".venv", "bin", "openjev"),
  };
}

/**
 * True when a scorer exists on this machine, whether or not launchd runs it.
 *
 * The VENV is the signal. The plist only records that launchd manages the
 * process, and scripts/run-jev.sh starts the scorer perfectly well without one
 * -- which is what someone actually does first: `make serve` by hand, before
 * committing to a launch agent.
 *
 * R1: this deliberately does NOT require the plist. It used to, and the cost
 * was silent: a hand-run scorer reported "not configured", so /api/health never
 * probed a service that was genuinely running and up, and shadow detection
 * (gap-detector.ts) never switched on -- withholding the very evidence shadow
 * mode exists to collect, in exactly the setup someone tries first.
 */
export function isScorerConfigured(paths: ScorerInstallPaths = scorerInstallPaths()): boolean {
  return existsSync(paths.binary);
}
