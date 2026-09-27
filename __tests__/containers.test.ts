import { afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Neo4j and SearXNG run in colima, and were down from 2026-09-23 until they
// were started by hand on 2026-09-26. Two reasons: nothing ever started
// colima (the scripts only knew Docker Desktop), and the stack's launchd job
// runs with PATH=node/bin:/usr/bin:/bin:/usr/sbin:/sbin, so `docker` in
// /opt/homebrew/bin was never found and ensure_containers always reported
// Docker as not running.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Stand-ins for docker and colima in a fake Homebrew bin dir that is NOT on
// PATH, only in SERVICES_EXTRA_PATH, the way launchd leaves /opt/homebrew/bin out.
function sandbox(opts: { dockerUp: boolean; withColima: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "containers-"));
  dirs.push(root);
  const brew = join(root, "brew-bin");
  mkdirSync(brew);
  const calls = join(root, "calls.log");
  const up = join(root, "docker-up");
  if (opts.dockerUp) writeFileSync(up, "");
  const stub = (name: string, body: string) => {
    writeFileSync(join(brew, name), `#!/bin/bash\necho "${name} $*" >>"${calls}"\n${body}\n`);
    chmodSync(join(brew, name), 0o755);
  };
  stub(
    "docker",
    `case "$1" in
  info) [ -e "${up}" ] || exit 1 ;;
  inspect) echo false ;;
  start) exit 0 ;;
esac`,
  );
  if (opts.withColima) stub("colima", `[ "$1" = start ] && touch "${up}"; exit 0`);

  const result = spawnSync(
    "bash",
    ["-c", 'set -u; source "$1/scripts/lib/services.sh"; ensure_containers', "bash", process.cwd()],
    { encoding: "utf-8", env: { PATH: "/usr/bin:/bin", HOME: root, SERVICES_EXTRA_PATH: brew } },
  );
  const log = existsSync(calls) ? readFileSync(calls, "utf-8").split("\n").filter(Boolean) : [];
  return { result, log };
}

describe("services.sh ensure_containers", () => {
  it("finds docker in the Homebrew bin dir even when launchd's PATH leaves it out", () => {
    const { result, log } = sandbox({ dockerUp: true, withColima: false });
    expect(result.status).toBe(0);
    expect(log).toEqual(expect.arrayContaining(["docker start neo4j", "docker start searxng"]));
  });

  it("starts colima when the Docker daemon is not reachable, then the containers", () => {
    const { result, log } = sandbox({ dockerUp: false, withColima: true });
    expect(result.status).toBe(0);
    const colima = log.indexOf("colima start");
    expect(colima).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("docker start neo4j")).toBeGreaterThan(colima);
    expect(log.indexOf("docker start searxng")).toBeGreaterThan(colima);
  });

  it("leaves colima alone when Docker is already reachable", () => {
    const { log } = sandbox({ dockerUp: true, withColima: true });
    expect(log.some((l) => l.startsWith("colima"))).toBe(false);
  });

  it("says how to start a runtime, and carries on, when there is none", () => {
    const { result, log } = sandbox({ dockerUp: false, withColima: false });
    expect(result.status).toBe(0);
    expect(log.some((l) => l.startsWith("docker start"))).toBe(false);
    expect(result.stdout).toMatch(/colima start/);
  });
});

describe("launchd job PATH", () => {
  // Every rendered plist takes its PATH from launchd_path() in scripts/lib/launchd.sh
  const launchdPath = (nodeBin: string) =>
    spawnSync("bash", ["-c", 'source "$1/scripts/lib/launchd.sh"; launchd_path "$2"', "bash", process.cwd(), nodeBin], {
      encoding: "utf-8",
    }).stdout;

  it("includes the Homebrew bin dirs, where docker and colima live", () => {
    expect(launchdPath("/opt/node/bin/node")).toBe(
      "/opt/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    );
  });

  it("leaves out the node dir when there is no node binary to name", () => {
    expect(launchdPath("")).toBe("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  });
});
