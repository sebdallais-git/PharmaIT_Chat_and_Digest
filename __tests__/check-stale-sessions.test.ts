import { afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

// Runs scripts/check-stale-sessions.sh against a fake HERMES_HOME: a session
// store, an agent log and cron job definitions built here, so no real Hermes
// state is read.

const scriptPath = join(process.cwd(), "scripts", "check-stale-sessions.sh");

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface FakeSession {
  id: string;
  key?: string;
  createdAt: string;
  toolCalls: number;
  routed?: boolean;
}

interface FakeHermes {
  sessions?: FakeSession[];
  logLines?: string[];
  jobs?: unknown;
}

// Two registration bursts: the server was "pharmallm", then renamed at 10:00.
const RENAME_LOG = [
  "2026-09-21 09:00:00,100 INFO tools.mcp: MCP server 'pharmallm' (HTTP): registered 16 tool(s)",
  "2026-09-21 10:00:00,100 INFO tools.mcp: MCP server 'pharmaitchat' (HTTP): registered 16 tool(s)",
];

function fakeHermes(spec: FakeHermes): string {
  const home = mkdtempSync(join(tmpdir(), "stale-sessions-test-"));
  tempDirs.push(home);
  mkdirSync(join(home, "logs"));
  mkdirSync(join(home, "cron"));

  const db = new Database(join(home, "state.db"));
  db.exec("CREATE TABLE gateway_routing (entry_json TEXT)");
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, message_count INTEGER, tool_call_count INTEGER)");
  for (const s of spec.sessions ?? []) {
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(s.id, 10, s.toolCalls);
    if (s.routed ?? true) {
      db.prepare("INSERT INTO gateway_routing VALUES (?)").run(
        JSON.stringify({ session_id: s.id, session_key: s.key ?? `agent:main:telegram:dm:${s.id}`, created_at: s.createdAt }),
      );
    }
  }
  db.close();

  writeFileSync(join(home, "logs", "agent.log"), (spec.logLines ?? RENAME_LOG).join("\n") + "\n");
  if (spec.jobs !== undefined) writeFileSync(join(home, "cron", "jobs.json"), JSON.stringify(spec.jobs));
  return home;
}

function check(home: string, ...args: string[]) {
  return spawnSync("bash", [scriptPath, ...args], {
    encoding: "utf-8",
    env: { PATH: "/usr/bin:/bin", HOME: home, HERMES_HOME: home },
  });
}

describe("check-stale-sessions.sh", () => {
  it("passes when every routed session started after the current namespace", () => {
    const home = fakeHermes({ sessions: [{ id: "fresh", createdAt: "2026-09-21T10:05:00", toolCalls: 4 }] });
    const result = check(home);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK: no session predates the current MCP namespace");
  });

  it("flags a routed session that predates the rename and has called tools", () => {
    const home = fakeHermes({ sessions: [{ id: "old", createdAt: "2026-09-21T09:30:00", toolCalls: 21 }] });
    const result = check(home);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("AT RISK:");
    expect(result.stdout).toContain("session old (agent:main:telegram:dm:old) started 2026-09-21T09:30:00, 21 tool calls");
  });

  it("does not flag an old session that has never called a tool", () => {
    const home = fakeHermes({ sessions: [{ id: "idle", createdAt: "2026-09-21T09:30:00", toolCalls: 0 }] });
    expect(check(home).status).toBe(0);
  });

  it("fails on a dead tool name called by a session that is still routed", () => {
    const home = fakeHermes({
      sessions: [{ id: "s1", createdAt: "2026-09-21T10:05:00", toolCalls: 3 }],
      logLines: [
        ...RENAME_LOG,
        "2026-09-21 10:10:00,000 WARNING [s1] tool error: 'mcp__pharmallm__search' is not a deferrable tool",
      ],
    });
    const result = check(home);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("routed session s1 called mcp__pharmallm__search (1x) after the rename");
  });

  it("reports a dead-name call from a retired session without failing", () => {
    const home = fakeHermes({
      logLines: [
        ...RENAME_LOG,
        "2026-09-21 10:10:00,000 WARNING [gone] tool error: 'mcp__pharmallm__search' is not a deferrable tool",
      ],
    });
    const result = check(home);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("gone  mcp__pharmallm__search  x1  (retired session)");
  });

  it("flags a cron job that still names the server from the earlier registration burst", () => {
    const home = fakeHermes({
      jobs: {
        jobs: [
          { name: "news-digest", enabled: true, prompt: "use mcp__pharmaitchat__search" },
          { name: "old-digest", enabled: true, prompt: "use mcp__pharmallm__search" },
        ],
      },
    });
    const result = check(home);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("cron job old-digest references ['pharmallm']");
    expect(result.stdout).not.toContain("cron job news-digest");
  });

  it("prints only the verdict with --quiet", () => {
    const home = fakeHermes({ sessions: [{ id: "old", createdAt: "2026-09-21T09:30:00", toolCalls: 2 }] });
    const result = check(home, "--quiet");
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("routed sessions:");
    expect(result.stdout.trim().startsWith("AT RISK:")).toBe(true);
  });

  it("exits 2 when there is no session store", () => {
    const home = mkdtempSync(join(tmpdir(), "stale-sessions-test-"));
    tempDirs.push(home);
    const result = check(home);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("no session store");
  });

  it("leaves the session store untouched", () => {
    const home = fakeHermes({ sessions: [{ id: "old", createdAt: "2026-09-21T09:30:00", toolCalls: 5 }] });
    const digest = () => createHash("sha256").update(readFileSync(join(home, "state.db"))).digest("hex");
    const before = digest();
    check(home);
    expect(digest()).toBe(before);
  });
});
