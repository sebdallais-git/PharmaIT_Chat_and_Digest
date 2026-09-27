#!/usr/bin/env bash
# One switch for "does this machine bring PharmaITChat back up by itself?".
#
#   scripts/autostart.sh on       install and start everything, and at every login
#   scripts/autostart.sh off      stop everything and do not start at login
#   scripts/autostart.sh status   what is installed and what is running
#
# Four launchd jobs cover the whole stack:
#   com.pharmaitchat.stack    ChromaDB + the active LLM stack + the app
#   com.pharmaitchat.mcp      the MCP server the agent tools reach
#   com.pharmaitchat.n8n      the knowledge-gap auto-fill workflow
#   com.pharmaitchat.mlx-watchdog  restarts the mlx or omlx chat server when it stops generating
#   ai.hermes.gateway         the Hermes gateway behind Telegram
#
# The container runtime is not a launchd job here: Neo4j and SearXNG run in colima
# with restart policy unless-stopped, and start-services.sh (the stack job) starts
# colima at boot when Docker is not reachable, which brings them back.
# `on` reports if Docker is not reachable at that moment.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TEMPLATE_DIR="$PROJECT_DIR/hermes"
LAUNCH_AGENTS_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LAUNCHCTL_BIN="${LAUNCHCTL_BIN:-launchctl}"
DOMAIN="gui/$(id -u)"

# Rendered from a template here; the gateway's plist is written by hermes itself.
OWN_LABELS=(com.pharmaitchat.stack com.pharmaitchat.mcp com.pharmaitchat.n8n com.pharmaitchat.mlx-watchdog)
ALL_LABELS=("${OWN_LABELS[@]}" ai.hermes.gateway)

log() { printf "[autostart] %s\n" "$*"; }

node_bin() { echo "${NODE_BIN:-$(command -v node || echo /usr/local/bin/node)}"; }

render() {
  local label="$1" template="$TEMPLATE_DIR/$label.plist.template" out="$LAUNCH_AGENTS_DIR/$label.plist"
  [ -f "$template" ] || { log "no template for $label — skipping"; return 1; }
  sed -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" \
      -e "s|__NODE_BIN__|$(node_bin)|g" \
      -e "s|__MCP_HOST__|${MCP_HOST:-127.0.0.1}|g" \
      -e "s|__N8N_PORT__|${N8N_PORT:-5678}|g" \
      -e "s|__PATH__|$(dirname "$(node_bin)"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin|g" \
      "$template" >"$out"
}

# launchd answers "Input/output error" on a bootstrap issued right after a
# bootout. Every caller in this repo retries for that reason.
bootstrap_with_retry() {
  local label="$1" plist="$LAUNCH_AGENTS_DIR/$1.plist" attempt
  [ -f "$plist" ] || { log "$label: no plist at $plist"; return 1; }
  for attempt in 1 2 3 4 5; do
    if "$LAUNCHCTL_BIN" bootstrap "$DOMAIN" "$plist" >/dev/null 2>&1; then
      log "$label: started"
      return 0
    fi
    sleep 2
  done
  log "$label: bootstrap failed after 5 attempts"
  return 1
}

state_of() {
  # Capture the whole value: an interval job between runs reports "not running",
  # and taking only the first field showed it as "not".
  "$LAUNCHCTL_BIN" print "$DOMAIN/$1" 2>/dev/null | sed -n 's/^[[:space:]]*state = //p' | head -1
}

cmd_on() {
  mkdir -p "$LAUNCH_AGENTS_DIR" "$PROJECT_DIR/data/logs"
  local label rc=0
  for label in "${OWN_LABELS[@]}"; do render "$label" || rc=1; done
  # The gateway's plist is hermes' own; install it if it is missing.
  if [ ! -f "$LAUNCH_AGENTS_DIR/ai.hermes.gateway.plist" ] && [ -x "$HOME/.hermes/hermes-agent/venv/bin/python" ]; then
    "$HOME/.hermes/hermes-agent/venv/bin/python" -m hermes_cli.main gateway install --force --start-on-login >/dev/null 2>&1 || true
  fi
  for label in "${ALL_LABELS[@]}"; do
    "$LAUNCHCTL_BIN" bootout "$DOMAIN/$label" >/dev/null 2>&1 || true
    "$LAUNCHCTL_BIN" enable "$DOMAIN/$label" >/dev/null 2>&1 || true
    bootstrap_with_retry "$label" || rc=1
  done
  log "autostart is ON — these come back at login and restart on crash"
  if ! docker info >/dev/null 2>&1; then
    log "NOTE: Docker is not reachable right now. The stack job starts colima at boot; to start it now: colima start"
  fi
  return "$rc"
}

cmd_off() {
  local label
  for label in "${ALL_LABELS[@]}"; do
    "$LAUNCHCTL_BIN" bootout "$DOMAIN/$label" >/dev/null 2>&1 || true
    # disable survives a bootstrap, so a stray `launchctl load` cannot quietly
    # switch autostart back on.
    "$LAUNCHCTL_BIN" disable "$DOMAIN/$label" >/dev/null 2>&1 || true
    log "$label: stopped and disabled"
  done
  log "autostart is OFF — nothing starts at login. Bring the stack up by hand with scripts/start-services.sh"
}

cmd_status() {
  local label state
  for label in "${ALL_LABELS[@]}"; do
    state="$(state_of "$label")"
    # An interval job is "not running" between firings, which is its healthy
    # state; only "not loaded" means autostart is off for it.
    case "$state" in
      "not running") state="loaded (idle between runs)" ;;
      "") state="NOT LOADED" ;;
    esac
    printf "  %-26s %s\n" "$label" "$state"
  done
  printf "  %-26s %s\n" "docker (neo4j, searxng)" "$(docker info >/dev/null 2>&1 && echo running || echo 'not running')"
}

case "${1:-status}" in
  on) cmd_on ;;
  off) cmd_off ;;
  status) cmd_status ;;
  *) echo "usage: $0 on|off|status" >&2; exit 2 ;;
esac
