#!/usr/bin/env bash
# launchd entry point for pharmaitchat-n8n: runs the n8n instance that hosts the
# knowledge-gap auto-fill workflow.
#
# n8n owns the FILLING half of the gap loop -- generate search queries, search
# SearXNG, fetch and clean pages, extract, filter for relevance, then ingest.
# Hermes owns the CHECKING half: the pharmaitchat-gap-resolution cron re-asks
# each gap and marks it resolved. Neither replaces the other, and the app's Gap
# Detector calls this webhook the moment a gap is found, which is why it runs as
# a service rather than on a schedule.
#
# Holds no secrets: n8n reads its own credentials from ~/.n8n, and the app's API
# token is read from data/run and passed through the environment only.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RUN_DIR="${PHARMALLM_RUN_DIR:-$PROJECT_DIR/data/run}"

read_token() {
  if [ -s "$1" ]; then tr -d '[:space:]' <"$1"; fi
}

# The workflows call the app's protected routes with
# `Bearer {{ $env.PHARMALLM_API_TOKEN }}`. n8n 2.x blocks $env in expressions
# by default, which leaves that header empty and every call a 401, so allow it.
# The environment n8n sees is launchd's plus what this script exports.
PHARMALLM_API_TOKEN="$(read_token "$RUN_DIR/api-token")"
export PHARMALLM_API_TOKEN
export N8N_BLOCK_ENV_ACCESS_IN_NODE=false

export N8N_PORT="${N8N_PORT:-5678}"
# Bound to loopback on purpose: the only caller is the app's Gap Detector on
# this machine, and n8n's editor has no auth in this deployment.
export N8N_LISTEN_ADDRESS="${N8N_LISTEN_ADDRESS:-127.0.0.1}"
export N8N_USER_FOLDER="${N8N_USER_FOLDER:-$HOME}"
export N8N_DIAGNOSTICS_ENABLED="${N8N_DIAGNOSTICS_ENABLED:-false}"

# ~/.n8n holds the encryption key that protects every stored credential, so fix
# the permissions rather than disabling the check that complains about them.
# launchd's umask is laxer than a login shell's, which is what made n8n warn --
# the warning was right and silencing it would have left the key readable.
umask 077
if [ -d "$N8N_USER_FOLDER/.n8n" ]; then
  chmod 700 "$N8N_USER_FOLDER/.n8n" 2>/dev/null || true
  [ -f "$N8N_USER_FOLDER/.n8n/config" ] && chmod 600 "$N8N_USER_FOLDER/.n8n/config" 2>/dev/null || true
fi

if [ -n "${N8N_BIN:-}" ] && [ -x "$N8N_BIN" ]; then
  exec "$N8N_BIN" start
fi

# npx resolves the cached copy under ~/.npm/_npx; --yes stops it prompting when
# launchd gives it no tty.
cd "$PROJECT_DIR"
exec npx --yes n8n start
