// The digest by email, next to Telegram. Telegram cuts a message at 4,096
// characters, so it gets the 3,900-character render; the email gets the full
// digest, as HTML with clickable item links plus a plain-text part.
//
// Off unless config/email.local.yaml exists (gitignored: an address is
// personal). The SMTP password (a Gmail app password) lives in
// data/run/smtp-password, mode 600, like the other tokens: never on a command
// line, never in git or a .env file. Send-only: nothing reads a mailbox.
//
// The digest uses a small Markdown subset (digest-builder.ts renders it): a bold
// title line, bold section lines, "- " bullets, _notes_, **bold** and
// [text](url) links. That subset is converted here rather than with a Markdown
// library; text is escaped first, so a news title cannot inject HTML.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import nodemailer from "nodemailer";
import { parse } from "yaml";

export const EMAIL_CONFIG_FILE = "config/email.local.yaml";
export const SMTP_PASSWORD_FILE = "data/run/smtp-password";

export interface EmailConfig {
  to: string;
  from: string;
  smtpHost: string;
  smtpPort: number;
  // The SMTP login, usually the sender's address
  user: string;
}

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type SendMail = (message: MailMessage) => Promise<void>;

// ---- Markdown subset -> HTML and plain text --------------------------------

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const isWebUrl = (url: string) => /^https?:\/\//i.test(url);

// [label](url), the label allowed one level of brackets: news titles like
// "[Webinar] Roche on AI" are common
const LINK = /\[((?:[^[\]]|\[[^[\]]*\])+)\]\(([^)\s]+)\)/g;

// On escaped text: links become placeholders first, so the bold pass never
// rewrites inside an href, then bold, then the links go back in
function inlineHtml(escaped: string): string {
  const links: string[] = [];
  const hold = (html: string) => `\u0000${links.push(html) - 1}\u0000`;
  return escaped
    .replace(LINK, (_m, label: string, url: string) => (isWebUrl(url) ? hold(`<a href="${url}">${label}</a>`) : label))
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => links[Number(i)]);
}

const stripBold = (text: string) => text.replace(/\*\*/g, "");

export function markdownToHtml(markdown: string): string {
  const out: string[] = [];
  let inList = false;
  const closeList = () => {
    if (inList) out.push("</ul>");
    inList = false;
  };
  markdown.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line === "") return closeList();
    const escaped = escapeHtml(line);
    if (i === 0) return out.push(`<h1>${inlineHtml(stripBold(escaped))}</h1>`);
    const section = /^\*\*(.+)\*\*$/.exec(escaped);
    if (section && !section[1].includes("**")) {
      closeList();
      return out.push(`<h2>${inlineHtml(section[1])}</h2>`);
    }
    if (escaped.startsWith("- ")) {
      if (!inList) out.push("<ul>");
      inList = true;
      return out.push(`<li>${inlineHtml(escaped.slice(2))}</li>`);
    }
    closeList();
    const note = /^_(.+)_$/.exec(escaped);
    out.push(note ? `<p><em>${inlineHtml(note[1])}</em></p>` : `<p>${inlineHtml(escaped)}</p>`);
  });
  closeList();
  return [
    '<!doctype html><html><head><meta charset="utf-8"></head>',
    '<body style="font-family: -apple-system, Helvetica, Arial, sans-serif; font-size: 15px; line-height: 1.45; color: #1d1d1f; max-width: 760px;">',
    ...out,
    "</body></html>",
  ].join("\n");
}

export function markdownToText(markdown: string): string {
  return markdown
    .split("\n")
    .map((raw) =>
      stripBold(
        raw
          .replace(/\[\[(\d+)\]\]\(([^)\s]+)\)/g, " [$1] $2 ")
          .replace(LINK, "$1 ($2)"),
      )
        .replace(/^_(.+)_$/, "$1")
        .replace(/ {2,}/g, " ")
        .replace(/\s+$/, ""),
    )
    .join("\n");
}

/** "Digest · the last 7 days" from the title line "**Digest · the last 7 days** for …". */
export function digestSubject(markdown: string): string {
  const first = markdown.split("\n")[0] ?? "";
  return /^\*\*(.+?)\*\*/.exec(first)?.[1] ?? (stripBold(first).trim() || "Digest");
}

export function digestEmail(config: EmailConfig, markdown: string): MailMessage {
  return { from: config.from, to: config.to, subject: digestSubject(markdown), text: markdownToText(markdown), html: markdownToHtml(markdown) };
}

// ---- Settings ----------------------------------------------------------------

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseEmailConfig(yaml: string): EmailConfig {
  const raw: unknown = parse(yaml) ?? {};
  const fail = (message: string): never => {
    throw new Error(`${EMAIL_CONFIG_FILE}: ${message}`);
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail("must be a mapping");
  const r = raw as Record<string, unknown>;
  const str = (key: string) => (typeof r[key] === "string" ? (r[key] as string).trim() : "");
  const to = str("to");
  if (!EMAIL.test(to)) fail("to must be an email address");
  const smtpHost = str("smtp_host");
  if (smtpHost === "") fail("smtp_host is required (e.g. smtp.gmail.com)");
  const user = str("user");
  if (user === "") fail("user is required (the SMTP login, e.g. your Gmail address)");
  const from = str("from") || user;
  if (!EMAIL.test(from)) fail("from must be an email address (it defaults to user)");
  const port = r.smtp_port ?? 587;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) fail("smtp_port must be a port number");
  return { to, from, smtpHost, smtpPort: port as number, user };
}

/** The settings, or null when email is off (no config file). Throws on a bad file or password. */
export function loadEmailSettings(root: string): { config: EmailConfig; password: string } | null {
  const configPath = join(root, EMAIL_CONFIG_FILE);
  if (!existsSync(configPath)) return null;
  const config = parseEmailConfig(readFileSync(configPath, "utf-8"));
  const passwordPath = join(root, SMTP_PASSWORD_FILE);
  const password = existsSync(passwordPath) ? readFileSync(passwordPath, "utf-8").trim() : "";
  if (password === "") throw new Error(`${SMTP_PASSWORD_FILE} is missing or empty`);
  // Like ssh with a private key: a password others can read is refused
  if ((statSync(passwordPath).mode & 0o077) !== 0) throw new Error(`${SMTP_PASSWORD_FILE} is readable by others: chmod 600 it`);
  return { config, password };
}

export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  auth: { user: string; pass: string };
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
}

export type CreateTransport = (options: SmtpOptions) => { sendMail(message: MailMessage): Promise<unknown> };

/**
 * The live sender (SMTP over STARTTLS on 587, TLS on 465). Short timeouts: the
 * Hermes job posts the Telegram message only when the script exits, and
 * nodemailer's defaults would wait up to 10 minutes on a stalled server.
 */
export function smtpSender(config: EmailConfig, password: string, create: CreateTransport = (o) => nodemailer.createTransport(o)): SendMail {
  const transport = create({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    requireTLS: config.smtpPort !== 465,
    auth: { user: config.user, pass: password },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return async (message) => {
    await transport.sendMail(message);
  };
}
