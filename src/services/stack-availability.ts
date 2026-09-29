// Which stacks can start on this machine, as scripts/switch-stack.sh sees it.
//
// The script's `availability` command runs the same checks switch_to runs
// before stopping anything (models present; for Splash, an engine it can
// build), one line per stack: "<stack> ok" or "<stack> <why it cannot start>".
// The UI shows unavailable stacks disabled, and /api/stack/switch refuses them
// before asking for a Telegram confirmation of a switch that can only fail.
//
// Unknown never blocks: if the script cannot be run, availability is null and
// every stack stays selectable -- switch_to still checks again itself.

import { execFile } from "node:child_process";
import { join } from "node:path";
import { isStackName } from "../config/llm-stacks.js";
import type { StackName } from "../config/llm-stacks.js";

export type StackAvailability = Partial<Record<StackName, { available: boolean; reason?: string }>>;

export function parseAvailability(text: string): StackAvailability {
  const out: StackAvailability = {};
  for (const line of text.split("\n")) {
    const space = line.indexOf(" ");
    if (space < 1) continue;
    const name = line.slice(0, space);
    if (!isStackName(name)) continue;
    const rest = line.slice(space + 1).trim();
    out[name] = rest === "ok" ? { available: true } : { available: false, reason: rest };
  }
  return out;
}

export interface AvailabilityReaderDeps {
  run(): Promise<string>;
  now(): number;
  // The checks are cheap file lookups, but status is polled every few seconds
  ttlMs: number;
}

export interface AvailabilityReader {
  get(): Promise<StackAvailability | null>;
}

export function createAvailabilityReader(deps: AvailabilityReaderDeps): AvailabilityReader {
  let cached: { at: number; value: StackAvailability } | null = null;
  return {
    async get() {
      if (cached && deps.now() - cached.at < deps.ttlMs) return cached.value;
      try {
        const value = parseAvailability(await deps.run());
        cached = { at: deps.now(), value };
        return value;
      } catch {
        // Not cached: the next call tries again
        return null;
      }
    },
  };
}

export function runAvailabilityScript(): Promise<string> {
  const script = join(process.cwd(), "scripts", "switch-stack.sh");
  return new Promise((resolveRun, reject) => {
    execFile("bash", [script, "availability"], { timeout: 10_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolveRun(stdout);
    });
  });
}
