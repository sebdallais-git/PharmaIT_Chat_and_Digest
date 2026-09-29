// Ask the KB canaries (config/kb-canaries.yaml) against the running app and
// store the run in data/gap_log.db (kb_canary_runs, shown by
// GET /api/dashboard/kb-health).
//
//   npx tsx scripts/kb-canary.ts [--app-url http://localhost:3000] [--config path] [--no-store]
//
// Prints nothing and exits 0 when every canary passed; otherwise prints a short
// summary and exits 1. The Hermes job (hermes/scripts/pharmaitchat-kb-canary.sh)
// relies on exactly that: its stdout goes to Telegram only on failure.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { readEnvWithFallback } from "../src/config/env-names.js";
import {
  DEFAULT_CANARY_CONFIG,
  createChatAsker,
  formatFailureSummary,
  loadCanaries,
  openCanaryStore,
  runCanaries,
} from "../src/services/kb-canary.js";

function apiToken(): string | null {
  const fromEnv = readEnvWithFallback(process.env, "API_TOKEN");
  if (fromEnv) return fromEnv;
  const tokenFile = join(process.cwd(), "data", "run", "api-token");
  return existsSync(tokenFile) ? readFileSync(tokenFile, "utf-8").trim() || null : null;
}

function option(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

async function main(args: string[]): Promise<number> {
  const appUrl = option(args, "--app-url", "http://localhost:3000");
  const canaries = loadCanaries(option(args, "--config", DEFAULT_CANARY_CONFIG));
  const run = await runCanaries(canaries, createChatAsker(appUrl, apiToken()));

  if (!args.includes("--no-store")) {
    const store = openCanaryStore(new Database(join(process.cwd(), "data", "gap_log.db")));
    try {
      store.record(run);
    } finally {
      store.close();
    }
  }

  // Details for the dated log the Hermes wrapper keeps; stderr so stdout stays silent on success
  for (const r of run.results) {
    const status = r.ok ? "ok  " : "FAIL";
    const detail = r.error ?? (r.missing.length > 0 ? `missing ${r.missing.join(", ")}` : "");
    console.error(`${status} ${r.id} ${Math.round(r.ms / 1000)}s chunks=${r.chunkCount}${r.retried ? " (retried)" : ""} ${detail}`.trimEnd());
  }

  const summary = formatFailureSummary(run);
  if (summary) console.log(summary);
  return summary ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.log(`KB canary could not run: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
