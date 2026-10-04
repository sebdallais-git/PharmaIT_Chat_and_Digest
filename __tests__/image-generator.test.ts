import { describe, expect, it } from "@jest/globals";
import { generateImage, mfluxArgs, type GeneratorDeps, type ImageSpec } from "../src/services/image-generator.js";
import type { ProcessResult } from "../src/services/image-system.js";

// The generator with every machine reading faked: no mflux, no vm_stat, no ioreg.

const SPEC: ImageSpec = {
  jobId: "job-1",
  prompt: 'a lab "bench"; $(echo hi)',
  preset: "photo",
  size: "square",
  width: 1088,
  height: 1088,
  seed: 42,
  outputPath: "/work/job-1.png",
};

const IEND = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

function pngNoEnd(width: number, height: number): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dims = Buffer.alloc(8);
  dims.writeUInt32BE(width, 0);
  dims.writeUInt32BE(height, 4);
  return Buffer.concat([header, dims, Buffer.alloc(16)]);
}

function png(width: number, height: number): Buffer {
  return Buffer.concat([pngNoEnd(width, height), IEND]);
}

const OK_RUN: ProcessResult = { code: 0, signal: null, stderr: "        40.0 real\n  7000000000  maximum resident set size\n", timedOut: false };

function harness(over: { free?: number[]; gpu?: Array<number | null>; lockFree?: boolean[]; run?: ProcessResult; file?: Buffer | Error } = {}) {
  let clock = 0;
  const free = [...(over.free ?? [32])];
  const gpu = [...(over.gpu ?? [5])];
  const lockFree = [...(over.lockFree ?? [true])];
  const calls: Array<{ cmd: string; args: string[]; timeoutMs: number }> = [];
  const logs: string[] = [];
  let held = false;
  let releases = 0;
  const deps: GeneratorDeps = {
    limits: { minFreeGb: 10, waitMinutes: 1, timeoutSeconds: 300, steps: 4 },
    modelPath: "/models/flux-schnell-4bit",
    mfluxBin: "/venv/bin/mflux-generate",
    freeMemoryGb: async () => (free.length > 1 ? free.shift()! : free[0]),
    gpuBusyPercent: async () => (gpu.length > 1 ? gpu.shift()! : gpu[0]),
    lock: {
      acquire: () => {
        const ok = lockFree.length > 1 ? lockFree.shift()! : lockFree[0];
        if (ok) held = true;
        return ok;
      },
      release: () => {
        if (held) releases++;
        held = false;
      },
    },
    run: async (cmd, args, timeoutMs) => {
      calls.push({ cmd, args, timeoutMs });
      clock += 40_000;
      return over.run ?? OK_RUN;
    },
    readFile: async () => {
      const file = over.file ?? png(1088, 1088);
      if (file instanceof Error) throw file;
      return file;
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    log: (line) => logs.push(line),
  };
  return { deps, calls, logs, releases: () => releases, held: () => held };
}

describe("mfluxArgs", () => {
  // Review focus 1: the prompt is one argv element, whatever it contains
  it("runs mflux-generate under /usr/bin/time -l with the saved model, steps, size, seed and --low-ram", () => {
    const { deps } = harness();
    expect(mfluxArgs(SPEC, deps)).toEqual([
      "-l",
      "/venv/bin/mflux-generate",
      // mflux 0.21 (installed 2026-10-04): a saved model is passed as --model <dir> with its base named
      "--model", "/models/flux-schnell-4bit",
      "--base-model", "schnell",
      "--prompt", 'a lab "bench"; $(echo hi)',
      "--steps", "4",
      "--seed", "42",
      "--width", "1088",
      "--height", "1088",
      "--output", "/work/job-1.png",
      "--low-ram",
    ]);
  });
});

describe("generateImage", () => {
  it("draws when the gate is open, checks the PNG, logs duration and peak memory, releases the lock", async () => {
    const h = harness();
    const image = await generateImage(SPEC, h.deps);
    expect(image.peakBytes).toBe(7000000000);
    expect(image.ms).toBe(40_000);
    expect(h.calls[0]).toMatchObject({ cmd: "/usr/bin/time", timeoutMs: 300_000 });
    expect(h.releases()).toBe(1);
    const entry = JSON.parse(h.logs[0]) as Record<string, unknown>;
    expect(entry).toMatchObject({ jobId: "job-1", preset: "photo", size: "square", seed: 42, ms: 40000, peakGb: 6.52, outcome: "ok" });
    expect(entry.prompt).toBe(SPEC.prompt);
  });

  it("waits for memory, the GPU and the lock, re-checking every 15 s", async () => {
    // the GPU is read only once the lock is held and memory was read: 0 (with low memory), then 80, then 5
    const h = harness({ lockFree: [false, true, true, true], free: [4, 32, 32], gpu: [0, 80, 5] });
    await generateImage(SPEC, h.deps);
    expect(h.calls).toHaveLength(1);
    // lock busy, then low memory, then GPU busy, then go: three 15 s waits
    expect(h.deps.now()).toBe(45_000 + 40_000);
  });

  it("an unreadable GPU does not block: memory still gates", async () => {
    const h = harness({ gpu: [null] });
    await generateImage(SPEC, h.deps);
    expect(h.calls).toHaveLength(1);
  });

  it("gives up after wait_minutes with the numbers, without drawing", async () => {
    const h = harness({ free: [6.8] });
    await expect(generateImage(SPEC, h.deps)).rejects.toThrow("gave up after 1 min: not enough memory: 6.8 GB free, need 10");
    expect(h.calls).toEqual([]);
    expect(h.releases()).toBeGreaterThan(0);
    expect(h.held()).toBe(false);
  });

  it("reports a timeout, a failed exit with mflux's own error line, and bad output; always releases the lock", async () => {
    const timeout = harness({ run: { code: null, signal: null, stderr: "", timedOut: true } });
    await expect(generateImage(SPEC, timeout.deps)).rejects.toThrow("image model timed out after 300 s");
    expect(timeout.held()).toBe(false);

    const failed = harness({ run: { code: 1, signal: null, stderr: "Error: out of memory\n        3.0 real         1.0 user         0.5 sys\n", timedOut: false } });
    await expect(generateImage(SPEC, failed.deps)).rejects.toThrow("image model failed: Error: out of memory");
    expect(JSON.parse(failed.logs[0])).toMatchObject({ outcome: "image model failed: Error: out of memory" });

    // Review focus 4: exit 0 with no file, a non-PNG, or the wrong size
    for (const file of [new Error("ENOENT"), Buffer.from("garbage garbage garbage"), png(1024, 1024), pngNoEnd(1088, 1088)]) {
      const bad = harness({ file });
      await expect(generateImage(SPEC, bad.deps)).rejects.toThrow("bad image output");
      expect(bad.held()).toBe(false);
    }
  });

  it("a log that throws changes neither a drawn image nor a draw's own error", async () => {
    const ok = harness();
    ok.deps.log = () => {
      throw new Error("ENOSPC");
    };
    const image = await generateImage(SPEC, ok.deps);
    expect(image.png.length).toBeGreaterThan(0);

    const failing = harness({ run: { code: 1, signal: null, stderr: "boom", timedOut: false } });
    failing.deps.log = () => {
      throw new Error("ENOSPC");
    };
    const err = await generateImage(SPEC, failing.deps).catch((e: unknown) => e);
    expect(String(err)).toContain("image model failed");
    expect(String(err)).not.toContain("ENOSPC");
  });
});
