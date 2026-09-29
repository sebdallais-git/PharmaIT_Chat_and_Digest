import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeSwitch, formatCountdown, isStackSelectDisabled, stackOptionState } from "../src/services/switch-labels.js";
import { STACK_NAMES } from "../src/config/llm-stacks.js";
import type { SwitchStatus } from "../src/services/switch-labels.js";

// F2: one case per branch of describeSwitch — confirmed, stopping, starting, warming, indexing,
// ready, failed, pending, and the no-progress default — so the module and the extracted browser
// copy are driven from the exact same list and can never quietly disagree about which cases exist.
// (Before this fix, "confirmed" and "starting" were branches of both PHASE_TEXT/text but neither
// was ever exercised by the drift test.)
const cases: SwitchStatus[] = [
  { active: "mlx", pending: null, progress: null },
  { active: "ollama", pending: { target: "omlx", expires_at: 0 }, progress: null },
  { active: "ollama", pending: null, progress: { phase: "confirmed", target: "omlx", previous: "ollama", startedAt: 0 } },
  { active: "ollama", pending: null, progress: { phase: "stopping", target: "omlx", previous: "ollama", startedAt: 0 } },
  { active: "ollama", pending: null, progress: { phase: "starting", target: "omlx", previous: "ollama", startedAt: 0 } },
  { active: "ollama", pending: null, progress: { phase: "warming", target: "omlx", previous: "ollama", startedAt: 0 } },
  { active: "ollama", pending: null, progress: { phase: "indexing", target: "omlx", previous: "ollama", startedAt: 0 } },
  {
    active: "omlx",
    pending: null,
    progress: { phase: "ready", target: "omlx", previous: "ollama", startedAt: 1_000, finishedAt: 97_000 },
  },
  {
    active: "ollama",
    pending: null,
    progress: { phase: "failed", target: "omlx", previous: "ollama", startedAt: 0, error: "omlx did not come up" },
  },
];

describe("describeSwitch", () => {
  it("names the active stack when nothing is happening", () => {
    expect(describeSwitch({ active: "mlx", pending: null, progress: null })).toBe("MLX stack active");
  });

  it("asks the user to confirm while a request is pending", () => {
    expect(
      describeSwitch({ active: "ollama", pending: { target: "omlx", expires_at: 0 }, progress: null })
    ).toBe("Confirm the switch to OMLX in Telegram");
  });

  it("describes each phase of a running switch", () => {
    const base = { active: "ollama" as const, pending: null };
    expect(describeSwitch({ ...base, progress: { phase: "confirmed", target: "omlx", previous: "ollama", startedAt: 0 } }))
      .toBe("Switching to OMLX: starting");
    expect(describeSwitch({ ...base, progress: { phase: "stopping", target: "omlx", previous: "ollama", startedAt: 0 } }))
      .toBe("Switching to OMLX: stopping the current stack");
    expect(describeSwitch({ ...base, progress: { phase: "starting", target: "omlx", previous: "ollama", startedAt: 0 } }))
      .toBe("Switching to OMLX: starting the server");
    expect(describeSwitch({ ...base, progress: { phase: "warming", target: "omlx", previous: "ollama", startedAt: 0 } }))
      .toBe("Switching to OMLX: warming up the model");
    expect(describeSwitch({ ...base, progress: { phase: "indexing", target: "omlx", previous: "ollama", startedAt: 0 } }))
      .toBe("Switching to OMLX: checking the indexes");
  });

  it("reports readiness with the elapsed time", () => {
    expect(
      describeSwitch({
        active: "omlx",
        pending: null,
        progress: { phase: "ready", target: "omlx", previous: "ollama", startedAt: 1_000, finishedAt: 97_000 },
      })
    ).toBe("OMLX stack ready (96 s)");
  });

  it("reports a failure with its reason", () => {
    expect(
      describeSwitch({
        active: "ollama",
        pending: null,
        progress: { phase: "failed", target: "omlx", previous: "ollama", startedAt: 0, error: "omlx did not come up" },
      })
    ).toBe("Switch to OMLX failed: omlx did not come up");
  });

  // Amendment B: the browser cannot import TypeScript, so public/app.js keeps a second, literal
  // copy of this wording (describeStackStatus). This test fails if either copy changes a word.
  it("keeps the browser copy of the wording identical to the module", () => {
    const describeStackStatus = loadBrowserFunction("describeStackStatus") as (status: unknown) => string;
    for (const status of cases) {
      expect(describeStackStatus(status)).toBe(describeSwitch(status));
    }
  });
});

describe("formatCountdown", () => {
  it("formats remaining milliseconds as m:ss, floored to the second", () => {
    expect(formatCountdown(277_000)).toBe("4:37");
    expect(formatCountdown(65_000)).toBe("1:05");
  });

  it("floors a negative remainder at 0:00", () => {
    expect(formatCountdown(-5_000)).toBe("0:00");
  });

  // F4: exactly one minute, and past an hour. Minutes do NOT roll over into an hours component —
  // pinned here so that stays a deliberate choice rather than an untested accident.
  it("formats exactly one minute as 1:00", () => {
    expect(formatCountdown(60_000)).toBe("1:00");
  });

  it("does not roll minutes over into hours past 60 minutes", () => {
    expect(formatCountdown(3_600_000)).toBe("60:00");
  });

  // Amendment C: the browser keeps a literal copy of this helper too, guarded the same way as B.
  it("keeps the browser copy of the countdown formatter identical to the module", () => {
    const browserFormatCountdown = loadBrowserFunction("formatCountdown") as (msRemaining: number) => string;
    for (const ms of [277_000, 65_000, -5_000, 0, 599_000, 60_000, 3_600_000]) {
      expect(browserFormatCountdown(ms)).toBe(formatCountdown(ms));
    }
  });
});

describe("isStackSelectDisabled", () => {
  // F1: the selector must stay disabled for the whole switch, not just while a Telegram
  // confirmation is pending. `confirm()` clears `pending` the instant the link is tapped, so a
  // client-side gate keyed on `pending` alone went live again while the script was still
  // stopping/starting model servers — this is the one place that combines "is this browser busy
  // following its own switch" with the server-reported state to decide the disabled attribute.
  it("disables while busy even when nothing is pending", () => {
    expect(isStackSelectDisabled({ pending: null, telegram_configured: true, hermes_ready: true }, true)).toBe(true);
  });

  it("stays enabled when idle, nothing pending, and Telegram is configured", () => {
    expect(isStackSelectDisabled({ pending: null, telegram_configured: true, hermes_ready: true }, false)).toBe(false);
  });

  it("disables while a confirmation is pending, even if the caller thinks it is not busy", () => {
    expect(
      isStackSelectDisabled({ pending: { target: "omlx", expires_at: 0 }, telegram_configured: true, hermes_ready: true }, false)
    ).toBe(true);
  });

  it("disables when Telegram is not configured", () => {
    expect(isStackSelectDisabled({ pending: null, telegram_configured: false, hermes_ready: true }, false)).toBe(true);
  });

  it("disables the selector when Hermes cannot receive the confirmation", () => {
    expect(isStackSelectDisabled({ pending: null, telegram_configured: true, hermes_ready: false }, false)).toBe(true);
  });

  it("keeps the browser copy identical to the module", () => {
    const browserIsStackSelectDisabled = loadBrowserFunction("isStackSelectDisabled") as (
      status: unknown,
      busy: boolean
    ) => boolean;
    const statuses = [
      { pending: null, telegram_configured: true, hermes_ready: true },
      { pending: null, telegram_configured: false, hermes_ready: true },
      { pending: { target: "omlx" as const, expires_at: 0 }, telegram_configured: true, hermes_ready: true },
      { pending: null, telegram_configured: true, hermes_ready: false },
    ];
    for (const status of statuses) {
      for (const busy of [true, false]) {
        expect(browserIsStackSelectDisabled(status, busy)).toBe(isStackSelectDisabled(status, busy));
      }
    }
  });
});

// F3: deciding whether a progress record belongs to the switch this browser asked for used to
// compare the server's startedAt against the browser's own Date.now(). The owner taps the Telegram
// link from an iPad over Tailscale, and an iPad clock even slightly ahead of the Mac's made every
// record look older than the request: the UI never recognised its own switch, the countdown ran
// out and it reported "Switch request expired" for a switch that had actually succeeded. The
// browser now remembers the startedAt it last saw from /api/stack/status and treats any different
// one as its own, so only server-supplied values are ever compared.
describe("isOurSwitchProgress", () => {
  // Loaded per test (loadBrowserFunction asserts), so a change to the helper fails the cases it
  // breaks rather than taking the whole suite down with it.
  const isOurSwitchProgress = (progress: unknown, baselineStartedAt: number | null): boolean =>
    (loadBrowserFunction("isOurSwitchProgress") as (p: unknown, b: number | null) => boolean)(
      progress,
      baselineStartedAt
    );
  const progress = (startedAt: number): unknown => ({
    phase: "warming",
    target: "omlx",
    previous: "mlx",
    startedAt,
  });

  it("is not ours while the server still shows the record that was there when we asked", () => {
    expect(isOurSwitchProgress(progress(1_700_000_000_000), 1_700_000_000_000)).toBe(false);
  });

  it("is ours as soon as a different record appears", () => {
    expect(isOurSwitchProgress(progress(1_700_000_000_500), 1_700_000_000_000)).toBe(true);
  });

  it("is ours on the first ever switch, when there was no progress to capture", () => {
    expect(isOurSwitchProgress(progress(1_700_000_000_000), null)).toBe(true);
  });

  it("is not ours when the server reports no progress at all", () => {
    expect(isOurSwitchProgress(null, null)).toBe(false);
    expect(isOurSwitchProgress(undefined, 1_700_000_000_000)).toBe(false);
  });

  // The whole point of the fix: a record the Mac stamped *before* this browser's clock reading is
  // still ours. Under the old `startedAt >= watchSince` rule this was the failing case.
  it("is ours even when the server's timestamp precedes the browser's idea of now", () => {
    expect(isOurSwitchProgress(progress(1_699_999_999_000), 1_700_000_000_000)).toBe(true);
  });
});

// Extracts one top-level function's source out of public/app.js and evaluates it in isolation, so
// the drift tests above never load or execute the rest of the browser script (which touches the
// DOM and fetch, neither available under Jest's node test environment).
function loadBrowserFunction(name: string): (...args: unknown[]) => unknown {
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  const body = source.slice(start, end + 2);
  return new Function(`${body}; return ${name};`)() as (...args: unknown[]) => unknown;
}

describe("the browser stack selector", () => {
  const appJs = readFileSync(join(process.cwd(), "public", "app.js"), "utf8");

  // Without an entry the UI falls back to the raw lowercase name, so the
  // selector reads "splash" beside "Ollama", "MLX" and "oMLX".
  it("has a display label for every stack", () => {
    const block = appJs.match(/const STACK_LABELS = \{([^}]*)\}/)?.[1] ?? "";

    for (const stack of STACK_NAMES) {
      expect(block).toMatch(new RegExp(`\\b${stack}\\s*:`));
    }
  });
});

// A stack the switch script says cannot start is shown disabled with the reason,
// so nobody picks Splash only to be told Xcode is missing
describe("stackOptionState", () => {
  const availability = {
    mlx: { available: true },
    splash: { available: false, reason: "Splash cannot build its engine: Xcode is missing" },
  };
  const cases = [
    { name: "splash", status: { active: "mlx", availability } },
    { name: "mlx", status: { active: "mlx", availability } },
    { name: "ollama", status: { active: "mlx", availability } },
    { name: "splash", status: { active: "splash", availability } },
    { name: "splash", status: { active: "mlx", availability: null } },
  ];

  it("disables an unavailable stack and gives the reason", () => {
    expect(stackOptionState("splash", { active: "mlx", availability })).toEqual({
      disabled: true,
      title: "Splash cannot build its engine: Xcode is missing",
    });
  });

  it("leaves available, unlisted and active stacks selectable, and everything when availability is unknown", () => {
    expect(stackOptionState("mlx", { active: "mlx", availability })).toEqual({ disabled: false, title: null });
    expect(stackOptionState("ollama", { active: "mlx", availability })).toEqual({ disabled: false, title: null });
    expect(stackOptionState("splash", { active: "splash", availability })).toEqual({ disabled: false, title: null });
    expect(stackOptionState("splash", { active: "mlx", availability: null })).toEqual({ disabled: false, title: null });
  });

  it("keeps the browser copy identical to the module", () => {
    const browser = loadBrowserFunction("stackOptionState") as (name: string, status: unknown) => unknown;
    for (const c of cases) expect(browser(c.name, c.status)).toEqual(stackOptionState(c.name, c.status as never));
  });
});
