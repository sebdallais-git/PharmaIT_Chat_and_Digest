// For tests that spawn bash scripts with an env of their own (PATH=/usr/bin:/bin has no node):
// scripts/lib/host.sh needs a node binary (HOST_NODE_BIN, which wins over NODE_BIN so a test's placeholder NODE_BIN for a plist is untouched) and a host profile to read.
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export const HOST_FIXTURE = join(process.cwd(), "__tests__", "fixtures", "host.yaml");

export function hostTestEnv(): { HOST_NODE_BIN: string; PHARMAITCHAT_HOST_CONFIG: string } {
  return { HOST_NODE_BIN: process.execPath, PHARMAITCHAT_HOST_CONFIG: HOST_FIXTURE };
}

// One exported host-profile value as the scripts see it (sources scripts/lib/host.sh against the
// fixture). For tests that used to read a literal out of a script's text.
export function hostVar(name: string): string {
  const result = spawnSync("bash", ["-c", `source "$1"; printf %s "\${!2}"`, "bash", join(process.cwd(), "scripts", "lib", "host.sh"), name], {
    encoding: "utf-8",
    env: { PATH: "/usr/bin:/bin", ...hostTestEnv() },
  });
  if (result.status !== 0 || result.stdout === "") throw new Error(`host profile has no ${name}: ${result.stderr}`);
  return result.stdout;
}
