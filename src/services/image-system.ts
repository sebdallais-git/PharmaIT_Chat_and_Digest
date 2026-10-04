// How the image generator reads and drives the machine: free memory, a lock
// shared by every process that may draw, the mflux process itself, and the
// checks on what it produced. Kept apart from the generator so the generator
// can be tested with fakes and these with captured text.

import { execFile, spawn } from "node:child_process";
import { linkSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
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

// An unparsable or empty lock file may be another writer mid-write: only a
// file this old is treated as abandoned.
const UNPARSABLE_LOCK_STALE_MS = 10_000;

function validPid(text: string): number | null {
  const pid = Number(text.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * One drawer at a time across the app and the scripts; a dead owner's lock is
 * taken over. The lock file never exists without its pid (published by hard
 * link from a complete temp file) and a stale lock is claimed by rename, so
 * two racers cannot both end up holding it.
 */
export function fileLock(path: string, isAlive: (pid: number) => boolean = processAlive): ImageLock {
  let held = false;
  const unique = (tag: string) => `${path}.${tag}.${process.pid}.${randomUUID()}`;
  const remove = (file: string) => {
    try {
      unlinkSync(file);
    } catch {
      // Already gone
    }
  };
  const publish = (): boolean => {
    const temp = unique("tmp");
    try {
      writeFileSync(temp, `${process.pid}\n`, { flag: "wx" });
      linkSync(temp, path); // EEXIST when a lock exists
      return true;
    } catch {
      return false;
    } finally {
      remove(temp);
    }
  };
  return {
    acquire() {
      if (held) return true;
      if (publish()) return (held = true);
      let text: string;
      try {
        text = readFileSync(path, "utf-8");
      } catch {
        return (held = publish()); // Released between our attempt and this read
      }
      const owner = validPid(text);
      if (owner !== null) {
        if (isAlive(owner)) return false;
      } else {
        try {
          if (Date.now() - statSync(path).mtimeMs < UNPARSABLE_LOCK_STALE_MS) return false;
        } catch {
          return (held = publish());
        }
      }
      // Claim the stale lock: only one racer's rename succeeds
      const claimed = unique("stale");
      try {
        renameSync(path, claimed);
      } catch {
        return false;
      }
      let claimedText = "";
      try {
        claimedText = readFileSync(claimed, "utf-8");
      } catch {
        // Treated as stale below
      }
      const current = validPid(claimedText);
      if (current !== null && isAlive(current)) {
        // The lock changed hands after our first read: put it back
        try {
          linkSync(claimed, path);
        } catch {
          // A newer lock already exists
        }
        remove(claimed);
        return false;
      }
      remove(claimed);
      return (held = publish());
    },
    release() {
      if (!held) return;
      held = false;
      remove(path);
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
