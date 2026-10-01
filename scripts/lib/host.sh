#!/usr/bin/env bash
# Exports the host profile (config/host.yaml) -- ports and machine-sized limits -- as env vars.
# Source this file; don't execute it. A variable already set in the environment keeps its value.
# Exits the calling script when the profile is invalid or node is missing: a script that went on
# with empty ports would start servers on the wrong port or probe nothing.
# node comes from NODE_BIN (tests, run-mcp.sh) or PATH (launchd puts node's dir first).

_host_repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
_host_node="${NODE_BIN:-$(command -v node 2>/dev/null || true)}"
if [ -z "$_host_node" ]; then
  echo "host.sh: node not found; set NODE_BIN or put node on PATH" >&2
  exit 1
fi
# From the repo root so `--import tsx` resolves the project's own tsx
if ! _host_exports="$(cd "$_host_repo" && "$_host_node" --import tsx scripts/lib/host-env.ts)"; then
  echo "host.sh: could not load the host profile (see above)" >&2
  exit 1
fi
eval "$_host_exports"
unset _host_repo _host_node _host_exports
