import { afterEach, describe, expect, it } from "@jest/globals";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStacks } from "../src/config/llm-stacks.js";
import {
  aggregateHealth,
  CRITICAL_CHECKS,
  GENERATION_PROBE_TIMEOUT_MS,
  isScorerConfigured,
  probeGeneration,
  probeUrl,
  scorerInstallPaths,
  stackProbeUrls,
} from "../src/services/health.js";
import { sendJson, startFakeServer } from "./helpers/fake-openai-server.js";
import type { FakeServer } from "./helpers/fake-openai-server.js";

let server: FakeServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

describe("stackProbeUrls", () => {
  it("probes only the active stack's endpoints", () => {
    const { ollama, mlx } = buildStacks({});
    const ollamaUrls = Object.values(stackProbeUrls(ollama));
    const mlxUrls = Object.values(stackProbeUrls(mlx));

    expect(ollamaUrls).toEqual(["http://localhost:11434/v1/models", "http://localhost:11434/v1/models"]);
    expect(mlxUrls).toEqual(["http://localhost:8080/v1/models", "http://localhost:8081/v1/models"]);
    expect(ollamaUrls.some((url) => url.includes(":8080") || url.includes(":8081"))).toBe(false);
    expect(mlxUrls.some((url) => url.includes(":11434"))).toBe(false);
  });
});

describe("aggregateHealth", () => {
  const up = { status: "ok" as const };
  const down = { status: "unreachable" as const };

  it("is healthy when everything is ok", () => {
    expect(aggregateHealth({ llm_chat: up, llm_embed: up, search_index: up, searxng: up })).toBe("healthy");
  });

  it("is degraded when only a supporting service is down", () => {
    expect(aggregateHealth({ llm_chat: up, llm_embed: up, search_index: up, searxng: down })).toBe("degraded");
  });

  it("is unhealthy when the stack or the search index is down", () => {
    expect(aggregateHealth({ llm_chat: down, llm_embed: up, search_index: up })).toBe("unhealthy");
    expect(aggregateHealth({ llm_chat: up, llm_embed: down, search_index: up })).toBe("unhealthy");
    expect(aggregateHealth({ llm_chat: up, llm_embed: up, search_index: { status: "error" } })).toBe("unhealthy");
  });
});

describe("probeUrl", () => {
  it("reports ok, error and unreachable", async () => {
    server = await startFakeServer((req, res) => sendJson(res, req.url === "/ok" ? 200 : 500, {}));

    const ok = await probeUrl(`${server.baseUrl}/ok`);
    expect(ok.status).toBe("ok");
    expect(typeof ok.latency_ms).toBe("number");
    expect((await probeUrl(`${server.baseUrl}/fail`)).status).toBe("error");
    expect((await probeUrl("http://127.0.0.1:9/")).status).toBe("unreachable");
  });
});

describe("generation probe", () => {
  // /v1/models answers from a wedged server: on 2026-09-22 MLX sat at 0% CPU
  // accepting connections and serving /v1/models while a 5-token generation
  // timed out at 90s, and /api/health reported llm_chat ok throughout. Liveness
  // is not readiness -- only generating a token proves the model works.
  it("reports ok when the model actually produces a token", async () => {
    const server = await startFakeServer((_req, res) =>
      sendJson(res, 200, { choices: [{ message: { content: "ok" } }] }),
    );
    try {
      const check = await probeGeneration({ chatBaseUrl: server.baseUrl, chatModel: "test-chat-model" }, 5000);
      expect(check.status).toBe("ok");
    } finally {
      await server.close();
    }
  });

  it("reports unreachable when generation hangs, even though the port is open", async () => {
    // Never responds: the wedged case, which a /v1/models probe would pass.
    const server = await startFakeServer(() => {});
    try {
      const check = await probeGeneration({ chatBaseUrl: server.baseUrl, chatModel: "test-chat-model" }, 300);
      expect(check.status).toBe("unreachable");
    } finally {
      await server.close();
    }
  });

  it("names the stack's chat model, which every stack but mlx_lm.server requires", async () => {
    const server = await startFakeServer((_req, res) =>
      sendJson(res, 200, { choices: [{ message: { content: "ok" } }] }),
    );
    try {
      await probeGeneration({ chatBaseUrl: server.baseUrl, chatModel: "test-chat-model" }, 5000);
      expect(server.requests[0].body).toMatchObject({ model: "test-chat-model" });
    } finally {
      await server.close();
    }
  });

  it("says a timeout may mean busy rather than wedged", async () => {
    // The chat server handles one request at a time, so the probe also times
    // out behind a long chat turn. The check stays down but says so.
    const server = await startFakeServer(() => {});
    try {
      const check = await probeGeneration({ chatBaseUrl: server.baseUrl, chatModel: "m" }, 300);
      expect(check.detail).toMatch(/busy/);
    } finally {
      await server.close();
    }
  });
});

describe("check-services.sh", () => {
  it("waits longer for /api/health than the generation probe inside it can take", () => {
    const script = readFileSync(join(process.cwd(), "scripts", "check-services.sh"), "utf-8");
    const match = script.match(/curl -sf -m (\d+) http:\/\/localhost:3000\/api\/health/);
    expect(match).not.toBeNull();
    expect(Number(match![1]) * 1000).toBeGreaterThan(GENERATION_PROBE_TIMEOUT_MS);
  });
});

describe("the scorer is a non-critical dependency", () => {
  // Chat must keep working with the scorer down: only the gap-resolution loop
  // depends on it, and that loop degrades to "no decision" rather than to a
  // wrong one.
  it("is not in CRITICAL_CHECKS", () => {
    expect(CRITICAL_CHECKS).toEqual(["llm_chat", "llm_embed", "search_index"]);
    expect(CRITICAL_CHECKS).not.toContain("jev");
  });

  it("degrades rather than fails the app when the scorer is unreachable", () => {
    const status = aggregateHealth({
      llm_chat: { status: "ok" },
      llm_embed: { status: "ok" },
      search_index: { status: "ok" },
      jev: { status: "unreachable" },
    });

    expect(status).toBe("degraded");
  });

  it("still reports unhealthy when a critical check is down, scorer or not", () => {
    expect(
      aggregateHealth({
        llm_chat: { status: "unreachable" },
        llm_embed: { status: "ok" },
        search_index: { status: "ok" },
        jev: { status: "ok" },
      }),
    ).toBe("unhealthy");
  });

  // Installing the scorer is optional and skippable (scripts/hermes-setup.sh
  // returns 0 without it). On a machine where it was skipped, probing it and
  // reporting "unreachable" pinned /api/health at degraded forever, and
  // check-services.sh prints anything but "healthy" red -- the one place this
  // feature made the app behave WORSE with the scorer absent than before it
  // existed. A dependency that was never installed is not a fault.
  it("stays healthy when the scorer was never installed", () => {
    expect(
      aggregateHealth({
        llm_chat: { status: "ok" },
        llm_embed: { status: "ok" },
        search_index: { status: "ok" },
        jev: { status: "not_configured" },
      }),
    ).toBe("healthy");
  });

  it("does not let not_configured excuse a critical check", () => {
    expect(
      aggregateHealth({
        llm_chat: { status: "not_configured" },
        llm_embed: { status: "ok" },
        search_index: { status: "ok" },
      }),
    ).toBe("unhealthy");
  });
});

describe("scorerInstallPaths / isScorerConfigured", () => {
  // The same two artifacts scripts/hermes-setup.sh requires and renders. No
  // launchctl, no scorer, no network: two paths on disk.
  const jevDir = mkdtempSync(join(tmpdir(), "jev-"));
  const launchAgentsDir = mkdtempSync(join(tmpdir(), "agents-"));
  const paths = { plist: join(launchAgentsDir, "com.pharmaitchat.jev.plist"), binary: join(jevDir, ".venv", "bin", "openjev") };

  it("derives the plist and venv paths from the same env vars as hermes-setup.sh", () => {
    const derived = scorerInstallPaths({ LAUNCH_AGENTS_DIR: launchAgentsDir, JEV_DIR: jevDir });

    expect(derived).toEqual(paths);
  });

  // The VENV is what "a scorer exists here" means. The plist only says launchd
  // manages it -- and scripts/run-jev.sh runs the scorer perfectly well without
  // one, which is exactly what someone does first: `make serve` by hand, before
  // committing to a launch agent.
  //
  // Requiring both used to mean that setup reported "not configured", so
  // /api/health never probed a scorer that was actually running AND shadow
  // detection (gap-detector.ts) never switched on -- silently withholding the
  // evidence the shadow mode exists to collect.
  it("is configured as soon as the venv exists, with or without a launch agent", () => {
    expect(isScorerConfigured(paths)).toBe(false);

    mkdirSync(join(jevDir, ".venv", "bin"), { recursive: true });
    writeFileSync(paths.binary, "#!/bin/sh\n");
    expect(isScorerConfigured(paths)).toBe(true); // hand-run scorer, no launch agent

    writeFileSync(paths.plist, "<plist/>");
    expect(isScorerConfigured(paths)).toBe(true);
  });

  it("is not configured when only a launch agent exists and the venv does not", () => {
    const bare = mkdtempSync(join(tmpdir(), "jev-bare-"));
    const agents = mkdtempSync(join(tmpdir(), "agents-bare-"));
    const orphan = {
      plist: join(agents, "com.pharmaitchat.jev.plist"),
      binary: join(bare, ".venv", "bin", "openjev"),
    };
    writeFileSync(orphan.plist, "<plist/>");

    // A plist pointing at a venv that is gone is a stale install, not a scorer.
    expect(isScorerConfigured(orphan)).toBe(false);
  });
});
