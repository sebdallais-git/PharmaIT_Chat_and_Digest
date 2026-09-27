import { afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { copyFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

// On 2026-09-26 every search the gap loop made came back empty: SearXNG ran
// its default general-web engines, and all of them answered this machine with
// CAPTCHAs, "access denied" or rate limits, including Bing, Mojeek, Qwant,
// Yahoo and Presearch once they were switched on. Brave's Search API
// authenticates with a key instead, so it does not rate-limit by address.
//
// SearXNG only reads that key from its settings file, never from the
// environment. The repo keeps the file without the key; setup-searxng.sh
// renders the key in inside the container, so it never reaches the repo or
// an argv.

const configPath = join(process.cwd(), "config", "searxng", "settings.yml");
const renderPath = join(process.cwd(), "scripts", "lib", "render-searxng-settings.py");

interface EngineOverride {
  name: string;
  disabled?: boolean;
  inactive?: boolean;
  api_key?: string;
}

interface SearxSettings {
  use_default_settings?: unknown;
  server?: Record<string, unknown>;
  search?: { formats?: string[] };
  engines?: EngineOverride[];
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function engine(settings: SearxSettings, name: string): EngineOverride | undefined {
  return (settings.engines ?? []).find((e) => e.name === name);
}

describe("config/searxng/settings.yml", () => {
  const settings = parse(readFileSync(configPath, "utf-8")) as SearxSettings;

  it("builds on SearXNG's defaults instead of copying them", () => {
    expect(settings.use_default_settings).toBe(true);
  });

  it("serves JSON, which the n8n workflow and the chat's web search request", () => {
    expect(settings.search?.formats).toEqual(expect.arrayContaining(["html", "json"]));
  });

  it("lists the Brave Search API engine, inactive and keyless as committed", () => {
    expect(engine(settings, "braveapi")).toMatchObject({ inactive: true, api_key: "" });
  });

  it("holds no secret: SEARXNG_SECRET and the Brave key are supplied at setup", () => {
    expect(settings.server?.secret_key).toBeUndefined();
    expect(readFileSync(configPath, "utf-8")).not.toMatch(/secret_key\s*:/);
  });
});

describe("scripts/lib/render-searxng-settings.py", () => {
  function render(key: string | undefined, base = configPath) {
    const out = join(tempDir("searxng-render-"), "settings.yml");
    const env: Record<string, string> = { PATH: "/usr/bin:/bin" };
    if (key !== undefined) env.BRAVE_API_KEY = key;
    const result = spawnSync("python3", [renderPath, base, out], { encoding: "utf-8", env });
    return { result, out };
  }

  it("activates the Brave API engine with the key", () => {
    const { result, out } = render("BSA-test-key");
    expect(result.status).toBe(0);
    const settings = parse(readFileSync(out, "utf-8")) as SearxSettings;
    expect(engine(settings, "braveapi")).toMatchObject({ inactive: false, api_key: "BSA-test-key" });
  });

  it("changes nothing else", () => {
    const { out } = render("BSA-test-key");
    const rendered = parse(readFileSync(out, "utf-8")) as SearxSettings;
    const base = parse(readFileSync(configPath, "utf-8")) as SearxSettings;
    const withoutBrave = (s: SearxSettings) => ({ ...s, engines: (s.engines ?? []).filter((e) => e.name !== "braveapi") });
    expect(withoutBrave(rendered)).toEqual(withoutBrave(base));
  });

  it("quotes a key with YAML-significant characters safely", () => {
    const tricky = 'a"b: #c \\ d';
    const { out } = render(tricky);
    const settings = parse(readFileSync(out, "utf-8")) as SearxSettings;
    expect(engine(settings, "braveapi")?.api_key).toBe(tricky);
  });

  it("writes the rendered file readable only by its owner", () => {
    const { out } = render("BSA-test-key");
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });

  it("leaves the engine inactive and the file unchanged without a key", () => {
    const { result, out } = render(undefined);
    expect(result.status).toBe(0);
    expect(readFileSync(out, "utf-8")).toBe(readFileSync(configPath, "utf-8"));
  });

  it("refuses a base file whose placeholders are missing", () => {
    const base = join(tempDir("searxng-render-"), "base.yml");
    writeFileSync(base, "use_default_settings: true\n");
    const { result } = render("BSA-test-key", base);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("placeholder");
  });
});

describe("scripts/setup-searxng.sh", () => {
  // Runs a copy of the script in a sandbox whose docker is a recorder, so no
  // container is touched. The recorder notes which secrets were in its
  // environment, since `-e NAME` passes a value by name only.
  function setup(opts: { secret?: string; braveKey?: string } = {}) {
    const root = tempDir("searxng-setup-");
    const scripts = join(root, "scripts");
    const run = join(root, "data", "run");
    const bin = join(root, "bin");
    for (const dir of [join(scripts, "lib"), run, bin, join(root, "config", "searxng")]) mkdirSync(dir, { recursive: true });
    copyFileSync(join(process.cwd(), "scripts", "setup-searxng.sh"), join(scripts, "setup-searxng.sh"));
    copyFileSync(renderPath, join(scripts, "lib", "render-searxng-settings.py"));
    copyFileSync(configPath, join(root, "config", "searxng", "settings.yml"));
    if (opts.secret !== undefined) writeFileSync(join(run, "searxng-secret"), `${opts.secret}\n`);
    if (opts.braveKey !== undefined) writeFileSync(join(run, "brave-api-key"), `${opts.braveKey}\n`);

    const calls = join(root, "docker.log");
    const stdinCopy = join(root, "exec-stdin");
    writeFileSync(
      join(bin, "docker"),
      [
        "#!/bin/bash",
        `echo "docker $* | secret=\${SEARXNG_SECRET:+yes} brave=\${BRAVE_API_KEY:-none}" >>"${calls}"`,
        `[ "$1" = exec ] && cat >"${stdinCopy}"`,
        "exit 0",
      ].join("\n"),
    );
    chmodSync(join(bin, "docker"), 0o755);

    const result = spawnSync("bash", [join(scripts, "setup-searxng.sh")], {
      encoding: "utf-8",
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root },
    });
    const log = existsSync(calls) ? readFileSync(calls, "utf-8").split("\n").filter(Boolean) : [];
    const argv = (line: string) => line.split(" | ")[0];
    return { result, log, root, run, argv, stdinCopy };
  }

  it("replaces the container, mounting the repo config read-only as the base", () => {
    const { result, log, root } = setup({ secret: "s3cret" });
    expect(result.status).toBe(0);
    const rm = log.findIndex((l) => l.startsWith("docker rm -f searxng"));
    const create = log.findIndex((l) => l.startsWith("docker run "));
    expect(rm).toBeGreaterThanOrEqual(0);
    expect(create).toBeGreaterThan(rm);
    const runLine = log[create];
    expect(runLine).toContain("--name searxng");
    expect(runLine).toContain("--restart unless-stopped");
    expect(runLine).toContain("-p 8888:8080");
    expect(runLine).toContain(`-v ${join(root, "config", "searxng", "settings.yml")}:/etc/searxng/base.yml:ro`);
    expect(runLine).toMatch(/ searxng\/searxng(\s|$)/);
  });

  it("renders the settings inside the container, then restarts it", () => {
    const { log, stdinCopy } = setup({ secret: "s3cret", braveKey: "BSA-live" });
    const create = log.findIndex((l) => l.startsWith("docker run "));
    const exec = log.findIndex((l) => l.startsWith("docker exec "));
    const restart = log.findIndex((l) => l.startsWith("docker restart searxng"));
    expect(exec).toBeGreaterThan(create);
    expect(restart).toBeGreaterThan(exec);
    expect(log[exec]).toContain("/etc/searxng/base.yml /etc/searxng/settings.yml");
    // The render script itself travels on stdin
    expect(readFileSync(stdinCopy, "utf-8")).toBe(readFileSync(renderPath, "utf-8"));
  });

  it("passes both secrets through the environment, never as arguments", () => {
    const { log, argv } = setup({ secret: "s3cret", braveKey: "BSA-live" });
    const runLine = log.find((l) => l.startsWith("docker run ")) ?? "";
    const execLine = log.find((l) => l.startsWith("docker exec ")) ?? "";
    expect(argv(runLine)).toContain("-e SEARXNG_SECRET ");
    expect(argv(execLine)).toContain("-e BRAVE_API_KEY ");
    for (const line of log) {
      expect(argv(line)).not.toContain("s3cret");
      expect(argv(line)).not.toContain("BSA-live");
    }
    expect(runLine).toContain("secret=yes");
    expect(execLine).toContain("brave=BSA-live");
  });

  it("still renders, without the Brave engine, when there is no key", () => {
    const { result, log } = setup({ secret: "s3cret" });
    expect(result.status).toBe(0);
    const execLine = log.find((l) => l.startsWith("docker exec ")) ?? "";
    expect(execLine).toContain("brave=none");
  });

  it("creates a secret once, readable only by the owner", () => {
    const { run } = setup();
    const file = join(run, "searxng-secret");
    expect(readFileSync(file, "utf-8").trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("keeps an existing secret", () => {
    const { run } = setup({ secret: "keep-me" });
    expect(readFileSync(join(run, "searxng-secret"), "utf-8").trim()).toBe("keep-me");
  });
});
