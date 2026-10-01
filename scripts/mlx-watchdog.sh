#!/usr/bin/env bash
# Restart the active stack's chat server when it stops generating.
#
# MLX can wedge without dying: on 2026-09-22 it sat at 0% CPU with port 8080
# open, served /v1/models normally, and timed out a 5-token generation at 90s.
# Nothing noticed -- the app's health check probed /v1/models, the process was
# alive, the port answered, so every signal said healthy while chat was dead.
# It had OOMed once beforehand ([metal::malloc] Resource limit exceeded).
#
# So this checks the only thing that matters: can it produce a token.
#
# Run by launchd every WATCHDOG_INTERVAL seconds. Deliberately NOT a KeepAlive
# job -- the failure is a live process that stops working, which KeepAlive
# cannot see.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
STATE_DIR="${PHARMALLM_RUN_DIR:-$PROJECT_DIR/data/run}"
STRIKES_FILE="$STATE_DIR/mlx-watchdog.strikes"
LOG="$PROJECT_DIR/data/logs/mlx-watchdog.log"

# Generous: a busy server (the watchlist tagger saturates it for ~20s an item)
# must not be mistaken for a wedged one.
PROBE_TIMEOUT="${WATCHDOG_PROBE_TIMEOUT:-90}"
# Two consecutive failures before acting, so one slow moment never restarts a
# server that is merely busy.
MAX_STRIKES="${WATCHDOG_MAX_STRIKES:-2}"
# A failed probe only counts while the server is idle on CPU. The wedge above
# sat at 0%; a server generating a long chat turn or an export narration is
# busy, and the probe merely queued behind it.
BUSY_CPU="${WATCHDOG_BUSY_CPU:-5}"
# 27B generation runs on the GPU, so a busy server can sit below BUSY_CPU (a strike on
# 2026-09-29 06:51 during a load test). A wedged one -- generation thread dead after a
# Metal OOM -- leaves the GPU idle. Same threshold as the app's health check.
BUSY_GPU="${WATCHDOG_BUSY_GPU:-30}"

mkdir -p "$STATE_DIR" "$(dirname "$LOG")"
log() { printf "%s %s\n" "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG"; }

# Ollama is a Homebrew service whose restarts launchd owns; only the servers
# this project starts itself (mlx, omlx) are watched.
stack="$(cat "$STATE_DIR/active-stack" 2>/dev/null || echo ollama)"
[ "$stack" = "ollama" ] && exit 0

# Ask switch-stack.sh where this stack serves chat rather than assuming 8080:
# omlx listens on 8090, and probing or killing the wrong port reports health for
# a server never contacted, or restarts one that is not wedged.
if ! endpoint="$("$SCRIPT_DIR/switch-stack.sh" chat-endpoint "$stack" 2>/dev/null)"; then
  log "chat-endpoint failed for stack '$stack' (invalid config/host.yaml or unknown stack); not probing"
  exit 0
fi
read -r chat_url chat_model <<<"$endpoint"
[ -n "$chat_url" ] && [ -n "$chat_model" ] || exit 0
chat_port="${chat_url##*:}"

# The watchlist tagger saturates this same single MLX server for ~20s an item,
# so a probe issued mid-ingest queues behind the backlog and can exceed even a
# 90s timeout. Two of those would have this watchdog restart MLX underneath the
# ingest and destroy the run it was meant to protect. A saturated server is
# busy, not wedged.
if pgrep -f "watchlist.ts ingest" >/dev/null 2>&1; then
  exit 0
fi

code="$(curl -s -o /dev/null -w '%{http_code}' -m "$PROBE_TIMEOUT" \
  -X POST "$chat_url/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"$chat_model\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":1,\"stream\":false}" 2>/dev/null)"

if [ "$code" = "200" ]; then
  [ -s "$STRIKES_FILE" ] && log "recovered after $(cat "$STRIKES_FILE") strike(s)"
  : >"$STRIKES_FILE"
  exit 0
fi

# Only the process listening on the port: a bare `lsof -ti :port` also lists
# clients, the app among them, and would have this script kill PharmaITChat.
# Same filter as port_listeners in lib/services.sh.
listener() { lsof -nP -tiTCP:"$chat_port" -sTCP:LISTEN 2>/dev/null | head -1; }

pid="$(listener)"
if [ -n "$pid" ]; then
  cpu="$(ps -o %cpu= -p "$pid" 2>/dev/null | tr -d ' ')"
  if awk -v c="${cpu:-0}" -v t="$BUSY_CPU" 'BEGIN { exit !(c >= t) }'; then
    log "generation probe failed (HTTP ${code:-000}) but the server is busy (${cpu}% CPU), not counting a strike"
    exit 0
  fi
  gpu="$(ioreg -r -d 1 -c IOAccelerator 2>/dev/null | grep -o '"Device Utilization %"=[0-9]*' | cut -d= -f2 | sort -n | tail -1)"
  if [ -n "$gpu" ] && [ "$gpu" -ge "$BUSY_GPU" ]; then
    log "generation probe failed (HTTP ${code:-000}) but the GPU is busy (${gpu}%), not counting a strike"
    exit 0
  fi
fi

strikes=$(( $(cat "$STRIKES_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$strikes" >"$STRIKES_FILE"
log "generation probe failed (HTTP ${code:-000}), strike $strikes/$MAX_STRIKES"

if [ "$strikes" -lt "$MAX_STRIKES" ]; then
  exit 0
fi

log "restarting the $stack stack (port $chat_port)"
if [ -n "$pid" ]; then
  kill -TERM "$pid" 2>/dev/null
  for _ in $(seq 1 15); do [ -n "$(listener)" ] || break; sleep 1; done
  # A wedged process often ignores SIGTERM, which is what wedged means.
  [ -n "$(listener)" ] && kill -9 "$pid" 2>/dev/null
fi

if "$SCRIPT_DIR/switch-stack.sh" ensure-stack "$stack" >>"$LOG" 2>&1; then
  log "$stack restarted"
  : >"$STRIKES_FILE"
else
  log "restart FAILED — needs a human"
fi
