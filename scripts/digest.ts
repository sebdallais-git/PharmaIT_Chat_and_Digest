// Builds a digest and prints it (markdown) on stdout.
//
//   npx tsx scripts/digest.ts [--request "digest of last week"] [--budget 3900]
//
// Runs the digest agent in this process against the active stack (like the
// nightly ingest), not through the app's HTTP API: Node's fetch gives up on a
// response after 300 s, and a digest on a busy stack can take longer.
// The Monday Hermes job (hermes/scripts/pharmaitchat-weekly-digest.sh) sends
// whatever this prints to Telegram. On failure it prints one line saying why
// and exits 1, so a missing digest is never silent.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { TELEGRAM_DIGEST_BUDGET, runDigest } from "../src/services/digest-agent.js";
import { resolveStackName } from "./watchlist.js";

function option(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

async function main(args: string[]): Promise<number> {
  const request = option(args, "--request", "digest of last week");
  const budget = Number(option(args, "--budget", String(TELEGRAM_DIGEST_BUDGET)));
  // Before the first model call: the client reads LLM_PROVIDER once and would
  // otherwise default to Ollama whatever stack is running
  process.env.LLM_PROVIDER = await resolveStackName(process.env, () =>
    readFile(join(process.cwd(), "data", "run", "active-stack"), "utf-8"),
  );
  const digest = await runDigest(request, budget);
  console.log(digest.markdown);
  console.error(`digest: ${digest.items} items, ${digest.markdown.length} chars, ${digest.period}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.log(`Weekly digest failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
