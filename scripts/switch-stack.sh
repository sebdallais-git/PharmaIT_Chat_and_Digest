#!/usr/bin/env bash
# Switch PharmaITChat between the Ollama, MLX, oMLX and Splash stacks. Only one stack runs at a time.
# Usage:
#   scripts/switch-stack.sh ollama|mlx|omlx|splash          stop the other stacks, start this one, restart the app
#   scripts/switch-stack.sh ensure-stack ollama|mlx|omlx|splash  start a stack and its indexes without starting the app
#   scripts/switch-stack.sh prepare                  download models and create the MLX venv (one-time)
#   scripts/switch-stack.sh status                   show the active stack, ports and index counts
#   scripts/switch-stack.sh token                    create the API token for agents and other machines
#   scripts/switch-stack.sh telegram                 store the Telegram credentials used to confirm UI switches
#   scripts/switch-stack.sh ollama-ctx               recreate qwen3.8-pharma if its context differs from the Modelfile
#   scripts/switch-stack.sh mcp-token                create the token agents use to reach pharmaitchat-mcp
#   scripts/switch-stack.sh mcp start|stop|status    control the pharmaitchat-mcp launchd service
#   scripts/switch-stack.sh chat-endpoint <stack>    print "<url> <model>" the stack serves chat on

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_PREFIX="switch-stack"
# shellcheck source=lib/services.sh
source "$SCRIPT_DIR/lib/services.sh"

RUN_DIR="${PHARMAITCHAT_RUN_DIR:-${PHARMALLM_RUN_DIR:-$PROJECT_DIR/data/run}}"
TOKEN_FILE="$RUN_DIR/api-token"
MCP_TOKEN_FILE="$RUN_DIR/mcp-token"
SWITCH_FILE="$RUN_DIR/stack-switch.json"
TELEGRAM_BOT_TOKEN_FILE="$RUN_DIR/telegram-bot-token"
TELEGRAM_CHAT_ID_FILE="$RUN_DIR/telegram-chat-id"
MCP_LABEL="com.pharmaitchat.mcp"
MCP_PLIST="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}/$MCP_LABEL.plist"
MCP_PORT="3200"
LOG_DIR="$PROJECT_DIR/data/logs"
MLX_VENV="$PROJECT_DIR/python/mlx-venv"
MLX_PYTHON="${MLX_PYTHON:-python3}"
# oMLX pins itself to >=3.11,<3.14, so it cannot share MLX's interpreter on a machine
# whose python3 is newer. MLX itself is happy on 3.14.
OMLX_PYTHON="${OMLX_PYTHON:-python3.11}"
HF_CACHE="${HF_HOME:-$HOME/.cache/huggingface}/hub"
OLLAMA_MANIFESTS="${OLLAMA_MODELS:-$HOME/.ollama/models}/manifests/registry.ollama.ai/library"

APP_PORT="3000"
APP_HTTPS_PORT="3443"
OLLAMA_PORT="11434"
MLX_CHAT_PORT="8080"
MLX_EMBED_PORT="8081"

OLLAMA_BASE_MODEL="qwen3.8:27b-q4_K_M"
OLLAMA_CHAT_MODEL="qwen3.8-pharma"
OLLAMA_EMBED_MODEL="qwen3-embedding:0.6b-q8_0"
MLX_CHAT_MODEL="mlx-community/Qwen3.8-27B-4bit"
MLX_EMBED_MODEL="mlx-community/Qwen3-Embedding-0.6B-8bit"
OMLX_CHAT_MODEL="mlx-community--Qwen3.8-27B-4bit"
OMLX_EMBED_MODEL="mlx-community--Qwen3-Embedding-0.6B-8bit"
OLLAMA_MODELFILE="$PROJECT_DIR/ollama/qwen3.8-pharma.Modelfile"
# Caps how much memory mlx_lm.server spends on cached prompts (several 64k agent prompts would otherwise pile up)
MLX_PROMPT_CACHE_BYTES="${MLX_PROMPT_CACHE_BYTES:-8589934592}"

OMLX_VENV="$PROJECT_DIR/python/omlx-venv"
OMLX_PORT="8090"
# Pinned to the commit verified in docs/superpowers/plans/2026-09-18-omlx-stack-verification.md
OMLX_VERSION="cbc1a80"
OMLX_REPO="https://github.com/jundot/omlx"
# Caps the oMLX paged SSD prefix cache (unbounded, it reached 4.3 GB in two short sessions)
OMLX_CACHE_MAX_GB="${OMLX_CACHE_MAX_GB:-20}"

# --- Splash ---------------------------------------------------------------
# Chat only: Splash serves no /v1/embeddings, so this stack borrows the MLX
# embedding server on $MLX_EMBED_PORT and shares the MLX index.
SPLASH_PORT="${SPLASH_PORT:-8000}"
SPLASH_CHAT_MODEL="${SPLASH_CHAT_MODEL:-incoai/Qwen3.8-27B-Splash}"
SPLASH_DIR="${SPLASH_DIR:-$PROJECT_DIR/python/splash-src}"
SPLASH_BIN="${SPLASH_BIN:-$SPLASH_DIR/splash}"
SPLASH_REPO="https://github.com/incoai/splash"
# Defaults to main because no commit has been verified on this machine yet, unlike OMLX_VERSION
# above. It MUST be pinned to a tested commit (the same way OMLX_VERSION is) before any benchmark
# row produced with Splash is treated as reproducible -- an unpinned engine makes those rows
# non-comparable over time.
SPLASH_VERSION="${SPLASH_VERSION:-main}"
# Matches the other stacks so benchmark rows compare like with like
SPLASH_MAX_CONTEXT="${SPLASH_MAX_CONTEXT:-65536}"

mkdir -p "$RUN_DIR" "$LOG_DIR"

# Single source of truth for the stack names, mirroring STACK_NAMES in src/config/llm-stacks.ts
# (__tests__/switch-stack-config.test.ts fails if the two lists drift apart).
STACK_NAMES=(ollama mlx omlx splash)

active_stack() {
  cat "$RUN_DIR/active-stack" 2>/dev/null || echo "ollama"
}

validate_stack() {
  case "$1" in
    ollama|mlx|omlx|splash) ;;
    *) log "Unknown stack '$1' (expected ollama, mlx, omlx or splash)"; return 1 ;;
  esac
}

# --- Model availability (checked on disk, so no server needs to run) ---------

ollama_manifest() {
  local name="${1%%:*}" tag="${1#*:}"
  [ "$name" = "$1" ] && tag="latest"
  echo "$OLLAMA_MANIFESTS/$name/$tag"
}

hf_snapshot_present() {
  local dir="$HF_CACHE/models--${1//\//--}/snapshots"
  [ -d "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]
}

models_ready() {
  case "$1" in
    ollama)
      [ -f "$(ollama_manifest "$OLLAMA_CHAT_MODEL")" ] && [ -f "$(ollama_manifest "$OLLAMA_EMBED_MODEL")" ]
      ;;
    mlx)
      [ -x "$MLX_VENV/bin/mlx_lm.server" ] && hf_snapshot_present "$MLX_CHAT_MODEL" && hf_snapshot_present "$MLX_EMBED_MODEL"
      ;;
    omlx)
      [ -x "$OMLX_VENV/bin/omlx" ] && hf_snapshot_present "$MLX_CHAT_MODEL" && hf_snapshot_present "$MLX_EMBED_MODEL"
      ;;
    splash)
      [ -x "$SPLASH_BIN" ] && hf_snapshot_present "$SPLASH_CHAT_MODEL" && hf_snapshot_present "$MLX_EMBED_MODEL"
      ;;
  esac
}

# --- Stack processes -----------------------------------------------------------

stop_ollama() {
  brew services stop ollama >/dev/null 2>&1 || true
  # launchd restarts a killed Ollama, so only a closed port proves it is down
  wait_port_closed "$OLLAMA_PORT" 30 || { log "Ollama is still listening on :$OLLAMA_PORT"; return 1; }
}

start_ollama() {
  port_open "$OLLAMA_PORT" || brew services start ollama >/dev/null
  wait_http "http://localhost:$OLLAMA_PORT/v1/models" 60 || { log "Ollama did not become ready"; return 1; }
}

modelfile_num_ctx() {
  awk '$1 == "PARAMETER" && $2 == "num_ctx" { print $3 }' "$OLLAMA_MODELFILE"
}

ollama_model_num_ctx() {
  ollama show "$OLLAMA_CHAT_MODEL" --parameters 2>/dev/null | awk '$1 == "num_ctx" { print $2 }'
}

# Recreate qwen3.8-pharma when its context differs from the Modelfile (reuses the pulled weights, no download)
ensure_ollama_ctx() {
  local wanted current
  wanted="$(modelfile_num_ctx)"
  current="$(ollama_model_num_ctx || true)"
  if [ "$current" = "$wanted" ]; then
    log "$OLLAMA_CHAT_MODEL context is $wanted"
    return 0
  fi
  log "Recreating $OLLAMA_CHAT_MODEL with context $wanted (was ${current:-unknown})"
  ollama create "$OLLAMA_CHAT_MODEL" -f "$OLLAMA_MODELFILE" >/dev/null
}

stop_pidfile() {
  local name="$1" port="$2" ignore_foreign="${3:-}"
  stop_pidfile_process "$RUN_DIR/$name.pid"
  # Also covers a project server started by hand; another program on the port makes this fail
  # unless ignore-foreign is set (MLX ports may be shared with an unrelated program).
  stop_port "$port" 20 "$ignore_foreign" || { log "Port $port ($name) is still in use"; return 1; }
}

stop_mlx() {
  local chat_rc=0 embed_rc=0
  # Run both stops even if one fails, so a stuck chat port doesn't leave the embed server up.
  stop_pidfile mlx-chat "$MLX_CHAT_PORT" ignore-foreign || chat_rc=$?
  stop_pidfile mlx-embed "$MLX_EMBED_PORT" ignore-foreign || embed_rc=$?
  [ "$chat_rc" -eq 0 ] && [ "$embed_rc" -eq 0 ]
}

# Shared by mlx and splash: splash serves no embeddings of its own and borrows
# this server. The function itself is idempotent -- called directly, a running
# server owned by this project is reused rather than restarted -- but that is
# NOT what happens on an mlx<->splash switch: switch_to stops every other
# stack first (stop_other_stacks -> stop_mlx -> stop_pidfile mlx-embed), which
# kills :8081 before the target stack starts. So the embedding server IS
# bounced and its model reloaded on every mlx<->splash switch. That is safe --
# strictly sequential, splash never runs while :8081 is down -- and the cost
# is accepted because stacks must not run concurrently on this machine.
start_mlx_embed() {
  if port_open "$MLX_EMBED_PORT"; then
    project_listener_open "$MLX_EMBED_PORT" \
      || { log "Port $MLX_EMBED_PORT is used by another program — cannot start the embedding server"; return 1; }
  else
    nohup "$MLX_VENV/bin/python" "$PROJECT_DIR/python/mlx-embed-server.py" \
      --model "$MLX_EMBED_MODEL" --host 127.0.0.1 --port "$MLX_EMBED_PORT" \
      >"$LOG_DIR/mlx-embed.log" 2>&1 &
    echo $! >"$RUN_DIR/mlx-embed.pid"
  fi
  wait_http "http://localhost:$MLX_EMBED_PORT/v1/models" 180 \
    || { log "MLX embedding server did not become ready"; return 1; }
}

start_mlx() {
  if port_open "$MLX_CHAT_PORT"; then
    project_listener_open "$MLX_CHAT_PORT" \
      || { log "Port $MLX_CHAT_PORT is used by another program — cannot start MLX"; return 1; }
  else
    nohup "$MLX_VENV/bin/mlx_lm.server" --model "$MLX_CHAT_MODEL" --host 127.0.0.1 --port "$MLX_CHAT_PORT" \
      --prompt-cache-bytes "$MLX_PROMPT_CACHE_BYTES" \
      >"$LOG_DIR/mlx-chat.log" 2>&1 &
    echo $! >"$RUN_DIR/mlx-chat.pid"
  fi
  wait_http "http://localhost:$MLX_CHAT_PORT/v1/models" 180 || { log "mlx_lm.server did not become ready"; return 1; }
  start_mlx_embed
}

stop_omlx() {
  stop_pidfile omlx "$OMLX_PORT" ignore-foreign
}

start_omlx() {
  if port_open "$OMLX_PORT"; then
    project_listener_open "$OMLX_PORT" \
      || { log "Port $OMLX_PORT is used by another program — cannot start oMLX"; return 1; }
  else
    nohup "$OMLX_VENV/bin/omlx" serve --host 127.0.0.1 --port "$OMLX_PORT" \
      --model-dir "$HF_CACHE" --paged-ssd-cache-max-size "${OMLX_CACHE_MAX_GB}GB" \
      >"$LOG_DIR/omlx.log" 2>&1 &
    echo $! >"$RUN_DIR/omlx.pid"
  fi
  wait_http "http://localhost:$OMLX_PORT/v1/models" 180 || { log "oMLX did not become ready"; return 1; }
}

stop_splash() {
  stop_pidfile splash "$SPLASH_PORT" ignore-foreign
}

start_splash() {
  if port_open "$SPLASH_PORT"; then
    project_listener_open "$SPLASH_PORT" \
      || { log "Port $SPLASH_PORT is used by another program — cannot start Splash"; return 1; }
  else
    nohup "$SPLASH_BIN" serve --model "$SPLASH_CHAT_MODEL" \
      --host 127.0.0.1 --port "$SPLASH_PORT" \
      --max-context "$SPLASH_MAX_CONTEXT" --default-reasoning-effort none \
      >"$LOG_DIR/splash.log" 2>&1 &
    echo $! >"$RUN_DIR/splash.pid"
  fi
  # 600s, not 300: even after `prepare` has run the binary once, a 17.4 GB model's first mmap is not
  # fast, and a timeout here would roll back a switch that was actually working.
  wait_http "http://localhost:$SPLASH_PORT/v1/models" 600 || { log "Splash did not become ready"; return 1; }
  # Chat only: the embeddings for this stack come from the MLX server.
  start_mlx_embed
}

# Stacks that share the MLX index must serve interchangeable embeddings:
# drifted vectors would silently poison retrieval, and the index guard cannot
# see the difference. Called with the URL and model of whatever is actually
# serving embeddings for the stack being started.
check_embedding_parity() {
  local base_url="$1" model="$2" out
  if out="$("$MLX_PYTHON" "$PROJECT_DIR/scripts/lib/embedding-parity.py" \
      "$base_url" "$model" \
      "$PROJECT_DIR/__tests__/fixtures/embedding-reference.json" 2>&1)"; then
    log "Embedding parity ok (${out})"
    return 0
  fi
  log "Embedding parity check failed: $out"
  return 1
}

start_stack() {
  case "$1" in
    mlx) start_mlx ;;
    omlx) start_omlx && check_embedding_parity "http://localhost:$OMLX_PORT" "$OMLX_EMBED_MODEL" ;;
    splash) start_splash && check_embedding_parity "http://localhost:$MLX_EMBED_PORT" "$MLX_EMBED_MODEL" ;;
    *) start_ollama && ensure_ollama_ctx ;;
  esac
}

stop_stack() {
  case "$1" in
    mlx) stop_mlx ;;
    omlx) stop_omlx ;;
    splash) stop_splash ;;
    *) stop_ollama ;;
  esac
}

# Where a stack serves chat, as "<base url> <model>". mlx-watchdog.sh reads this
# too, so the server it probes and restarts is the one the stack really runs.
chat_endpoint() {
  case "$1" in
    mlx) echo "http://localhost:$MLX_CHAT_PORT $MLX_CHAT_MODEL" ;;
    omlx) echo "http://localhost:$OMLX_PORT $OMLX_CHAT_MODEL" ;;
    splash) echo "http://localhost:$SPLASH_PORT $SPLASH_CHAT_MODEL" ;;
    ollama) echo "http://localhost:$OLLAMA_PORT $OLLAMA_CHAT_MODEL" ;;
    *) log "Unknown stack '$1' (expected ${STACK_NAMES[*]})" >&2; return 1 ;;
  esac
}

# Load both models into memory so the first real request doesn't pay for it
warm_up() {
  local chat_url embed_url chat_model embed_model extra
  read -r chat_url chat_model <<<"$(chat_endpoint "$1")"
  if [ "$1" = "mlx" ]; then
    embed_url="http://localhost:$MLX_EMBED_PORT"
    embed_model="$MLX_EMBED_MODEL"
    extra='"chat_template_kwargs":{"enable_thinking":false}'
  elif [ "$1" = "omlx" ]; then
    embed_url="$chat_url"
    embed_model="$OMLX_EMBED_MODEL"
    extra='"chat_template_kwargs":{"enable_thinking":false}'
  elif [ "$1" = "splash" ]; then
    embed_url="http://localhost:$MLX_EMBED_PORT"
    embed_model="$MLX_EMBED_MODEL"
    extra='"reasoning_effort":"none"'
  else
    embed_url="$chat_url"
    embed_model="$OLLAMA_EMBED_MODEL"
    extra='"reasoning_effort":"none"'
  fi

  log "Warming up $1..."
  curl -sf -m 600 "$chat_url/v1/chat/completions" -H 'Content-Type: application/json' \
    -d "{\"model\":\"$chat_model\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with OK\"}],\"max_tokens\":5,$extra}" \
    >/dev/null || { log "Chat warm-up failed"; return 1; }
  curl -sf -m 120 "$embed_url/v1/embeddings" -H 'Content-Type: application/json' \
    -d "{\"model\":\"$embed_model\",\"input\":\"warm-up\"}" \
    >/dev/null || { log "Embedding warm-up failed"; return 1; }
}

ensure_index() {
  local rc=0
  (cd "$PROJECT_DIR" && LLM_PROVIDER="$1" npx tsx scripts/reindex-stack.ts --check) || rc=$?
  case "$rc" in
    0)
      log "Indexes for $1 are ready"
      ;;
    2)
      log "Building indexes for $1 (re-embeds the whole knowledge base, see $LOG_DIR/reindex-$1.log)..."
      local reindex_rc=0
      (cd "$PROJECT_DIR" && LLM_PROVIDER="$1" npx tsx scripts/reindex-stack.ts) >"$LOG_DIR/reindex-$1.log" 2>&1 \
        || reindex_rc=$?
      case "$reindex_rc" in
        0) ;;
        3) log "Indexes for $1 built with skipped raw documents — see $LOG_DIR/reindex-$1.log" ;;
        *) log "Reindex failed"; tail -n 15 "$LOG_DIR/reindex-$1.log"; return 1 ;;
      esac
      tail -n 1 "$LOG_DIR/reindex-$1.log"
      ;;
    *)
      log "Index check failed (exit $rc)"
      return 1
      ;;
  esac
}

# --- PharmaITChat app --------------------------------------------------------------

stop_app() {
  local pid
  stop_pidfile_process "$RUN_DIR/app.pid"
  # Also stop an app started another way (npm run dev, manual tsx); tsx watch would respawn its child.
  # Other projects run the same command, so only this project's copy is stopped.
  for pid in $(pgrep -f "tsx watch src/server.ts" 2>/dev/null || true); do
    if is_project_pid "$pid"; then kill -TERM "$pid" 2>/dev/null || true; fi
  done
  if ! stop_port "$APP_PORT" 20 || ! stop_port "$APP_HTTPS_PORT" 20; then
    log "App ports are still in use"
    return 1
  fi
}

# API token for agents and other machines (readable only by you)
ensure_token() {
  if [ -s "$TOKEN_FILE" ]; then
    log "API token already exists at $TOKEN_FILE"
  else
    (umask 077 && openssl rand -hex 32 >"$TOKEN_FILE")
    log "Created API token at $TOKEN_FILE"
  fi
  chmod 600 "$TOKEN_FILE"
  log "Restart the app to enforce it: scripts/switch-stack.sh $(active_stack)"
  log "Use it in a shell with: export PHARMAITCHAT_API_TOKEN=\"\$(cat $TOKEN_FILE)\""
}

api_token() {
  if [ -s "$TOKEN_FILE" ]; then
    cat "$TOKEN_FILE"
  fi
}

# The UI polls this file while the app is down mid-switch
write_switch_phase() {
  local phase="$1" error="${2:-}" target="${SWITCH_TARGET:-}" previous="${SWITCH_PREVIOUS:-}"
  [ -n "$target" ] || return 0
  PHASE="$phase" TARGET="$target" PREVIOUS="$previous" STARTED="${SWITCH_STARTED:-0}" ERROR="$error" \
    python3 - "$SWITCH_FILE" <<'PY'
import json, os, sys
record = {"phase": os.environ["PHASE"], "target": os.environ["TARGET"],
          "previous": os.environ["PREVIOUS"], "startedAt": int(os.environ["STARTED"])}
if os.environ["PHASE"] in ("ready", "failed"):
    import time
    record["finishedAt"] = int(time.time() * 1000)
if os.environ.get("ERROR"):
    record["error"] = os.environ["ERROR"]
# Write to a temp file in the same directory and atomically replace the target, so a UI poll can
# never observe a half-written file (open()+write() in place is not atomic).
path = sys.argv[1]
directory = os.path.dirname(path) or "."
tmp_path = os.path.join(directory, f".{os.path.basename(path)}.{os.getpid()}.tmp")
fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o666)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(record, handle)
    os.replace(tmp_path, path)
except Exception:
    try:
        os.unlink(tmp_path)
    except OSError:
        pass
    raise
PY
}

telegram_value() {
  local file="$RUN_DIR/telegram-$1"
  if [ -s "$file" ]; then tr -d '[:space:]' <"$file"; fi
}

# Credentials the app uses to ask for confirmation of a UI-triggered switch
ensure_telegram() {
  local token="${TELEGRAM_BOT_TOKEN:-}" chat="${TELEGRAM_CHAT_ID:-}"
  # read -s shows nothing as you type, which reads as a hung terminal unless we say so.
  if [ -z "$token" ] && [ -t 0 ]; then
    read -rs -p "Telegram bot token (input is hidden — paste, then press Enter): " token
    echo >&2
  fi
  if [ -z "$chat" ] && [ -t 0 ]; then read -r -p "Telegram chat id: " chat; fi
  [ -n "$token" ] && [ -n "$chat" ] || { log "Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, or run this on a terminal"; exit 1; }
  (umask 077 && printf '%s\n' "$token" >"$TELEGRAM_BOT_TOKEN_FILE")
  (umask 077 && printf '%s\n' "$chat" >"$TELEGRAM_CHAT_ID_FILE")
  chmod 600 "$TELEGRAM_BOT_TOKEN_FILE" "$TELEGRAM_CHAT_ID_FILE"
  log "Stored Telegram credentials in $RUN_DIR (mode 600)"
}

# Tell the user how the switch ended: the app is mid-restart and cannot send this itself
notify_switch_result() {
  local phase="$1" token chat text elapsed payload
  token="$(telegram_value bot-token)"; chat="$(telegram_value chat-id)"
  [ -n "$token" ] && [ -n "$chat" ] || return 0
  elapsed=$(( ($(date +%s) * 1000 - ${SWITCH_STARTED:-0}) / 1000 ))
  if [ "$phase" = "ready" ]; then
    text="PharmaITChat: ${SWITCH_TARGET} stack is ready (${elapsed}s)."
  else
    text="PharmaITChat: switch to ${SWITCH_TARGET} failed after ${elapsed}s; ${SWITCH_PREVIOUS} is being restored."
  fi
  payload="$(TEXT="$text" CHAT="$chat" python3 -c 'import json,os;print(json.dumps({"chat_id":os.environ["CHAT"],"text":os.environ["TEXT"]}))')"
  # The URL carries the bot token; put it in curl's stdin config instead of argv, or `ps` would
  # show it to every process on the machine for as long as the request is in flight.
  printf 'url = "%s"\n' "https://api.telegram.org/bot${token}/sendMessage" \
    | curl -K - -sS -m 10 -o /dev/null -X POST -H 'Content-Type: application/json' --data-binary "$payload" \
    || log "Could not send the Telegram completion message"
}

# Token agents send to pharmaitchat-mcp (readable only by you); run-mcp.sh passes it to the service
ensure_mcp_token() {
  if [ -s "$MCP_TOKEN_FILE" ]; then
    log "MCP token already exists at $MCP_TOKEN_FILE"
  else
    (umask 077 && openssl rand -hex 32 >"$MCP_TOKEN_FILE")
    log "Created MCP token at $MCP_TOKEN_FILE"
  fi
  chmod 600 "$MCP_TOKEN_FILE"
}

# pharmaitchat-mcp runs under launchd (installed by scripts/hermes-setup.sh install-services); stack switches leave it running
mcp_service() {
  local domain
  domain="gui/$(id -u)"
  case "${1:-}" in
    start)
      [ -f "$MCP_PLIST" ] || { log "No $MCP_PLIST — run: scripts/hermes-setup.sh install-services"; exit 1; }
      launchctl bootstrap "$domain" "$MCP_PLIST" 2>/dev/null || launchctl kickstart -k "$domain/$MCP_LABEL"
      wait_http "http://127.0.0.1:$MCP_PORT/healthz" 30 \
        || { log "pharmaitchat-mcp did not answer on :$MCP_PORT (see $LOG_DIR/mcp.log)"; exit 1; }
      log "pharmaitchat-mcp is up on :$MCP_PORT"
      ;;
    stop)
      launchctl bootout "$domain/$MCP_LABEL" 2>/dev/null || true
      log "pharmaitchat-mcp stopped"
      ;;
    status)
      if launchctl print "$domain/$MCP_LABEL" >/dev/null 2>&1; then log "  mcp service loaded"; else log "  mcp service not loaded"; fi
      if curl -sf -m 3 "http://127.0.0.1:$MCP_PORT/healthz"; then echo; else log "  mcp (:$MCP_PORT) down"; fi
      ;;
    *)
      log "Usage: scripts/switch-stack.sh mcp start|stop|status"
      exit 1
      ;;
  esac
}

start_app() {
  cd "$PROJECT_DIR"
  # N8N_WEBHOOK_URL: same default as start-services.sh, or the gap loop stops
  # working after the first stack switch
  LLM_PROVIDER="$1" CHROMADB_URL="$CHROMA_URL" PHARMAITCHAT_API_TOKEN="$(api_token)" \
    TELEGRAM_BOT_TOKEN="$(telegram_value bot-token)" TELEGRAM_CHAT_ID="$(telegram_value chat-id)" \
    N8N_WEBHOOK_URL="${N8N_WEBHOOK_URL:-http://localhost:${N8N_PORT:-5678}/webhook/knowledge-gap}" \
    nohup npx tsx src/server.ts >"$LOG_DIR/app.log" 2>&1 &
  echo $! >"$RUN_DIR/app.pid"

  local waited=0 status=""
  while [ "$waited" -lt 180 ]; do
    status="$(curl -sf -m 5 "http://localhost:$APP_PORT/api/health" 2>/dev/null \
      | python3 -c 'import sys, json; print(json.load(sys.stdin)["status"])' 2>/dev/null || true)"
    case "$status" in
      healthy) log "PharmaITChat is up on the $1 stack"; return 0 ;;
      degraded) log "PharmaITChat is up on the $1 stack (degraded: a supporting service is down)"; return 0 ;;
    esac
    sleep 2
    waited=$((waited + 2))
  done
  log "PharmaITChat did not become healthy (last status: ${status:-no response})"
  return 1
}

show_logs() {
  local file
  for file in "$LOG_DIR/mlx-chat.log" "$LOG_DIR/mlx-embed.log" "$LOG_DIR/omlx.log" "$LOG_DIR/splash.log" "$LOG_DIR/app.log"; do
    [ -f "$file" ] || continue
    log "--- last lines of $(basename "$file") ---"
    tail -n 15 "$file"
  done
}

# Stop every stack except the target: with three stacks "the other one" is no longer a single value
stop_other_stacks() {
  local target="$1" other rc=0
  for other in "${STACK_NAMES[@]}"; do
    [ "$other" = "$target" ] && continue
    stop_stack "$other" || rc=$?
  done
  return "$rc"
}

# --- Commands ---------------------------------------------------------------------

switch_to() {
  local target="$1" previous index_failed=0
  previous="$(active_stack)"
  # Set before any pre-flight check so a failure in one of them can still be recorded and
  # notified: without this, a bad stack name or missing models/ChromaDB left the previous
  # switch's terminal state on disk with no "failed" entry, and the UI polled it forever.
  SWITCH_TARGET="$target"; SWITCH_PREVIOUS="$previous"; SWITCH_STARTED="$(($(date +%s) * 1000))"
  write_switch_phase confirmed

  # Tolerant like the rollback path below (stop_app || true): under set -e a bare failing check
  # here would exit before the failed phase/notification are ever written, and the UI would poll
  # "confirmed" forever. Record the specific failure and tell the user instead of going silent.
  if ! validate_stack "$target"; then
    write_switch_phase failed "unknown stack '$target'"
    notify_switch_result failed
    exit 1
  fi
  if ! models_ready "$target"; then
    write_switch_phase failed "models for $target are missing (run scripts/switch-stack.sh prepare)"
    notify_switch_result failed
    exit 1
  fi
  if ! ensure_chromadb; then
    write_switch_phase failed "could not start ChromaDB"
    notify_switch_result failed
    exit 1
  fi

  log "Switching: $previous -> $target"
  write_switch_phase stopping
  # Tolerant like the rollback path below (stop_app || true): under set -e a bare failing stop here
  # would exit before the failed phase/notification are ever written, and the UI would poll
  # "stopping" forever. Record the specific failure and tell the user instead of going silent.
  if ! stop_app; then
    write_switch_phase failed "could not stop the current app"
    notify_switch_result failed
    exit 1
  fi
  if ! stop_other_stacks "$target"; then
    write_switch_phase failed "could not stop the other stacks"
    notify_switch_result failed
    exit 1
  fi

  write_switch_phase starting
  if start_stack "$target"; then
    write_switch_phase warming
    if warm_up "$target"; then
      write_switch_phase indexing
      # Guarded separately from start_app, in the same style as the pre-flight checks above: the
      # catch-all below blames the stack ("did not come up"), which is a lie when the stack started
      # fine and it was the index check or rebuild that failed.
      if ! ensure_index "$target"; then
        write_switch_phase failed "could not prepare the indexes for $target"
        notify_switch_result failed
        index_failed=1
      elif start_app "$target"; then
        echo "$target" >"$RUN_DIR/active-stack"
        write_switch_phase ready
        notify_switch_result ready
        log "Active stack: $target"
        return 0
      fi
    fi
  fi
  if [ "$index_failed" -eq 0 ]; then
    write_switch_phase failed "$target did not come up"
    notify_switch_result failed
  fi

  show_logs
  if [ "$previous" != "$target" ]; then
    log "Rolling back to $previous..."
    stop_app || true
    if ! stop_stack "$target"; then
      log "Could not stop $target; not starting $previous to avoid running both stacks"
      exit 1
    fi
    if start_stack "$previous" && warm_up "$previous" && start_app "$previous"; then
      log "Rolled back to $previous"
    else
      log "Rollback to $previous failed too; see $LOG_DIR"
    fi
  fi
  exit 1
}

ensure_stack() {
  local target="$1"
  validate_stack "$target"
  models_ready "$target" || { log "Models for $target are missing. Run: scripts/switch-stack.sh prepare"; exit 1; }
  stop_other_stacks "$target"
  if ! { start_stack "$target" && warm_up "$target" && ensure_index "$target"; }; then
    show_logs
    exit 1
  fi
  echo "$target" >"$RUN_DIR/active-stack"
}

prepare() {
  local previous
  previous="$(active_stack)"
  log "Preparing all four stacks (about 50 GB of downloads on the first run)"
  stop_app

  # Ollama models: pulling needs the Ollama service, so every other stack must be down first
  stop_other_stacks ollama
  start_ollama
  ollama pull "$OLLAMA_BASE_MODEL"
  ollama pull "$OLLAMA_EMBED_MODEL"
  ollama create "$OLLAMA_CHAT_MODEL" -f "$OLLAMA_MODELFILE"

  # MLX models: files only, no server is started here
  [ -x "$MLX_VENV/bin/python" ] || "$MLX_PYTHON" -m venv "$MLX_VENV"
  "$MLX_VENV/bin/pip" install -q -r "$PROJECT_DIR/python/mlx-requirements.txt"
  "$MLX_VENV/bin/python" -c "from huggingface_hub import snapshot_download as d; d('$MLX_CHAT_MODEL'); d('$MLX_EMBED_MODEL')"

  # oMLX venv: pinned, models come from the same Hugging Face cache
  if [ ! -x "$OMLX_VENV/bin/omlx" ]; then
    log "Installing oMLX $OMLX_VERSION into $OMLX_VENV"
    rm -rf "$PROJECT_DIR/python/omlx-src"
    git clone "$OMLX_REPO" "$PROJECT_DIR/python/omlx-src"
    (cd "$PROJECT_DIR/python/omlx-src" && git checkout -q "$OMLX_VERSION")
    if ! command -v "$OMLX_PYTHON" >/dev/null 2>&1; then
      log "oMLX needs Python >=3.11,<3.14 and '$OMLX_PYTHON' was not found."
      log "Install one, or point OMLX_PYTHON at an interpreter in that range."
      return 1
    fi
    "$OMLX_PYTHON" -m venv "$OMLX_VENV"
    "$OMLX_VENV/bin/pip" install -q -e "$PROJECT_DIR/python/omlx-src"
  fi

  # Splash: a pinned checkout plus a 17.4 GB model package.
  if [ ! -x "$SPLASH_BIN" ]; then
    log "Installing Splash $SPLASH_VERSION into $SPLASH_DIR"
    rm -rf "$SPLASH_DIR"
    git clone "$SPLASH_REPO" "$SPLASH_DIR"
    (cd "$SPLASH_DIR" && git checkout -q "$SPLASH_VERSION")
  fi
  "$MLX_VENV/bin/python" -c "from huggingface_hub import snapshot_download as d; d('$SPLASH_CHAT_MODEL')"
  # The first invocation of the binary is what actually sets up Python dependencies and verifies
  # the manifest (the docs' "first serve" step) -- prepare runs it here, once, with a clear failure
  # naming the binary, instead of leaving it to happen implicitly inside start_splash under a
  # wait_http timeout, where it would very likely time out, fail the switch and roll back.
  "$SPLASH_BIN" --version || { log "Splash binary did not run: $SPLASH_BIN --version failed"; return 1; }

  log "Models ready. Restoring the $previous stack..."
  switch_to "$previous"
}

status() {
  log "Active stack: $(active_stack)"
  local entry name port stack
  for entry in "app:$APP_PORT" "ollama:$OLLAMA_PORT" "mlx-chat:$MLX_CHAT_PORT" "mlx-embed:$MLX_EMBED_PORT" "omlx:$OMLX_PORT" "splash:$SPLASH_PORT" "chromadb:$CHROMA_PORT"; do
    name="${entry%%:*}"
    port="${entry#*:}"
    if port_open "$port"; then log "  $name (:$port) up"; else log "  $name (:$port) down"; fi
  done
  [ -d "$HOME/.omlx" ] && log "  omlx SSD cache: $(du -sh "$HOME/.omlx" 2>/dev/null | cut -f1)"
  local parallel
  parallel="$(launchctl getenv OLLAMA_NUM_PARALLEL 2>/dev/null || true)"
  log "  OLLAMA_NUM_PARALLEL: ${parallel:-not set in launchd (keep it at 1: each parallel slot allocates its own 64k context)}"
  if port_open "$OLLAMA_PORT"; then ollama ps || true; fi
  if curl -sf "${CHROMA_URL}/api/v2/heartbeat" >/dev/null 2>&1; then
    for stack in "${STACK_NAMES[@]}"; do
      (cd "$PROJECT_DIR" && LLM_PROVIDER="$stack" npx tsx scripts/reindex-stack.ts --status) || true
    done
  fi
}

case "${1:-}" in
  ollama|mlx|omlx|splash) switch_to "$1" ;;
  ensure-stack) ensure_stack "${2:-}" ;;
  chat-endpoint) chat_endpoint "${2:-}" ;;
  prepare) prepare ;;
  status) status ;;
  token) ensure_token ;;
  telegram) ensure_telegram ;;
  ollama-ctx) ensure_ollama_ctx ;;
  mcp-token) ensure_mcp_token ;;
  mcp) mcp_service "${2:-}" ;;
  *) sed -n '2,13p' "$0"; exit 1 ;;
esac
