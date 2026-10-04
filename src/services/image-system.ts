// How the image generator reads and drives the machine: free memory, a lock
// shared by every process that may draw, the mflux process itself, and the
// checks on what it produced. Kept apart from the generator so the generator
// can be tested with fakes and these with captured text.

import { execFile, spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

const GIB = 1024 ** 3;

export function imageModelPath(root: string, quantize: number): string {
  return join(root, "data", "models", `flux-schnell-${quantize}bit`);
}

export function mfluxBinary(root: string): string {
  return join(root, ".venv-image", "bin", "mflux-generate");
}

/** GiB the system can hand out now: free + inactive + purgeable pages (vm_stat). */
export function parseFreeGb(vmStat: string): number {
  const pageSize = Number(/page size of (\d+) bytes/.exec(vmStat)?.[1] ?? 16384);
  const pages = (label: string) => Number(new RegExp(`Pages ${label}:\\s+(\\d+)`).exec(vmStat)?.[1] ?? 0);
  return ((pages("free") + pages("inactive") + pages("purgeable")) * pageSize) / GIB;
}

export function readFreeMemoryGb(): Promise<number> {
  return new Promise((resolveGb, reject) => {
    execFile("vm_stat", [], { timeout: 3000 }, (err, stdout) => (err ? reject(err) : resolveGb(parseFreeGb(stdout))));
  });
}

// /usr/bin/time -l appends "  <n>  maximum resident set size" (bytes on macOS)
export function parsePeakBytes(stderr: string): number | null {
  const match = /^\s*(\d+)\s+maximum resident set size/m.exec(stderr);
  return match ? Number(match[1]) : null;
}

/** The tool's own last stderr line, before /usr/bin/time's statistics. */
export function toolError(stderr: string): string {
  const lines = stderr.split("\n");
  const statsAt = lines.findIndex((line) => /^\s*[\d.]+ real\s/.test(line));
  const own = (statsAt >= 0 ? lines.slice(0, statsAt) : lines).map((l) => l.trim()).filter((l) => l !== "");
  return own.at(-1) ?? "no error output";
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function pngDimensions(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

export interface ImageLock {
  acquire(): boolean;
  release(): void;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** One drawer at a time across the app and the scripts; a dead owner's lock is taken over. */
export function fileLock(path: string, isAlive: (pid: number) => boolean = processAlive): ImageLock {
  let held = false;
  const create = (): boolean => {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return true;
    } catch {
      return false;
    }
  };
  return {
    acquire() {
      if (held) return true;
      if (create()) return (held = true);
      let owner = Number.NaN;
      try {
        owner = Number(readFileSync(path, "utf-8").trim());
      } catch {
        // Gone between our attempt and this read: try once more below
      }
      if (Number.isInteger(owner) && owner > 0 && isAlive(owner)) return false;
      try {
        unlinkSync(path);
      } catch {
        // Another process took it over first
      }
      return (held = create());
    },
    release() {
      if (!held) return;
      held = false;
      try {
        unlinkSync(path);
      } catch {
        // Already gone
      }
    },
  };
}

export interface ProcessResult {
  code: number | null;
  signal: string | null;
  stderr: string;
  timedOut: boolean;
}

/**
 * Runs cmd with args as argv (never through a shell), in its own process
 * group, and kills the whole group at the timeout so no child outlives it.
 */
export function runProcess(cmd: string, args: string[], timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolveResult) => {
    const child = spawn(cmd, args, { detached: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let timedOut = false;
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already exited
      }
    }, timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveResult({ code: timedOut ? null : code, signal: timedOut ? null : signal, stderr, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolveResult({ code: null, signal: null, stderr: err.message, timedOut: false });
    });
  });
}
