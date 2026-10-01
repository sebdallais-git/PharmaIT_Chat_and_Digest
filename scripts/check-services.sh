#!/usr/bin/env bash
# Read-only status of every moving part, and which of them come back by
# themselves. Written for the question "did everything survive the reboot?".
#
# Only four things are supervised: the MCP service, n8n, the jev scorer and
# the Hermes gateway are launchd jobs with KeepAlive. The app, the MLX servers
# and ChromaDB are started by scripts/start-services.sh and nothing restarts
# them -- after a reboot they stay down until someone runs it.
#
# Usage: scripts/check-services.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DOMAIN="gui/$(id -u)"
rc=0
# Ports from config/host.yaml, the same file every service reads (exits on an invalid profile)
# shellcheck source=lib/host.sh
source "$SCRIPT_DIR/lib/host.sh"
APP_URL="http://${PHARMAITCHAT_HOST_ADDRESS}:${APP_PORT}"

green() { printf "  \033[32m%-12s\033[0m %s\n" "$1" "$2"; }
red()   { printf "  \033[31m%-12s\033[0m %s\n" "$1" "$2"; rc=1; }

# "<port> <label>" for each model server the ACTIVE stack runs: its chat server, from the same
# read-only switch-stack.sh chat-endpoint the watchdog uses, plus MLX's embedder for the stacks
# that borrow it. A fixed MLX chat check reported "down" whenever another stack was active.
model_server_checks() {
  local stack endpoint
  stack="$(cat "$PROJECT_DIR/data/run/active-stack" 2>/dev/null || echo ollama)"
  endpoint="$(bash "$PROJECT_DIR/scripts/switch-stack.sh" chat-endpoint "$stack" 2>/dev/null | cut -d' ' -f1)"
  [ -n "$endpoint" ] && echo "${endpoint##*:} $stack chat"
  case "$stack" in
    mlx|splash) echo "$MLX_EMBED_PORT MLX embed" ;;
  esac
}

check_port() {
  if lsof -ti :"$1" >/dev/null 2>&1; then green "up" "$2 (:$1)"; else red "DOWN" "$2 (:$1)$3"; fi
}

check_job() {
  local state
  state="$(launchctl print "$DOMAIN/$1" 2>/dev/null | awk '/state = /{print $3; exit}')"
  if [ -n "$state" ]; then green "$state" "$1"; else red "NOT LOADED" "$1"; fi
}

echo "launchd services (these restart themselves)"
check_job com.pharmaitchat.mcp
check_job com.pharmaitchat.n8n
check_job com.pharmaitchat.jev
check_job ai.hermes.gateway

echo
echo "started by scripts/start-services.sh (the com.pharmaitchat.stack launchd job, at login)"
check_port "$APP_PORT" "app"        "  -> launchctl kickstart -k gui/$(id -u)/com.pharmaitchat.stack"
while read -r port label; do
  [ -n "$port" ] && check_port "$port" "$label" "  -> launchctl kickstart -k gui/$(id -u)/com.pharmaitchat.stack"
done < <(model_server_checks)
check_port "$CHROMADB_PORT" "ChromaDB"   "  -> launchctl kickstart -k gui/$(id -u)/com.pharmaitchat.stack"
check_port "$JEV_PORT" "jev scorer" "  -> gap decisions degrade; chat is unaffected"

echo
echo "docker containers (in colima; the stack job starts it at login)"
check_port "$NEO4J_PORT" "Neo4j"   "  -> colima start && docker start neo4j"
check_port "$SEARXNG_PORT" "SearXNG" "  -> colima start && docker start searxng"

echo
echo "end to end"
# Longer than the generation probe inside /api/health (GENERATION_PROBE_TIMEOUT_MS)
health="$(curl -sf -m 25 "$APP_URL/api/health" 2>/dev/null)"
if [ -n "$health" ]; then
  status="$(printf '%s' "$health" | python3 -c 'import sys,json; print(json.load(sys.stdin)["status"])' 2>/dev/null)"
  [ "$status" = "healthy" ] && green "$status" "app health" || red "$status" "app health"
  printf '%s' "$health" | python3 -c '
import sys, json
for name, c in json.load(sys.stdin).get("checks", {}).items():
    print(f"    {c.get(\"status\",\"?\"):5} {name}")
' 2>/dev/null
else
  red "DOWN" "app health endpoint"
fi

tg="$(python3 -c "
import json
try:
    d = json.load(open('$HOME/.hermes/gateway_state.json'))
    print(d.get('platforms', {}).get('telegram', {}).get('state', 'unknown'))
except Exception:
    print('unknown')
" 2>/dev/null)"
[ "$tg" = "connected" ] && green "connected" "Telegram" || red "$tg" "Telegram"

# A GET, never a POST: a POST starts a research run (26 health checks once searched the web for
# "undefined" and stored junk). n8n answers a GET on a POST-only webhook "not registered for GET
# requests. Did you mean to make a POST request?" when the workflow is active, and "not registered"
# when it is not -- telling the two apart without running anything.
hook="$(curl -s -m 10 http://${PHARMAITCHAT_HOST_ADDRESS}:${N8N_PORT}/webhook/knowledge-gap 2>/dev/null)"
case "$hook" in
  *"Did you mean to make a POST request"*) green "active" "gap-fill webhook" ;;
  *"not registered"*) red "inactive" "gap-fill webhook  -> activate the gap workflow in n8n" ;;
  *) red "no answer" "gap-fill webhook  -> is n8n running?" ;;
esac

# Through the app rather than a direct bolt connection: no extra dependency, and
# it proves the app can reach Neo4j, which is what actually matters.
# The token goes on stdin (-H @-): on a command line every process could read it
auth_header() { printf 'Authorization: Bearer %s\n' "$(cat "$PROJECT_DIR/data/run/api-token" 2>/dev/null)"; }
graph="$(auth_header | curl -sf -m 8 -H @- "$APP_URL/api/graph/stats" 2>/dev/null)"
if [ -n "$graph" ]; then
  green "ok" "vendor graph: $(printf '%s' "$graph" | tr -d '\n' | cut -c1-90)"
else
  red "unreadable" "vendor graph (/api/graph/stats)"
fi

# A UI stack switch needs the app's Telegram credentials (to send the confirm
# buttons) and Hermes' pharmaitchat-switch plugin (to receive the tap); either
# missing disables the selector in the web UI, with nothing else looking wrong
switch="$(auth_header | curl -sf -m 10 -H @- "$APP_URL/api/stack/status" 2>/dev/null | python3 -c '
import sys, json
d = json.load(sys.stdin)
if not d.get("telegram_configured"):
    print("not ready|the app has no Telegram credentials; launchctl kickstart -k gui/$(id -u)/com.pharmaitchat.stack")
elif not d.get("hermes_ready"):
    print("not ready|" + str(d.get("hermes_reason", "")))
else:
    print("ready|")
' 2>/dev/null)"
switch_state="${switch%%|*}"
switch_reason="${switch#*|}"
if [ "$switch_state" = "ready" ]; then
  green "ready" "UI stack switch"
else
  red "${switch_state:-unreadable}" "UI stack switch${switch_reason:+  -> $switch_reason}"
fi

echo
[ "$rc" -eq 0 ] && echo "all good" || echo "something is down — see the arrows above"
exit "$rc"
