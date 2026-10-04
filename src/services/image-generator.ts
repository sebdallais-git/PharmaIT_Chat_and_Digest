// Draws one image with FLUX.1-schnell (mflux), one process per image.
//
// The risk this guards against is the one this Mac has shown: the GPU runs
// out of memory under a burst, the 27B's generation thread dies and every
// request hangs until the watchdog restarts it. So an image starts only when
// it holds the lock, enough memory is free and the GPU is not busy; it waits
// (re-checking every 15 s) up to wait_minutes, then fails with the numbers.
// The process runs under /usr/bin/time -l so every image reports its peak
// memory, which is what min_free_gb gets tuned from.

import { GPU_BUSY_PERCENT } from "./health.js";
import { parsePeakBytes, pngDimensions, toolError, type ImageLock, type ProcessResult } from "./image-system.js";

const RECHECK_MS = 15_000;
const GIB = 1024 ** 3;

export interface ImageSpec {
  jobId: string;
  prompt: string;
  preset: string;
  size: string;
  width: number;
  height: number;
  seed: number;
  outputPath: string;
}

export interface GeneratedImage {
  png: Buffer;
  ms: number;
  peakBytes: number | null;
}

export interface GeneratorDeps {
  limits: { minFreeGb: number; waitMinutes: number; timeoutSeconds: number; steps: number };
  modelPath: string;
  mfluxBin: string;
  freeMemoryGb(): Promise<number>;
  // null when unreadable: the memory gate still applies
  gpuBusyPercent(): Promise<number | null>;
  lock: ImageLock;
  run(cmd: string, args: string[], timeoutMs: number): Promise<ProcessResult>;
  readFile(path: string): Promise<Buffer>;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(line: string): void;
}

/** argv for /usr/bin/time: the prompt stays one element, whatever it contains. */
export function mfluxArgs(spec: ImageSpec, deps: Pick<GeneratorDeps, "limits" | "modelPath" | "mfluxBin">): string[] {
  return [
    "-l",
    deps.mfluxBin,
    // mflux 0.21+: a saved (quantized) model folder is the --model, its base named explicitly
    "--model", deps.modelPath,
    "--base-model", "schnell",
    "--prompt", spec.prompt,
    "--steps", String(deps.limits.steps),
    "--seed", String(spec.seed),
    "--width", String(spec.width),
    "--height", String(spec.height),
    "--output", spec.outputPath,
    "--low-ram",
  ];
}

async function draw(spec: ImageSpec, deps: GeneratorDeps): Promise<GeneratedImage> {
  const start = deps.now();
  const result = await deps.run("/usr/bin/time", mfluxArgs(spec, deps), deps.limits.timeoutSeconds * 1000);
  if (result.timedOut) throw new Error(`image model timed out after ${deps.limits.timeoutSeconds} s`);
  if (result.code !== 0) throw new Error(`image model failed: ${toolError(result.stderr)}`);
  let png: Buffer;
  try {
    png = await deps.readFile(spec.outputPath);
  } catch {
    throw new Error("bad image output: no file written");
  }
  const size = pngDimensions(png);
  if (size === null || size.width !== spec.width || size.height !== spec.height) {
    throw new Error(`bad image output: expected a ${spec.width}×${spec.height} PNG`);
  }
  return { png, ms: deps.now() - start, peakBytes: parsePeakBytes(result.stderr) };
}

export async function generateImage(spec: ImageSpec, deps: GeneratorDeps): Promise<GeneratedImage> {
  const deadline = deps.now() + deps.limits.waitMinutes * 60_000;
  // Logging is best-effort: a failed write must never change the outcome of a draw
  const record = (outcome: string, image?: GeneratedImage): void => {
    try {
      deps.log(
      JSON.stringify({
        at: new Date().toISOString(),
        jobId: spec.jobId,
        preset: spec.preset,
        size: spec.size,
        seed: spec.seed,
        ms: image?.ms ?? null,
        peakGb: image?.peakBytes != null ? Math.round((image.peakBytes / GIB) * 100) / 100 : null,
        outcome,
        prompt: spec.prompt,
      }),
      );
    } catch {
      // ignored on purpose
    }
  };

  for (;;) {
    let reason = "another image is being drawn";
    if (deps.lock.acquire()) {
      try {
        const free = await deps.freeMemoryGb();
        const gpu = await deps.gpuBusyPercent();
        if (free >= deps.limits.minFreeGb && (gpu === null || gpu < GPU_BUSY_PERCENT)) {
          try {
            const image = await draw(spec, deps);
            record("ok", image);
            return image;
          } catch (err) {
            record(err instanceof Error ? err.message : String(err));
            throw err;
          }
        }
        reason =
          free < deps.limits.minFreeGb
            ? `not enough memory: ${free.toFixed(1)} GB free, need ${deps.limits.minFreeGb}`
            : `GPU busy (${gpu}%)`;
      } finally {
        deps.lock.release();
      }
    }
    if (deps.now() >= deadline) throw new Error(`gave up after ${deps.limits.waitMinutes} min: ${reason}`);
    await deps.sleep(RECHECK_MS);
  }
}
