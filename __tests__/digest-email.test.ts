import { afterEach, describe, expect, it } from "@jest/globals";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  digestEmail,
  digestSubject,
  loadEmailSettings,
  markdownToHtml,
  markdownToText,
  parseEmailConfig,
  type EmailConfig,
} from "../src/services/digest-email.js";

// The digest by email, next to Telegram: the full digest (no 3,900-character
// cut), as HTML with clickable item links and a plain-text fallback. Sending
// is injected everywhere here: no test opens an SMTP connection.

const CONFIG: EmailConfig = { to: "me@example.test", from: "me@example.test", smtpHost: "smtp.example.test", smtpPort: 587, user: "me@example.test" };

const DIGEST = `**Digest · the last 7 days**
_No role set: tell me who you are ("I am the Dell GAM for Roche") for targeted action items._

- Roche & Novartis <both> scale AI [[1]](https://news.test/a?x=1&y=2)

**Your accounts · EMEA**
- **Roche**: GPU purchase [[1]](https://news.test/a?x=1&y=2)[[2]](https://news.test/b)

**Cyber**
- [Ransomware at a CDMO](https://news.test/c) · Source, 1 Oct

_38 items in the period_`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "digest-email-"));
  dirs.push(dir);
  return dir;
}

describe("markdownToHtml", () => {
  const html = markdownToHtml(DIGEST);

  it("turns the title into a heading, section titles into subheadings and bullets into lists", () => {
    expect(html).toContain("<h1>Digest · the last 7 days</h1>");
    expect(html).toContain("<h2>Your accounts · EMEA</h2>");
    expect(html).toContain("<h2>Cyber</h2>");
    expect(html).toMatch(/<ul>\s*<li>Roche &amp; Novartis &lt;both&gt; scale AI/);
    expect(html).toContain("<li><strong>Roche</strong>: GPU purchase");
    expect(html).toContain("<p><em>38 items in the period</em></p>");
  });

  it("makes item references and titles clickable, escaping text and URLs", () => {
    expect(html).toContain('<a href="https://news.test/a?x=1&amp;y=2">[1]</a>');
    expect(html).toContain('<a href="https://news.test/c">Ransomware at a CDMO</a>');
    expect(html).not.toContain("<both>");
  });

  it("never links anything but http(s)", () => {
    expect(markdownToHtml("- bad [[1]](javascript:alert(1))")).not.toContain("href");
  });
});

describe("markdownToText", () => {
  it("reads as plain text, links spelled out", () => {
    const text = markdownToText(DIGEST);
    expect(text.split("\n")[0]).toBe("Digest · the last 7 days");
    expect(text).toContain("- Roche: GPU purchase [1] https://news.test/a?x=1&y=2 [2] https://news.test/b");
    expect(text).toContain("- Ransomware at a CDMO (https://news.test/c) · Source, 1 Oct");
    expect(text).not.toContain("**");
  });
});

describe("digestSubject and digestEmail", () => {
  it("takes the subject from the digest's title line", () => {
    expect(digestSubject(DIGEST)).toBe("Digest · the last 7 days");
    expect(digestSubject("**Briefing · yesterday** for GAM at Dell\n- x")).toBe("Briefing · yesterday");
  });

  it("builds one message with the HTML and the plain-text parts", () => {
    const message = digestEmail(CONFIG, DIGEST);
    expect(message).toMatchObject({ from: "me@example.test", to: "me@example.test", subject: "Digest · the last 7 days" });
    expect(message.html).toContain("<h1>");
    expect(message.text).toContain("Digest · the last 7 days");
  });
});

describe("parseEmailConfig", () => {
  it("reads the recipient, sender and SMTP server; the port defaults to 587", () => {
    expect(parseEmailConfig("to: me@example.test\nsmtp_host: smtp.example.test\nuser: me@example.test\n")).toEqual(CONFIG);
  });

  // The file users copy: it has to parse, or the first send fails on the example
  it("parses config/email.example.yaml", () => {
    expect(parseEmailConfig(readFileSync(join(process.cwd(), "config", "email.example.yaml"), "utf-8"))).toMatchObject({
      to: "you@example.com",
      smtpHost: "smtp.gmail.com",
      smtpPort: 587,
    });
  });

  it("refuses a missing or malformed field", () => {
    expect(() => parseEmailConfig("smtp_host: smtp.example.test\nuser: me@example.test\n")).toThrow("config/email.local.yaml: to must be an email address");
    expect(() => parseEmailConfig("to: me@example.test\nuser: me@example.test\n")).toThrow("smtp_host is required");
    expect(() => parseEmailConfig("to: me@example.test\nsmtp_host: h\nuser: u@example.test\nsmtp_port: lots\n")).toThrow("smtp_port must be a port number");
  });
});

describe("loadEmailSettings", () => {
  function write(root: string, config: string | null, password: string | null, mode = 0o600): void {
    if (config !== null) {
      mkdirSync(join(root, "config"), { recursive: true });
      writeFileSync(join(root, "config", "email.local.yaml"), config);
    }
    if (password !== null) {
      mkdirSync(join(root, "data", "run"), { recursive: true });
      writeFileSync(join(root, "data", "run", "smtp-password"), password);
      chmodSync(join(root, "data", "run", "smtp-password"), mode);
    }
  }
  const config = "to: me@example.test\nsmtp_host: smtp.example.test\nuser: me@example.test\n";

  it("is off (null) without the config file", () => {
    expect(loadEmailSettings(tempRoot())).toBeNull();
  });

  it("reads the config and the app password, trimmed", () => {
    const root = tempRoot();
    write(root, config, "abcd efgh ijkl mnop\n");
    expect(loadEmailSettings(root)).toEqual({ config: CONFIG, password: "abcd efgh ijkl mnop" });
  });

  it("refuses a missing, empty or group/world-readable password file", () => {
    const missing = tempRoot();
    write(missing, config, null);
    expect(() => loadEmailSettings(missing)).toThrow("data/run/smtp-password is missing or empty");
    const open = tempRoot();
    write(open, config, "secret", 0o644);
    expect(() => loadEmailSettings(open)).toThrow("data/run/smtp-password is readable by others: chmod 600 it");
  });
});
