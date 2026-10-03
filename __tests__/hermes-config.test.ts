import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { DEFAULT_INGEST_BUDGET_MS } from "../src/services/watchlist-ingest.js";

const hermesDir = join(process.cwd(), "hermes");
const configText = readFileSync(join(hermesDir, "config.template.yaml"), "utf-8");
const config = parse(configText) as Record<string, unknown>;

// Walks a parsed YAML object by key path; fails the test when a key is missing
function at(path: string): unknown {
  let value: unknown = config;
  for (const key of path.split(".")) {
    if (typeof value !== "object" || value === null || !(key in value)) {
      throw new Error(`config.template.yaml has no ${path}`);
    }
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

interface CronJob {
  name: string;
  schedule: string;
  deliver: string;
  // Prompt-mode jobs (an LLM agent using MCP tools, the default when `kind`
  // is absent) carry `prompt`. Task 8's watchlist ingest is `kind: "script"`
  // -- Hermes' own --no-agent cron mode (verified against
  // ~/.hermes/hermes-agent/hermes_cli/subcommands/cron.py, R19): no LLM
  // step, a script under ~/.hermes/scripts/ instead of a prompt, and its own
  // delivery target for failures only.
  prompt?: string;
  kind?: "script";
  script?: string;
  no_agent?: boolean;
  failure_deliver?: string;
  // C1(b): what install-cron writes into ~/.hermes/config.yaml as
  // cron.script_timeout_seconds before creating this job.
  script_timeout_seconds?: number;
}

const jobs = JSON.parse(readFileSync(join(hermesDir, "cron", "jobs.json"), "utf-8")) as CronJob[];

describe("hermes/config.template.yaml", () => {
  it("references only documented environment variables", () => {
    const referenced = [...configText.matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((match) => match[1]);
    expect(new Set(referenced)).toEqual(new Set(["PHARMALLM_URL", "PHARMALLM_MCP_URL", "PHARMALLM_MCP_TOKEN"]));
    expect(at("providers.pharmaitchat.key_env")).toBe("PHARMAITCHAT_API_TOKEN");
    expect(configText).not.toMatch(/[0-9a-f]{32,}/);
  });

  it("uses the PharmaITChat gateway with a 64k context and no model discovery", () => {
    expect(at("model.provider")).toBe("custom:pharmaitchat");
    expect(at("model.default")).toBe("pharmaitchat-local");
    expect(at("model.context_length")).toBe(65536);
    expect(at("providers.pharmaitchat.api")).toBe("${PHARMALLM_URL}/v1");
    expect(at("providers.pharmaitchat.discover_models")).toBe(false);
    expect(at("providers.pharmaitchat.request_timeout_seconds")).toBe(1800);
    expect(at("providers.pharmaitchat.models.pharmaitchat-local.context_length")).toBe(65536);
  });

  it("pins the cron provider so scheduled runs resolve credentials", () => {
    // Hermes stores a bare "custom" snapshot per job and resolves cron runs from cron.* first
    expect(at("cron.model")).toBe("pharmaitchat-local");
    expect(at("cron.model_provider")).toBe("custom:pharmaitchat");
  });

  it("connects to pharmaitchat-mcp with a bearer token, long timeout and no start_reindex", () => {
    expect(at("mcp_servers.pharmaitchat.url")).toBe("${PHARMALLM_MCP_URL}");
    expect(at("mcp_servers.pharmaitchat.headers.Authorization")).toBe("Bearer ${PHARMALLM_MCP_TOKEN}");
    expect(at("mcp_servers.pharmaitchat.timeout")).toBe(900);
    expect(at("mcp_servers.pharmaitchat.connect_timeout")).toBe(30);
    expect(at("mcp_servers.pharmaitchat.tools.exclude")).toEqual(["start_reindex"]);
  });

  it("sandboxes the shell, denies unattended approvals and keeps web search local", () => {
    expect(at("terminal.backend")).toBe("docker");
    expect(at("terminal.docker_network")).toBe(false);
    expect(at("terminal.docker_mount_cwd_to_workspace")).toBe(false);
    expect(at("terminal.docker_volumes")).toEqual([]);
    // The sandbox must fit the Docker VM, which Neo4j and SearXNG already share
    expect(at("terminal.container_cpu")).toBe(1);
    expect(at("terminal.container_memory")).toBe(512);
    expect(at("approvals.cron_mode")).toBe("deny");
    expect(at("approvals.unattended_mode")).toBe("deny");
    expect(at("approvals.single_query_mode")).toBe("deny");
    expect(at("skills.write_approval")).toBe(true);
    expect(at("web.search_backend")).toBe("searxng");
    expect(at("web.keyless_fallback")).toBe(false);
    expect(at("web.keyless_rescue")).toBe(false);
    expect(at("security.allow_private_urls")).toBe(false);
    expect(at("unauthorized_dm_behavior")).toBe("ignore");
    expect(at("agent.disabled_toolsets")).toEqual([
      "browser",
      "computer_use",
      "code_execution",
      "image_gen",
      "tts",
      "delegation",
      "kanban",
      "vision",
    ]);
    const telegram = at("platform_toolsets.telegram") as string[];
    expect(telegram).toContain("pharmaitchat");
    expect(telegram).not.toContain("cronjob");
  });

  it("gives unattended runs no ungated write channel", () => {
    // approvals.cron_mode gates dangerous *commands* only; MCP calls are never approval-gated, so the
    // cron toolset list and a write-limited MCP server are the real controls for scheduled runs
    expect(at("platform_toolsets.cron")).toEqual(["session_search", "pharmaitchat_cron"]);
    const cron = at("platform_toolsets.cron") as string[];
    for (const toolset of ["web", "search", "memory", "terminal", "file", "skills", "pharmaitchat"]) {
      expect(cron).not.toContain(toolset);
    }
    expect(at("mcp_servers.pharmaitchat_cron.tools.exclude")).toEqual(["start_reindex", "add_knowledge", "my_role"]);
    // Same endpoint and credentials as the interactive server, only the tool filter differs
    expect(at("mcp_servers.pharmaitchat_cron.url")).toBe(at("mcp_servers.pharmaitchat.url"));
    expect(at("mcp_servers.pharmaitchat_cron.headers.Authorization")).toBe(
      at("mcp_servers.pharmaitchat.headers.Authorization")
    );
    expect(at("mcp_servers.pharmaitchat_cron.timeout")).toBe(900);
    expect(at("mcp_servers.pharmaitchat_cron.connect_timeout")).toBe(30);
    expect(at("mcp_servers.pharmaitchat_cron.tools.resources")).toBe(false);
    expect(at("mcp_servers.pharmaitchat_cron.tools.prompts")).toBe(false);
  });

  it("enables the pharmaitchat-switch plugin that receives the stack-switch buttons", () => {
    expect(at("plugins.enabled")).toContain("pharmaitchat-switch");
  });

  it("keeps the tools the scheduled jobs actually call available to the cron server", () => {
    const excluded = at("mcp_servers.pharmaitchat_cron.tools.exclude") as string[];
    for (const tool of ["run_news_agent", "knowledge_status", "list_knowledge_gaps", "resolve_knowledge_gap", "system_health", "feedback_report"]) {
      expect(excluded).not.toContain(tool);
    }
  });
});

describe("hermes/cron/jobs.json", () => {
  it("defines the seven scheduled jobs delivered to Telegram", () => {
    expect(jobs.map((job) => job.name)).toEqual([
      "pharmaitchat-daily-briefing",
      "pharmaitchat-gap-resolution",
      "pharmaitchat-health-watch",
      "pharmaitchat-feedback-digest",
      "pharmaitchat-watchlist-ingest",
      "pharmaitchat-kb-canary",
      "pharmaitchat-weekly-digest",
    ]);
    // Two health runs a day, not three: every Hermes step is a full cold prefill (~160 s of GPU)
    expect(jobs.map((job) => job.schedule)).toEqual([
      "30 7 * * 2-5",
      "0 7 * * *",
      "0 9,19 * * *",
      "0 8 * * 1",
      "30 2 * * *",
      "0 5 * * *",
      "30 7 * * 1",
    ]);
    for (const job of jobs) {
      expect(job.schedule.split(" ")).toHaveLength(5);
    }
    // Only the prompt-mode (LLM agent) jobs are delivered straight to
    // Telegram and carry a prompt; the watchlist ingest job is checked on
    // its own terms below.
    for (const job of jobs.filter((job) => job.kind !== "script")) {
      expect(job.deliver).toBe("telegram");
      expect(job.prompt?.length ?? 0).toBeGreaterThan(40);
      expect(job.prompt).not.toContain("start_reindex");
    }
    expect(jobs[2].prompt).toContain("[SILENT]");
    expect(jobs[1].prompt).toContain("at most 3");
  });

  it("runs the watchlist ingest nightly at 02:30 as a script-mode job (Hermes --no-agent), clear of the news/gap/health/feedback windows, alerting only on failure", () => {
    const watchlistJob = jobs.find((job) => job.name === "pharmaitchat-watchlist-ingest");
    expect(watchlistJob).toBeDefined();
    expect(watchlistJob?.schedule).toBe("30 2 * * *");
    expect(watchlistJob?.kind).toBe("script");
    expect(watchlistJob?.script).toBe("pharmaitchat-watchlist-ingest.sh");
    expect(watchlistJob?.no_agent).toBe(true);
    // `deliver: local` keeps run state visible in `hermes cron list` without
    // pushing anything on a quiet night; `failure_deliver` overrides the
    // target for failure notices only (R19).
    expect(watchlistJob?.deliver).toBe("local");
    expect(watchlistJob?.failure_deliver).toBe("telegram");

    const otherSchedules = jobs.filter((job) => job.name !== "pharmaitchat-watchlist-ingest").map((job) => job.schedule);
    expect(otherSchedules).not.toContain(watchlistJob?.schedule);
  });

  // C1: Hermes' own no-agent script timeout defaults to 3600 s and kills the
  // script's whole process group, so the run would never reach finishRun --
  // an unfinished run row and a failure alert every night. The job therefore
  // declares a timeout of its own, and it must stay well above the budget the
  // run stops itself at, or the external kill wins again.
  it("asks Hermes for a script timeout far above the ingest's own wall-clock budget", () => {
    const watchlistJob = jobs.find((job) => job.name === "pharmaitchat-watchlist-ingest");
    const timeoutMs = (watchlistJob?.script_timeout_seconds ?? 0) * 1000;

    expect(timeoutMs).toBeGreaterThan(DEFAULT_INGEST_BUDGET_MS);
    // Not merely greater: the run still fetches ~150 feeds around its tagging
    // budget, and the fetching is not what the budget measures.
    expect(timeoutMs).toBeGreaterThanOrEqual(DEFAULT_INGEST_BUDGET_MS * 2);
  });

  // Replaced the n8n KB health monitor (2026-09-29): after the 02:30 ingest,
  // before the 06:00 digest, silent unless a canary fails
  it("runs the KB canaries daily at 05:00 as a script-mode job, alerting only on failure", () => {
    const canaryJob = jobs.find((job) => job.name === "pharmaitchat-kb-canary");
    expect(canaryJob).toMatchObject({
      schedule: "0 5 * * *",
      kind: "script",
      script: "pharmaitchat-kb-canary.sh",
      deliver: "local",
      failure_deliver: "telegram",
    });
    const wrapper = readFileSync(join(hermesDir, "scripts", "pharmaitchat-kb-canary.sh"), "utf-8");
    expect(wrapper).toContain("__PROJECT_DIR__");
    expect(wrapper).toContain("scripts/kb-canary.ts");
  });

  // Monday 07:30, clear of the daily 07:00 gap-resolution job that also uses the 27B.
  // Its stdout is the message, so it is delivered to Telegram every time.
  it("sends the weekly digest to Telegram on Monday mornings as a script-mode job", () => {
    expect(jobs.find((job) => job.name === "pharmaitchat-weekly-digest")).toMatchObject({
      schedule: "30 7 * * 1",
      kind: "script",
      script: "pharmaitchat-weekly-digest.sh",
      deliver: "telegram",
      failure_deliver: "telegram",
    });
    const wrapper = readFileSync(join(hermesDir, "scripts", "pharmaitchat-weekly-digest.sh"), "utf-8");
    expect(wrapper).toContain("__PROJECT_DIR__");
    expect(wrapper).toContain('scripts/digest.ts --request "digest of last week" --email');
    expect(wrapper).toContain("data/run/active-stack");
  });

  // Replaced the 06:00 "news digest" job (2026-09-30), which called the retired
  // news agent and reported "0 new articles" every morning. Tuesday to Friday:
  // Monday gets the weekly digest at the same time.
  it("sends a weekday briefing Tuesday to Friday at 07:30, silent on a quiet day", () => {
    expect(jobs.find((job) => job.name === "pharmaitchat-news-digest")).toBeUndefined();
    expect(jobs.find((job) => job.name === "pharmaitchat-daily-briefing")).toMatchObject({
      schedule: "30 7 * * 2-5",
      kind: "script",
      script: "pharmaitchat-daily-briefing.sh",
      deliver: "telegram",
      failure_deliver: "telegram",
    });
    const wrapper = readFileSync(join(hermesDir, "scripts", "pharmaitchat-daily-briefing.sh"), "utf-8");
    expect(wrapper).toContain('scripts/digest.ts --request "briefing of yesterday" --briefing --email');
  });

  it("ships the watchlist ingest's wrapper script next to jobs.json", () => {
    const scriptPath = join(hermesDir, "scripts", "pharmaitchat-watchlist-ingest.sh");
    const script = readFileSync(scriptPath, "utf-8");
    expect(script).toContain("__PROJECT_DIR__");
    expect(script).toContain("scripts/watchlist.ts ingest");
    expect(script).toContain("data/run/active-stack");
  });

  it("asks for the gap status the detector actually writes and forbids adding knowledge", () => {
    // gap_log rows start as 'triggered'/'skipped', never 'detected' (src/services/gap-detector.ts)
    expect(jobs[1].prompt).toContain("status triggered");
    expect(jobs[1].prompt).not.toContain("status detected");
    expect(jobs[1].prompt).toContain("Do not call add_knowledge");
    // The silent-exit clause must name the same status the job asked for
    expect(jobs[1].prompt).toContain("no triggered gaps");
    expect(jobs[1].prompt).not.toContain("no detected gaps");
  });

  it("asks the feedback digest for both report kinds", () => {
    expect(jobs[3].prompt).toContain("weekly_digest");
    expect(jobs[3].prompt).toContain("low_rated");
  });
});

describe("hermes/SOUL.md", () => {
  it("restricts knowledge-changing tools to explicit requests", () => {
    const soul = readFileSync(join(hermesDir, "SOUL.md"), "utf-8");
    for (const tool of ["add_knowledge", "run_news_agent", "resolve_knowledge_gap", "search_knowledge", "ask_pharmaitchat"]) {
      expect(soul).toContain(tool);
    }
    expect(soul).toContain("explicitly");
    expect(soul).toContain("Never add knowledge because");
  });
});
