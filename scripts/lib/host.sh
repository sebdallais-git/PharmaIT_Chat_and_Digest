#!/usr/bin/env bash
# Exports the host profile (config/host.yaml) -- ports and machine-sized limits -- as env vars.
# Source this file; don't execute it. A variable already set in the environment keeps its value.
# Exits the calling script when the profile is invalid or node is missing: a script that went on
# with empty ports would start servers on the wrong port or probe nothing.
# node comes from HOST_NODE_BIN (tests), else NODE_BIN (run-mcp.sh, plists), else PATH (launchd puts
# node's dir first). A variable that is set but not an executable is an error, never skipped: a
# mistyped NODE_BIN must not quietly fall back to another node.

_host_repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
_host_node=""
if [ -n "${HOST_NODE_BIN:-}" ]; then
  _host_node="$HOST_NODE_BIN"; _host_var=HOST_NODE_BIN
elif [ -n "${NODE_BIN:-}" ]; then
  _host_node="$NODE_BIN"; _host_var=NODE_BIN
else
  _host_node="$(command -v node 2>/dev/null || true)"; _host_var=""
fi
if [ -z "$_host_node" ]; then
  echo "host.sh: node not found; set HOST_NODE_BIN or NODE_BIN, or put node on PATH" >&2
  exit 1
fi
if [ -n "$_host_var" ] && [ ! -x "$_host_node" ]; then
  echo "host.sh: ${_host_var}=${_host_node} is not an executable node" >&2
  exit 1
fi
# From the repo root so `--import tsx` resolves the project's own tsx
if ! _host_exports="$(cd "$_host_repo" && "$_host_node" --import tsx scripts/lib/host-env.ts)"; then
  echo "host.sh: could not load the host profile (see above)" >&2
  exit 1
fi
eval "$_host_exports"
unset _host_repo _host_node _host_var _host_exports
