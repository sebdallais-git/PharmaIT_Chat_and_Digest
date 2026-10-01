// For tests that spawn bash scripts with an env of their own (PATH=/usr/bin:/bin has no node):
// scripts/lib/host.sh needs a node binary and a host profile to read.
import { join } from "node:path";

export const HOST_FIXTURE = join(process.cwd(), "__tests__", "fixtures", "host.yaml");

export function hostTestEnv(): { NODE_BIN: string; PHARMAITCHAT_HOST_CONFIG: string } {
  return { NODE_BIN: process.execPath, PHARMAITCHAT_HOST_CONFIG: HOST_FIXTURE };
}
