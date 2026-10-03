// Builds a digest and prints it (markdown) on stdout.
//
//   npx tsx scripts/digest.ts [--request "digest of last week"] [--budget 3900] [--briefing] [--email | --email-only]
//
// --email: also email the full digest (no Telegram cut) when
// config/email.local.yaml exists; a failed email is logged on stderr and never
// costs the Telegram message. --email-only: email it and print nothing (a test
// send); exits 1 when it cannot be sent.
//
// --briefing: accounts and action items only, and nothing at all on a day with
// no account news (the weekday Hermes job then stays silent).
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
import { CHAT_DIGEST_BUDGET, TELEGRAM_DIGEST_BUDGET, runDigest } from "../src/services/digest-agent.js";
import type { DigestOptions, DigestResult } from "../src/services/digest-builder.js";
import { EMAIL_CONFIG_FILE, digestEmail, loadEmailSettings, smtpSender, type EmailConfig, type SendMail } from "../src/services/digest-email.js";
import { resolveStackName } from "./watchlist.js";

function option(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

export interface DigestCliDeps {
  runDigest(request: string, budget: number, options: DigestOptions): Promise<DigestResult>;
  // null: email is off (no config file); throws on a bad file or password
  loadEmail(): { config: EmailConfig; password: string } | null;
  sender(config: EmailConfig, password: string): SendMail;
  // stdout is the Telegram message; stderr goes to the job log
  out(text: string): void;
  err(text: string): void;
}

export async function runDigestCli(args: string[], deps: DigestCliDeps): Promise<number> {
  const request = option(args, "--request", "digest of last week");
  const budget = Number(option(args, "--budget", String(TELEGRAM_DIGEST_BUDGET)));
  const emailOnly = args.includes("--email-only");
  const email = emailOnly || args.includes("--email");
  const digest = await deps.runDigest(request, budget, {
    briefing: args.includes("--briefing"),
    // The same prose rendered uncut for the email: no extra model call
    ...(email ? { fullBudget: CHAT_DIGEST_BUDGET } : {}),
  });
  if (!emailOnly && digest.markdown) deps.out(digest.markdown);
  deps.err(`digest: ${digest.items} items, ${digest.markdown.length} chars, ${digest.period}`);

  const full = digest.fullMarkdown ?? digest.markdown;
  // A quiet briefing is quiet on every channel
  if (!email || full === "") return 0;
  try {
    const settings = deps.loadEmail();
    if (settings === null) {
      deps.err(`email: off (no ${EMAIL_CONFIG_FILE})`);
      return emailOnly ? 1 : 0;
    }
    await deps.sender(settings.config, settings.password)(digestEmail(settings.config, full));
    deps.err(`email: sent to ${settings.config.to}`);
    return 0;
  } catch (err) {
    deps.err(`email failed: ${err instanceof Error ? err.message : String(err)}`);
    return emailOnly ? 1 : 0;
  }
}

async function main(args: string[]): Promise<number> {
  // Before the first model call: the client reads LLM_PROVIDER once and would
  // otherwise default to Ollama whatever stack is running
  process.env.LLM_PROVIDER = await resolveStackName(process.env, () =>
    readFile(join(process.cwd(), "data", "run", "active-stack"), "utf-8"),
  );
  return runDigestCli(args, {
    runDigest: (request, budget, options) => runDigest(request, budget, new Date(), options),
    loadEmail: () => loadEmailSettings(process.cwd()),
    sender: smtpSender,
    out: (text) => console.log(text),
    err: (text) => console.error(text),
  });
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
