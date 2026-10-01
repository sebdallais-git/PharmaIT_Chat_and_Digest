#!/usr/bin/env bash
# launchd entry point for pharmaitchat-mcp: reads the API and MCP tokens from data/run and starts the service.
# Tokens are passed through the environment only, never as arguments.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RUN_DIR="${PHARMALLM_RUN_DIR:-$PROJECT_DIR/data/run}"

read_token() {
  if [ -s "$1" ]; then tr -d '[:space:]' <"$1"; fi
}

# MCP_HOST, MCP_PORT and APP_PORT come from config/host.yaml (exits on an invalid profile)
# shellcheck source=lib/host.sh
source "$SCRIPT_DIR/lib/host.sh"
export PHARMALLM_URL="${PHARMALLM_URL:-http://${PHARMAITCHAT_HOST_ADDRESS}:${APP_PORT}}"
PHARMALLM_API_TOKEN="$(read_token "$RUN_DIR/api-token")"
MCP_TOKEN="$(read_token "$RUN_DIR/mcp-token")"
export PHARMALLM_API_TOKEN MCP_TOKEN

case "$MCP_HOST" in
  127.0.0.1|localhost|::1) ;;
  *)
    if [ -z "$MCP_TOKEN" ]; then
      echo "run-mcp: refusing to listen on $MCP_HOST without $RUN_DIR/mcp-token (create it: scripts/switch-stack.sh mcp-token)" >&2
      exit 1
    fi
    ;;
esac

cd "$PROJECT_DIR/mcp"
# Test hook: a stub replaces the real service
if [ -n "${RUN_MCP_EXEC:-}" ]; then
  exec "$RUN_MCP_EXEC"
fi
exec "${NODE_BIN:-node}" --import tsx src/server.ts
