import { afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostTestEnv } from "./helpers/host-env.js";

// The setup script with `uv` and the mflux commands stubbed: no venv is really
// created, nothing is downloaded. The stubs record what they were asked.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function box(opts: { helpLacks?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "setup-image-"));
  dirs.push(root);
  const bin = join(root, "stub-bin");
  mkdirSync(bin);
  const calls = join(root, "calls.log");
  // uv: "venv <dir> ..." creates the venv's bin with mflux stubs; "pip install ..." is recorded
  const help = ["--model", "--path", "--prompt", "--steps", "--seed", "--width", "--height", "--output", "--low-ram"]
    .filter((f) => f !== opts.helpLacks)
    .join(" ");
  writeFileSync(
    join(bin, "uv"),
    `#!/bin/bash
echo "uv $*" >> "${calls}"
if [ "$1" = venv ]; then
  mkdir -p "$2/bin"
  printf '#!/bin/bash\\necho "${help}"\\n' > "$2/bin/mflux-generate"
  printf '#!/bin/bash\\necho "mflux-save $*" >> "${calls}"\\nwhile [ $# -gt 0 ]; do [ "$1" = --path ] && mkdir -p "$2" && touch "$2/model.safetensors"; shift; done\\n' > "$2/bin/mflux-save"
  chmod +x "$2/bin/mflux-generate" "$2/bin/mflux-save"
fi
`,
  );
  chmodSync(join(bin, "uv"), 0o755);
  const run = () =>
    spawnSync("bash", [join(process.cwd(), "scripts", "setup-image-model.sh")], {
      encoding: "utf-8",
      env: { ...hostTestEnv(), PATH: `${bin}:/usr/bin:/bin`, IMAGE_ROOT: root, UV_BIN: join(bin, "uv"), HOME: root },
    });
  return { root, calls, run };
}

describe("scripts/setup-image-model.sh", () => {
  it("creates .venv-image, installs mflux, checks its flags and saves the quantized model", () => {
    const b = box();
    const result = b.run();
    expect(result.status).toBe(0);
    const log = readFileSync(b.calls, "utf-8");
    expect(log).toContain(`uv venv ${join(b.root, ".venv-image")} --python 3.12`);
    expect(log).toMatch(/uv pip install --python .*\.venv-image\/bin\/python mflux/);
    expect(log).toContain(`mflux-save --model schnell --quantize 4 --path ${join(b.root, "data", "models", "flux-schnell-4bit.partial")}`);
    expect(existsSync(join(b.root, "data", "models", "flux-schnell-4bit", "model.safetensors"))).toBe(true);
    expect(existsSync(join(b.root, "data", "models", "flux-schnell-4bit.partial"))).toBe(false);
    expect(result.stdout).toContain("image model ready");
  });

  it("redoes the save when an interrupted one left a .partial folder", () => {
    const b = box();
    expect(b.run().status).toBe(0);
    const models = join(b.root, "data", "models");
    rmSync(join(models, "flux-schnell-4bit"), { recursive: true });
    mkdirSync(join(models, "flux-schnell-4bit.partial"));
    writeFileSync(join(models, "flux-schnell-4bit.partial", "half.safetensors"), "x");
    const result = b.run();
    expect(result.status).toBe(0);
    expect(readFileSync(b.calls, "utf-8").match(/mflux-save/g)).toHaveLength(2);
    expect(existsSync(join(models, "flux-schnell-4bit", "model.safetensors"))).toBe(true);
    expect(existsSync(join(models, "flux-schnell-4bit", "half.safetensors"))).toBe(false);
    expect(existsSync(join(models, "flux-schnell-4bit.partial"))).toBe(false);
    expect(result.stdout).toContain("image model ready");
  });

  it("is a no-op the second time", () => {
    const b = box();
    expect(b.run().status).toBe(0);
    const second = b.run();
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("already set up");
    expect(readFileSync(b.calls, "utf-8").match(/mflux-save/g)).toHaveLength(1);
  });

  it("stops before downloading when the installed mflux lacks a flag the generator uses", () => {
    const b = box({ helpLacks: "--low-ram" });
    const result = b.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("mflux-generate does not support --low-ram");
    expect(readFileSync(b.calls, "utf-8")).not.toContain("mflux-save");
  });
});
