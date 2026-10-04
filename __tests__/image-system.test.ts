import { afterEach, describe, expect, it } from "@jest/globals";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fileLock,
  imageModelPath,
  mfluxBinary,
  parseFreeGb,
  parsePeakBytes,
  pngDimensions,
  runProcess,
  toolError,
} from "../src/services/image-system.js";

// The pieces the image generator reads the machine through. Live readers
// (vm_stat, ioreg, mflux) are never called here: parsers get captured text,
// the process runner gets a trivial local `sh`.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "image-system-"));
  dirs.push(dir);
  return dir;
};

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               65536.
Pages active:                            900000.
Pages inactive:                          131072.
Pages speculative:                         1000.
Pages purgeable:                          65536.
`;

const TIME_STDERR = `loading model
Error: something broke in mflux
        42.17 real        30.01 user         5.02 sys
          7516192768  maximum resident set size
                   0  average shared memory size
`;

function png(width: number, height: number): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dims = Buffer.alloc(8);
  dims.writeUInt32BE(width, 0);
  dims.writeUInt32BE(height, 4);
  return Buffer.concat([header, dims, Buffer.alloc(16)]);
}

describe("parsers", () => {
  it("free memory counts free + inactive + purgeable pages at the stated page size", () => {
    // (65536 + 131072 + 65536) × 16384 bytes = 4 GiB
    expect(parseFreeGb(VM_STAT)).toBeCloseTo(4, 5);
  });

  it("reads peak memory and the tool's own last error line from /usr/bin/time -l output", () => {
    expect(parsePeakBytes(TIME_STDERR)).toBe(7516192768);
    expect(parsePeakBytes("no stats")).toBeNull();
    expect(toolError(TIME_STDERR)).toBe("Error: something broke in mflux");
    expect(toolError("")).toBe("no error output");
  });

  it("reads a PNG's size from its header, and nothing from a non-PNG or truncated file", () => {
    expect(pngDimensions(png(1088, 1360))).toEqual({ width: 1088, height: 1360 });
    expect(pngDimensions(Buffer.from("not a png at all, not at all"))).toBeNull();
    expect(pngDimensions(png(1088, 1088).subarray(0, 20))).toBeNull();
  });

  it("names the model folder after its quantization and the venv's mflux-generate", () => {
    expect(imageModelPath("/r", 4)).toBe("/r/data/models/flux-schnell-4bit");
    expect(mfluxBinary("/r")).toBe("/r/.venv-image/bin/mflux-generate");
  });
});

describe("fileLock", () => {
  it("is held by one owner at a time and released", () => {
    const path = join(temp(), "image.lock");
    const a = fileLock(path, () => true);
    const b = fileLock(path, () => true);
    expect(a.acquire()).toBe(true);
    expect(readFileSync(path, "utf-8").trim()).toBe(String(process.pid));
    expect(b.acquire()).toBe(false);
    a.release();
    expect(existsSync(path)).toBe(false);
    expect(b.acquire()).toBe(true);
    b.release();
  });

  // Review focus 2: a crash leaves the file behind
  it("takes over a lock whose owner is dead", () => {
    const path = join(temp(), "image.lock");
    writeFileSync(path, "999999\n");
    expect(fileLock(path, (pid) => pid !== 999999).acquire()).toBe(true);
  });
});

describe("fileLock hardening", () => {
  it("takes over an empty lock file only once it is older than 10 seconds", () => {
    const fresh = join(temp(), "image.lock");
    writeFileSync(fresh, "");
    expect(fileLock(fresh, () => true).acquire()).toBe(false);

    const old = join(temp(), "image.lock");
    writeFileSync(old, "");
    const past = new Date(Date.now() - 60_000);
    utimesSync(old, past, past);
    expect(fileLock(old, () => true).acquire()).toBe(true);
  });

  it("gives a lock back when its owner is alive at verification time", () => {
    const path = join(temp(), "image.lock");
    writeFileSync(path, "4242\n");
    let calls = 0;
    const lock = fileLock(path, () => ++calls > 1);
    expect(lock.acquire()).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe("4242\n");
    expect(readdirSync(join(path, "..")).sort()).toEqual(["image.lock"]);
  });

  it("is idempotent for its holder and cannot release another's lock", () => {
    const path = join(temp(), "image.lock");
    const a = fileLock(path, () => true);
    expect(a.acquire()).toBe(true);
    expect(a.acquire()).toBe(true);
    expect(readFileSync(path, "utf-8").trim()).toBe(String(process.pid));
    fileLock(path, () => true).release();
    expect(existsSync(path)).toBe(true);
    a.release();
    expect(existsSync(path)).toBe(false);
  });
});

describe("runProcess", () => {
  // Review focus 1: args are argv elements, never shell text
  it("passes each argument as-is, collects stderr and the exit code", async () => {
    const result = await runProcess("/bin/sh", ["-c", 'printf "%s" "$1" >&2; exit 3', "sh", `quote " ; $(rm -rf /) end`], 5000);
    expect(result).toEqual({ code: 3, signal: null, stderr: `quote " ; $(rm -rf /) end`, timedOut: false });
  });

  it("kills the whole process group at the timeout", async () => {
    const result = await runProcess("/bin/sh", ["-c", "sleep 30 & sleep 30"], 300);
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
  });
});
