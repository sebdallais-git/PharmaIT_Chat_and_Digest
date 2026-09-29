// One sentence describing where a stack switch has got to, shared by the UI and its tests.
// public/app.js keeps a literal second copy (the browser cannot import TypeScript and public/
// is served with no bundler); __tests__/switch-labels.test.ts pins the two copies together.

import type { StackName } from "../config/llm-stacks.js";
import type { SwitchProgress } from "./stack-switch.js";

export interface SwitchStatus {
  active: StackName;
  pending: { target: StackName; expires_at: number } | null;
  progress: SwitchProgress | null;
}

const PHASE_TEXT: Record<string, string> = {
  confirmed: "starting",
  stopping: "stopping the current stack",
  starting: "starting the server",
  warming: "warming up the model",
  indexing: "checking the indexes",
};

export function describeSwitch(status: SwitchStatus): string {
  if (status.pending) return `Confirm the switch to ${status.pending.target.toUpperCase()} in Telegram`;
  const progress = status.progress;
  if (progress && progress.phase === "failed") {
    return `Switch to ${progress.target.toUpperCase()} failed: ${progress.error ?? "unknown error"}`;
  }
  if (progress && progress.phase === "ready" && progress.finishedAt) {
    const seconds = Math.round((progress.finishedAt - progress.startedAt) / 1000);
    return `${progress.target.toUpperCase()} stack ready (${seconds} s)`;
  }
  if (progress && PHASE_TEXT[progress.phase]) {
    return `Switching to ${progress.target.toUpperCase()}: ${PHASE_TEXT[progress.phase]}`;
  }
  return `${status.active.toUpperCase()} stack active`;
}

// Formats the time left to confirm a pending switch as m:ss, floored at 0:00 once it has expired.
export function formatCountdown(msRemaining: number): string {
  const totalSeconds = Math.max(0, Math.floor(msRemaining / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export interface StackSelectState {
  pending: { target: StackName; expires_at: number } | null;
  telegram_configured: boolean;
  hermes_ready: boolean;
}

// F1: the selector must stay disabled for the whole switch, not just while a Telegram
// confirmation is pending. `confirm()` clears `pending` the instant the link is tapped, so a
// client-side gate keyed on `pending` alone went live again while the script was still
// stopping/starting model servers. `busy` — whether this browser considers a switch in flight,
// including one it is merely watching — must be computed by the caller and passed in here.
export function isStackSelectDisabled(status: StackSelectState, busy: boolean): boolean {
  return busy || Boolean(status.pending) || !status.telegram_configured || !status.hermes_ready;
}

export interface StackOptionStatus {
  active: StackName | string;
  availability: Partial<Record<string, { available: boolean; reason?: string }>> | null;
}

// A stack the switch script says cannot start is shown disabled, with the reason as its tooltip.
// The active stack is never disabled, and unknown availability leaves every stack selectable.
export function stackOptionState(name: string, status: StackOptionStatus): { disabled: boolean; title: string | null } {
  const entry = status.availability ? status.availability[name] : undefined;
  if (name === status.active || !entry || entry.available) return { disabled: false, title: null };
  return { disabled: true, title: entry.reason || `${name} cannot start` };
}
