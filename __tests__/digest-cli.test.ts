import { describe, expect, it } from "@jest/globals";
import { runDigestCli, type DigestCliDeps } from "../scripts/digest.js";
import type { DigestResult } from "../src/services/digest-builder.js";
import type { EmailConfig, MailMessage } from "../src/services/digest-email.js";

// scripts/digest.ts as the Hermes jobs run it: stdout is the Telegram message,
// stderr goes to the job log. With --email the full digest is also emailed;
// the email never costs the Telegram message, whatever goes wrong with it.

const CONFIG: EmailConfig = { to: "me@example.test", from: "me@example.test", smtpHost: "smtp.example.test", smtpPort: 587, user: "me@example.test" };
const DIGEST: DigestResult = { markdown: "**Digest · last week**\n- short", fullMarkdown: "**Digest · last week**\n- short\n- and the rest", period: "last week", items: 2 };

function harness(over: Partial<DigestCliDeps> & { result?: DigestResult; sendError?: Error } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const sent: MailMessage[] = [];
  const calls: Array<{ request: string; budget: number; fullBudget?: number; briefing: boolean }> = [];
  const deps: DigestCliDeps = {
    runDigest: async (request, budget, options) => {
      calls.push({ request, budget, fullBudget: options.fullBudget, briefing: options.briefing === true });
      return over.result ?? DIGEST;
    },
    loadEmail: () => ({ config: CONFIG, password: "secret" }),
    sender: () => async (message) => {
      if (over.sendError) throw over.sendError;
      sent.push(message);
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...over,
  };
  return { deps, out, err, sent, calls };
}

describe("runDigestCli", () => {
  it("without --email: prints the Telegram digest and asks for no full render", async () => {
    const h = harness();
    expect(await runDigestCli(["--request", "digest of last week"], h.deps)).toBe(0);
    expect(h.out).toEqual([DIGEST.markdown]);
    expect(h.calls).toEqual([{ request: "digest of last week", budget: 3900, fullBudget: undefined, briefing: false }]);
    expect(h.sent).toEqual([]);
  });

  it("--email: prints the Telegram digest and emails the full one", async () => {
    const h = harness();
    expect(await runDigestCli(["--email"], h.deps)).toBe(0);
    expect(h.out).toEqual([DIGEST.markdown]);
    expect(h.calls[0].fullBudget).toBe(20_000);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ to: "me@example.test", subject: "Digest · last week" });
    expect(h.sent[0].text).toContain("and the rest");
    expect(h.err).toContain("email: sent to me@example.test");
  });

  it("--email when sending fails, or the settings are bad: Telegram still goes out, exit 0", async () => {
    const failing = harness({ sendError: new Error("535 auth failed") });
    expect(await runDigestCli(["--email"], failing.deps)).toBe(0);
    expect(failing.out).toEqual([DIGEST.markdown]);
    expect(failing.err).toContain("email failed: 535 auth failed");

    const bad = harness({
      loadEmail: () => {
        throw new Error("data/run/smtp-password is missing or empty");
      },
    });
    expect(await runDigestCli(["--email"], bad.deps)).toBe(0);
    expect(bad.out).toEqual([DIGEST.markdown]);
    expect(bad.err).toContain("email failed: data/run/smtp-password is missing or empty");
  });

  it("--email with email off: says so in the log and prints as usual", async () => {
    const h = harness({ loadEmail: () => null });
    expect(await runDigestCli(["--email"], h.deps)).toBe(0);
    expect(h.out).toEqual([DIGEST.markdown]);
    expect(h.err).toContain("email: off (no config/email.local.yaml)");
  });

  it("a quiet briefing sends nothing anywhere", async () => {
    const h = harness({ result: { markdown: "", fullMarkdown: "", period: "yesterday", items: 0 } });
    expect(await runDigestCli(["--briefing", "--email"], h.deps)).toBe(0);
    expect(h.out).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it("--email-only: prints nothing for Telegram, and fails when the email cannot go", async () => {
    const h = harness();
    expect(await runDigestCli(["--email-only"], h.deps)).toBe(0);
    expect(h.out).toEqual([]);
    expect(h.sent).toHaveLength(1);

    expect(await runDigestCli(["--email-only"], harness({ loadEmail: () => null }).deps)).toBe(1);
    expect(await runDigestCli(["--email-only"], harness({ sendError: new Error("down") }).deps)).toBe(1);
  });
});
