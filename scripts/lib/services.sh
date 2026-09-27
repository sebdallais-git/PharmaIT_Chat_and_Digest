#!/usr/bin/env bash
# Shared helpers for start-services.sh and switch-stack.sh. Source this file; don't execute it.

PROJECT_DIR="${PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
CHROMA_PORT="${CHROMADB_PORT:-8100}"
CHROMA_URL="http://localhost:${CHROMA_PORT}"
CHROMA_BIN="$PROJECT_DIR/python/venv/bin/chroma"
CHROMA_DATA="$PROJECT_DIR/.chromadb-data"

# launchd starts the stack with PATH=node/bin:/usr/bin:/bin:/usr/sbin:/sbin, which
# leaves out Homebrew, where docker and colima live. Without this ensure_containers
# never found docker at boot and always reported it as not running.
SERVICES_EXTRA_PATH="${SERVICES_EXTRA_PATH:-/opt/homebrew/bin:/usr/local/bin}"
IFS=':' read -r -a _extra_dirs <<<"$SERVICES_EXTRA_PATH"
for _dir in "${_extra_dirs[@]}"; do
  case ":$PATH:" in *":$_dir:"*) ;; *) PATH="$PATH:$_dir" ;; esac
done
unset _dir _extra_dirs
export PATH

log() {
  printf '[%s] %s\n' "${LOG_PREFIX:-services}" "$*"
}

# Poll a URL until it answers with 2xx, or give up after SECONDS
wait_http() {
  local url="$1" timeout="$2" waited=0
  until curl -sf -m 2 "$url" >/dev/null 2>&1; do
    [ "$waited" -ge "$timeout" ] && return 1
    sleep 1
    waited=$((waited + 1))
  done
}

port_open() {
  nc -z localhost "$1" >/dev/null 2>&1
}

wait_port_closed() {
  local port="$1" timeout="$2" waited=0
  while port_open "$port"; do
    [ "$waited" -ge "$timeout" ] && return 1
    sleep 1
    waited=$((waited + 1))
  done
}

# True when PID is a live process whose command line contains this project's path.
# Other projects run dev servers with the same commands and ports, so this is the only safe kill check.
# True when PID is one of ours. The command line is the usual evidence, but a process that
# renames itself has none: oMLX pulls in setproctitle and appears as plain "omlx-server", so
# the path test below fails for our own server and the script then refuses both to reuse it
# and to stop it. A pid we recorded in a pid file is ours by construction, so check that too.
is_project_pid() {
  local pid="${1:-}" cmd pidfile
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  # RUN_DIR is set by switch-stack.sh but not by every sourcer, so tolerate it being unset.
  if [ -n "${RUN_DIR:-}" ]; then
    for pidfile in "$RUN_DIR"/*.pid; do
      [ -f "$pidfile" ] || continue
      [ "$(cat "$pidfile" 2>/dev/null)" = "$pid" ] && return 0
    done
  fi
  cmd="$(ps -ww -p "$pid" -o command= 2>/dev/null)" || return 1
  [[ "$cmd" == *"$PROJECT_DIR/"* ]]
}

# PIDs listening on a TCP port, one per line (empty when nothing listens)
port_listeners() {
  lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true
}

# Send SIGNAL to the project's listeners on PORT. Returns 1, without signaling anything,
# when a listener belongs to another program. With IGNORE_FOREIGN="ignore-foreign", a foreign
# listener is logged and left alone instead of aborting the call.
signal_port() {
  local port="$1" signal="$2" ignore_foreign="${3:-}" pid pids foreign=0
  pids="$(port_listeners "$port")"
  for pid in $pids; do
    kill -0 "$pid" 2>/dev/null || continue  # already gone; not foreign
    is_project_pid "$pid" && continue
    if [ "$ignore_foreign" = "ignore-foreign" ]; then
      log "Port $port is used by another program (pid $pid: $(ps -ww -p "$pid" -o command= 2>/dev/null || echo unknown)) — leaving it alone"
    else
      log "Port $port is used by another program (pid $pid: $(ps -ww -p "$pid" -o command= 2>/dev/null || echo unknown)) — not stopping it"
      foreign=1
    fi
  done
  [ "$foreign" -eq 0 ] || return 1
  for pid in $pids; do
    kill -0 "$pid" 2>/dev/null || continue
    is_project_pid "$pid" && kill -"$signal" "$pid" 2>/dev/null || true
  done
}

# True when a project-owned process is still listening on PORT (a foreign listener doesn't count).
project_listener_open() {
  local port="$1" pid
  for pid in $(port_listeners "$port"); do
    kill -0 "$pid" 2>/dev/null || continue
    is_project_pid "$pid" && return 0
  done
  return 1
}

# Free PORT: TERM the project's listeners, wait up to TIMEOUT seconds, then KILL them.
# Fails when the port is held by another program or a project listener stays up.
# With IGNORE_FOREIGN="ignore-foreign", a foreign listener is left alone (not counted as
# failure) and only a surviving project listener fails the call.
stop_port() {
  local port="$1" timeout="$2" ignore_foreign="${3:-}" waited=0
  port_open "$port" || return 0
  signal_port "$port" TERM "$ignore_foreign" || return 1
  if [ "$ignore_foreign" = "ignore-foreign" ]; then
    while project_listener_open "$port"; do
      [ "$waited" -ge "$timeout" ] && break
      sleep 1
      waited=$((waited + 1))
    done
    project_listener_open "$port" || return 0
    signal_port "$port" KILL "$ignore_foreign" || return 1
    sleep 1
    ! project_listener_open "$port"
  else
    wait_port_closed "$port" "$timeout" && return 0
    signal_port "$port" KILL "$ignore_foreign" || return 1
    wait_port_closed "$port" 5
  fi
}

# TERM the process recorded in PIDFILE (and its direct children) if it belongs to the project,
# then remove the file. A stale file (dead PID or a PID reused by another program) is just removed.
stop_pidfile_process() {
  local pidfile="$1" pid child
  [ -f "$pidfile" ] || return 0
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    # npx parents don't carry the project path, but their tsx/node children do
    for child in $(pgrep -P "$pid" 2>/dev/null || true); do
      if is_project_pid "$child"; then kill -TERM "$child" 2>/dev/null || true; fi
    done
    if is_project_pid "$pid"; then kill -TERM "$pid" 2>/dev/null || true; fi
  fi
  rm -f "$pidfile"
}

# Neo4j and SearXNG are containers in colima. Their restart policy is
# unless-stopped, so they return once colima is up, and the stack's launchd job
# (RunAtLoad) gets here at login. So: start colima if Docker is unreachable,
# start the containers, and say so plainly if that fails, rather than letting
# the graph and web search fail later with something that looks unrelated.
ensure_containers() {
  # The containers live in colima. Nothing else starts it after a reboot, and
  # `colima start` is a no-op when it is already running.
  if ! docker info >/dev/null 2>&1 && command -v colima >/dev/null 2>&1; then
    log "Docker is not reachable: starting colima..."
    colima start >/dev/null 2>&1 || log "colima start failed"
  fi
  if ! docker info >/dev/null 2>&1; then
    log "Docker is not running: Neo4j (graph) and SearXNG (web search) are unavailable."
    log "  Start the container runtime: colima start (or Docker Desktop, if that is where the containers are)."
    return 0
  fi
  local name
  for name in neo4j searxng; do
    if [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" = "true" ]; then
      log "$name already running"
    elif docker start "$name" >/dev/null 2>&1; then
      log "Started $name"
    else
      log "Could not start $name (no such container?)"
    fi
  done
}

ensure_chromadb() {
  if curl -sf "${CHROMA_URL}/api/v2/heartbeat" >/dev/null 2>&1; then
    log "ChromaDB already running on port ${CHROMA_PORT}"
    return 0
  fi

  if [ ! -f "$CHROMA_BIN" ]; then
    log "ChromaDB not installed. Setting up Python venv..."
    python3 -m venv "$PROJECT_DIR/python/venv"
    "$PROJECT_DIR/python/venv/bin/pip" install -q chromadb
  fi

  log "Starting ChromaDB on port ${CHROMA_PORT}..."
  mkdir -p "$CHROMA_DATA"
  nohup "$CHROMA_BIN" run --port "$CHROMA_PORT" --path "$CHROMA_DATA" >/dev/null 2>&1 &
  wait_http "${CHROMA_URL}/api/v2/heartbeat" 30 || { log "ChromaDB failed to start within 30s"; return 1; }
  log "ChromaDB ready"
}
