#!/usr/bin/env bash
# Set up Hermes Agent for PharmaITChat: config, secrets, launchd services and scheduled jobs.
# Usage:
#   scripts/hermes-setup.sh check             read-only status (prints variable names, never values)
#   scripts/hermes-setup.sh install-config    copy config.yaml and SOUL.md into ~/.hermes and fill ~/.hermes/.env
#   scripts/hermes-setup.sh install-services  install the pharmaitchat-mcp launch agent and the Hermes gateway service
#   scripts/hermes-setup.sh install-plugin    install the pharmaitchat-switch plugin (Telegram switch buttons) and restart the gateway
#   scripts/hermes-setup.sh install-cron      create or update the scheduled jobs from hermes/cron/jobs.json
#   scripts/hermes-setup.sh all               install-config, install-services, install-plugin, install-cron
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TEMPLATE_DIR="$PROJECT_DIR/hermes"
# shellcheck source=lib/launchd.sh
source "$SCRIPT_DIR/lib/launchd.sh"
# shellcheck source=lib/host.sh
source "$SCRIPT_DIR/lib/host.sh"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
ENV_FILE="$HERMES_HOME/.env"
RUN_DIR="${PHARMAITCHAT_RUN_DIR:-${PHARMALLM_RUN_DIR:-$PROJECT_DIR/data/run}}"
LAUNCH_AGENTS_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
HERMES_BIN="${HERMES_BIN:-hermes}"
LAUNCHCTL_BIN="${LAUNCHCTL_BIN:-launchctl}"
MCP_HEALTH_URL="${MCP_HEALTH_URL:-http://${MCP_HOST}:${MCP_PORT}/healthz}"
MCP_LABEL="com.pharmaitchat.mcp"
N8N_LABEL="com.pharmaitchat.n8n"
JEV_LABEL="com.pharmaitchat.jev"
GATEWAY_LABEL="ai.hermes.gateway"
PLUGIN_NAME="pharmaitchat-switch"
# Only the plugin's own files: the tests next to it in the repo stay out of ~/.hermes
PLUGIN_FILES=(plugin.yaml __init__.py tap.py)
ENV_KEYS=(PHARMALLM_URL PHARMALLM_MCP_URL SEARXNG_URL PHARMAITCHAT_API_TOKEN PHARMALLM_MCP_TOKEN
  TELEGRAM_BOT_TOKEN TELEGRAM_ALLOWED_USERS TELEGRAM_HOME_CHANNEL)

log() {
  printf '[hermes-setup] %s\n' "$*"
}

require_hermes() {
  command -v "$HERMES_BIN" >/dev/null 2>&1 || { log "hermes is not installed — see hermes/README.md"; exit 1; }
}

# Prints one .env value (for internal use only; callers never echo it)
env_get() {
  [ -f "$ENV_FILE" ] || return 0
  python3 - "$ENV_FILE" "$1" <<'PY'
import sys
path, key = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as handle:
    for line in handle:
        name, sep, value = line.rstrip("\n").partition("=")
        if sep and name.strip() == key:
            print(value.strip().strip('"').strip("'"))
            break
PY
}

# Writes KEY=value into .env (mode 600); the value travels through the environment, not argv
env_set() {
  ENV_VALUE="$2" python3 - "$ENV_FILE" "$1" <<'PY'
import os, sys
path, key = sys.argv[1], sys.argv[2]
value = os.environ["ENV_VALUE"]
lines = []
if os.path.exists(path):
    with open(path, encoding="utf-8") as handle:
        lines = handle.read().splitlines()
out, written = [], False
for line in lines:
    name, sep, _ = line.partition("=")
    if sep and name.strip() == key:
        if not written:
            out.append(f"{key}={value}")
            written = True
        continue
    out.append(line)
if not written:
    out.append(f"{key}={value}")
# Write a private temp file next to .env and rename it over: an interruption never truncates the secrets
directory = os.path.dirname(path) or "."
tmp_path = os.path.join(directory, f".env.tmp-{os.getpid()}")
fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write("\n".join(out) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp_path, path)
except BaseException:
    if os.path.exists(tmp_path):
        os.unlink(tmp_path)
    raise
os.chmod(path, 0o600)
PY
}

# Value precedence: token file, current environment, existing .env, default, hidden prompt on a terminal.
# An optional 4th argument is a legacy alias key: written with the same resolved value, so a reader
# still keyed to the legacy name never sees a stale token after a rotation refreshes only the new
# key. hermes/plugins/pharmaitchat-switch/tap.py falls back to PHARMALLM_API_TOKEN when the new one
# is blank, so this belt-and-braces write matters most if that plugin is ever reverted independently.
# Delete the alias argument at the one call site that uses it once the owner retires the legacy key.
fill_env() {
  local key="$1" default="$2" file="${3:-}" legacy="${4:-}" value=""
  if [ -n "$file" ] && [ -s "$file" ]; then
    value="$(tr -d '[:space:]' <"$file")"
  elif [ -n "${!key:-}" ]; then
    value="${!key}"
  else
    value="$(env_get "$key")"
  fi
  if [ -z "$value" ] && [ -n "$default" ]; then value="$default"; fi
  if [ -z "$value" ] && [ -t 0 ]; then
    read -rs -p "$key: " value
    echo >&2
  fi
  if [ -z "$value" ]; then
    local hint=""
    case "$key" in
      PHARMAITCHAT_API_TOKEN) hint=" — generate it with: scripts/switch-stack.sh token" ;;
      PHARMALLM_MCP_TOKEN) hint=" — generate it with: scripts/switch-stack.sh mcp-token" ;;
    esac
    log "Missing $key: add it to $ENV_FILE (chmod 600) and re-run, see hermes/README.md$hint"
    return 1
  fi
  env_set "$key" "$value"
  log "  $key set"
  if [ -n "$legacy" ]; then
    env_set "$legacy" "$value"
    log "  $legacy set (legacy alias, kept in sync until retired)"
  fi
}

install_file() {
  local src="$1" dest="$2"
  if [ -f "$dest" ] && ! cmp -s "$src" "$dest"; then
    cp -p "$dest" "$dest.bak-$(date +%Y%m%d%H%M%S)"
    log "Backed up the previous $(basename "$dest")"
  fi
  cp "$src" "$dest"
}

install_config() {
  mkdir -p "$HERMES_HOME"
  (umask 077 && touch "$ENV_FILE")
  chmod 600 "$ENV_FILE"
  install_file "$TEMPLATE_DIR/config.template.yaml" "$HERMES_HOME/config.yaml"
  install_file "$TEMPLATE_DIR/SOUL.md" "$HERMES_HOME/SOUL.md"
  fill_env PHARMALLM_URL "http://${PHARMAITCHAT_HOST_ADDRESS}:${APP_PORT}"
  fill_env PHARMALLM_MCP_URL "http://${MCP_HOST}:${MCP_PORT}/mcp"
  fill_env SEARXNG_URL "http://${PHARMAITCHAT_HOST_ADDRESS}:${SEARXNG_PORT}"
  fill_env PHARMAITCHAT_API_TOKEN "" "$RUN_DIR/api-token" PHARMALLM_API_TOKEN
  fill_env PHARMALLM_MCP_TOKEN "" "$RUN_DIR/mcp-token"
  fill_env TELEGRAM_BOT_TOKEN ""
  fill_env TELEGRAM_ALLOWED_USERS ""
  # A single chat id, not the whole allow-list: scheduled jobs are delivered to one channel
  fill_env TELEGRAM_HOME_CHANNEL "$(env_get TELEGRAM_ALLOWED_USERS | cut -d, -f1 | tr -d '[:space:]')"
  log "Config installed in $HERMES_HOME"
}

install_services() {
  require_hermes
  [ -s "$RUN_DIR/mcp-token" ] || { log "No MCP token — run: scripts/switch-stack.sh mcp-token"; exit 1; }
  local node_bin plist domain
  node_bin="${NODE_BIN:-$(command -v node || true)}"
  [ -n "$node_bin" ] || { log "node not found on PATH (set NODE_BIN)"; exit 1; }
  mkdir -p "$LAUNCH_AGENTS_DIR" "$PROJECT_DIR/data/logs"
  plist="$LAUNCH_AGENTS_DIR/$MCP_LABEL.plist"
  # MCP_HOST is baked into the plist: `launchctl setenv` is domain-wide and lost on reboot, after which
  # run-mcp.sh would silently fall back to loopback and the LAN move would stop working
  sed -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" \
      -e "s|__NODE_BIN__|$node_bin|g" \
      -e "s|__MCP_HOST__|${MCP_HOST:-127.0.0.1}|g" \
      -e "s|__PATH__|$(launchd_path "$node_bin")|g" \
      "$TEMPLATE_DIR/com.pharmaitchat.mcp.plist.template" >"$plist"
  domain="gui/$(id -u)"
  "$LAUNCHCTL_BIN" bootout "$domain/$MCP_LABEL" >/dev/null 2>&1 || true
  # launchd can still be tearing the old job down and answers "Input/output error"; give it a few tries
  local attempt
  for attempt in 1 2 3 4 5; do
    if "$LAUNCHCTL_BIN" bootstrap "$domain" "$plist"; then break; fi
    if [ "$attempt" -eq 5 ]; then log "launchctl bootstrap failed 5 times for $MCP_LABEL"; exit 1; fi
    sleep 1
  done
  log "Installed and started $MCP_LABEL"

  # n8n hosts the knowledge-gap auto-fill workflow. It is a service rather than
  # a cron job because the app's Gap Detector calls its webhook the moment a gap
  # is detected. It had been down long enough for the loop to be dead without
  # anyone noticing -- the app logs the caught ECONNREFUSED and carries on --
  # so KeepAlive is the point of installing it.
  plist="$LAUNCH_AGENTS_DIR/$N8N_LABEL.plist"
  sed -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" \
      -e "s|__N8N_PORT__|${N8N_PORT}|g" \
      -e "s|__PATH__|$(launchd_path "$node_bin")|g" \
      "$TEMPLATE_DIR/com.pharmaitchat.n8n.plist.template" >"$plist"
  "$LAUNCHCTL_BIN" bootout "$domain/$N8N_LABEL" >/dev/null 2>&1 || true
  for attempt in 1 2 3 4 5; do
    if "$LAUNCHCTL_BIN" bootstrap "$domain" "$plist"; then break; fi
    if [ "$attempt" -eq 5 ]; then log "launchctl bootstrap failed 5 times for $N8N_LABEL"; exit 1; fi
    sleep 1
  done
  log "Installed and started $N8N_LABEL"

  install_jev_service

  "$HERMES_BIN" gateway install --force --start-now --start-on-login
  log "Installed the Hermes gateway service"

  # hermes' own installer bootstraps once and gives up. launchd answers
  # "Input/output error" right after a bootout -- the same transient this
  # script already retries for its own services -- and the gateway then falls
  # back to a bare background process that nothing revives. It exits 1 on
  # signal expecting a supervisor, so after that fallback dies Telegram simply
  # stays down. Retry the bootstrap the same way, stopping the unsupervised
  # process first so two gateways never race for the same Telegram token.
  local gateway_plist="$LAUNCH_AGENTS_DIR/$GATEWAY_LABEL.plist"
  if [ -f "$gateway_plist" ] && ! "$LAUNCHCTL_BIN" print "$domain/$GATEWAY_LABEL" >/dev/null 2>&1; then
    "$HERMES_BIN" gateway stop >/dev/null 2>&1 || true
    for attempt in 1 2 3 4 5; do
      if "$LAUNCHCTL_BIN" bootstrap "$domain" "$gateway_plist"; then
        log "Bootstrapped $GATEWAY_LABEL (hermes' own attempt had failed)"
        break
      fi
      if [ "$attempt" -eq 5 ]; then log "launchctl bootstrap failed 5 times for $GATEWAY_LABEL — the gateway is unsupervised"; fi
      sleep 2
    done
  fi
}

# The scorer's own launchd job, installed as part of install_services. Unlike the
# mcp-token guard above, the scorer is OPTIONAL (src/services/health.ts keeps it out of
# CRITICAL_CHECKS, src/api/dashboard.ts:94 says so explicitly, and scripts/check-services.sh's
# own hint text says its absence means "chat is unaffected"), so a missing prerequisite here
# must SKIP the scorer and return 0 — never abort install_services — so every other service,
# the Hermes gateway especially, still installs. This is an INSTALL-time distinction only:
# scripts/run-jev.sh keeps its own hard guards at RUN time, since a scorer that cannot load a
# gated model must fail loudly rather than start and hang. Do not soften that script.
install_jev_service() {
  local plist domain jev_dir
  jev_dir="${JEV_DIR:-$PROJECT_DIR/../open-jev}"
  if [ ! -x "$jev_dir/.venv/bin/openjev" ]; then
    log "Skipping the jev scorer: no open-jev venv at $jev_dir (run: cd $jev_dir && make setup). The scorer is optional — chat is unaffected."
    return 0
  fi
  if [ ! -s "$RUN_DIR/hf-token" ]; then
    log "Skipping the jev scorer: no $RUN_DIR/hf-token — Gemma 3 4B is gated and will not download. The scorer is optional — chat is unaffected."
    return 0
  fi
  mkdir -p "$LAUNCH_AGENTS_DIR" "$PROJECT_DIR/data/logs"
  plist="$LAUNCH_AGENTS_DIR/$JEV_LABEL.plist"
  sed -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" \
      -e "s|__JEV_DIR__|$jev_dir|g" \
      -e "s|__JEV_HOST__|${JEV_HOST:-127.0.0.1}|g" \
      -e "s|__PATH__|$(launchd_path)|g" \
      "$TEMPLATE_DIR/$JEV_LABEL.plist.template" >"$plist"
  domain="gui/$(id -u)"
  "$LAUNCHCTL_BIN" bootout "$domain/$JEV_LABEL" >/dev/null 2>&1 || true
  # launchd can still be tearing the old job down and answers "Input/output error"; give it a few tries
  local attempt
  for attempt in 1 2 3 4 5; do
    if "$LAUNCHCTL_BIN" bootstrap "$domain" "$plist"; then break; fi
    if [ "$attempt" -eq 5 ]; then
      # Return like the skip paths above: this runs before the gateway install,
      # and an optional scorer must not leave Telegram uninstalled.
      log "launchctl bootstrap failed 5 times for $JEV_LABEL; skipping the jev scorer. The scorer is optional — chat is unaffected."
      return 0
    fi
    sleep 1
  done
  log "Installed and started $JEV_LABEL"
}

install_plugin() {
  require_hermes
  local src="$TEMPLATE_DIR/plugins/$PLUGIN_NAME" dest="$HERMES_HOME/plugins/$PLUGIN_NAME" file
  mkdir -p "$dest"
  for file in "${PLUGIN_FILES[@]}"; do
    cp "$src/$file" "$dest/$file"
  done
  # The flag answers Hermes' "replace built-in tools? [y/N]" prompt for non-bundled plugins, which would
  # otherwise stop an unattended install. The plugin adds a Telegram handler and no tools, so "no" is right.
  "$HERMES_BIN" plugins enable "$PLUGIN_NAME" --no-allow-tool-override
  # The plugin wires its Telegram handler when the gateway connects, so only a restart loads it
  "$HERMES_BIN" gateway restart
  log "Installed the $PLUGIN_NAME plugin and restarted the gateway"
}

install_cron() {
  require_hermes
  HERMES_BIN="$HERMES_BIN" TEMPLATE_DIR="$TEMPLATE_DIR" HERMES_HOME="$HERMES_HOME" PROJECT_DIR="$PROJECT_DIR" \
    python3 - "$TEMPLATE_DIR/cron/jobs.json" "$HERMES_HOME/cron/jobs.json" <<'PY'
import json, os, subprocess, sys

definitions_path, store_path = sys.argv[1], sys.argv[2]
hermes = os.environ["HERMES_BIN"]
template_dir = os.environ["TEMPLATE_DIR"]
hermes_home = os.environ["HERMES_HOME"]
project_dir = os.environ["PROJECT_DIR"]

with open(definitions_path, encoding="utf-8") as handle:
    definitions = json.load(handle)

# Hermes' own job store is read only to find existing job ids by name; all changes go through the CLI
existing = {}
if os.path.exists(store_path):
    with open(store_path, encoding="utf-8") as handle:
        data = json.load(handle)
    jobs = data.get("jobs", []) if isinstance(data, dict) else data
    if isinstance(jobs, dict):
        jobs = list(jobs.values())
    for job in jobs if isinstance(jobs, list) else []:
        if isinstance(job, dict) and job.get("name") and job.get("id"):
            existing[job["name"]] = job["id"]

# R19: a script-mode job (Task 8's watchlist ingest) runs through Hermes'
# --no-agent path -- no LLM step, no positional prompt -- so it needs its own
# branch here rather than forcing it through the prompt-based
# `cron create <schedule> <prompt>` shape every other job uses.
def install_script(script_name):
    # __PROJECT_DIR__ is baked in at install time (same idea as
    # com.pharmaitchat.mcp.plist.template's __PROJECT_DIR__): once this file
    # lives under ~/.hermes/scripts it has no other way to find the repo.
    src = os.path.join(template_dir, "scripts", script_name)
    with open(src, encoding="utf-8") as handle:
        content = handle.read().replace("__PROJECT_DIR__", project_dir)
    scripts_dir = os.path.join(hermes_home, "scripts")
    os.makedirs(scripts_dir, exist_ok=True)
    dest = os.path.join(scripts_dir, script_name)
    with open(dest, "w", encoding="utf-8") as handle:
        handle.write(content)
    os.chmod(dest, 0o755)
    print(f"[hermes-setup] Installed {script_name} into {scripts_dir}")

for job in definitions:
    name, schedule, deliver = job["name"], job["schedule"], job["deliver"]
    if job.get("kind") == "script":
        install_script(job["script"])
        # C1(b): Hermes SIGTERMs then SIGKILLs a --no-agent script's whole
        # process group at cron.script_timeout_seconds (3600 s by default --
        # hermes_cli/config_defaults.py, enforced in cron/scheduler_script.py's
        # _run_job_script). The nightly ingest tags 15-23 s per item, so the
        # default cap is well inside a normal night's work and the kill would
        # land mid-run: no `finally`, no finishRun, an unfinished run row and a
        # failure alert every night. The ingest stops itself at its own budget
        # (DEFAULT_INGEST_BUDGET_MS); this raises the external deadline far
        # above it so it only ever fires on a genuinely wedged process.
        # HERMES_CRON_SCRIPT_TIMEOUT would be read from the *scheduler's* own
        # environment, not the job's, so exporting it in the wrapper does
        # nothing -- the config key is the one that works. It is read fresh on
        # every script run (_get_script_timeout -> load_config), so no gateway
        # restart is needed. The key is global to no-agent cron scripts; this
        # is the only such job.
        timeout_seconds = job.get("script_timeout_seconds")
        if timeout_seconds is not None:
            subprocess.run(
                [hermes, "config", "set", "cron.script_timeout_seconds", str(timeout_seconds)],
                check=True,
                stdout=subprocess.DEVNULL,
            )
            print(f"[hermes-setup] Set cron.script_timeout_seconds to {timeout_seconds}")
        # --deliver local (this job's own default) keeps run state visible in
        # `hermes cron list` without pushing anything on a quiet night;
        # --failure-deliver overrides the target for failure notices only.
        failure_deliver = job.get("failure_deliver", deliver)
        script_args = [
            "--script", job["script"], "--no-agent",
            "--deliver", deliver, "--failure-deliver", failure_deliver,
        ]
        if name in existing:
            command = [hermes, "cron", "edit", existing[name], "--schedule", schedule, *script_args]
            action = "Updated"
        else:
            command = [hermes, "cron", "create", schedule, "--name", name, *script_args]
            action = "Created"
    else:
        prompt = job["prompt"]
        if name in existing:
            command = [hermes, "cron", "edit", existing[name], "--schedule", schedule, "--prompt", prompt, "--deliver", deliver]
            action = "Updated"
        else:
            command = [hermes, "cron", "create", schedule, prompt, "--name", name, "--deliver", deliver]
            action = "Created"
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
    print(f"[hermes-setup] {action} cron job {name}")
PY
}

check() {
  local problems=0 key perms
  if command -v "$HERMES_BIN" >/dev/null 2>&1; then
    log "hermes: installed"
  else
    log "hermes: not installed"
    problems=1
  fi
  for key in config.yaml SOUL.md .env; do
    if [ -f "$HERMES_HOME/$key" ]; then log "$key: present"; else log "$key: missing"; problems=1; fi
  done
  if [ -f "$ENV_FILE" ]; then
    perms="$(stat -f %Lp "$ENV_FILE")"
    log ".env permissions: $perms"
    [ "$perms" = "600" ] || problems=1
  fi
  for key in "${ENV_KEYS[@]}"; do
    if [ -n "$(env_get "$key")" ]; then log "  $key: set"; else log "  $key: missing"; problems=1; fi
  done
  # `hermes gateway install` loads its label in user/$UID while our agent lives in gui/$UID: probe both
  for key in "$MCP_LABEL" ai.hermes.gateway; do
    if "$LAUNCHCTL_BIN" print "gui/$(id -u)/$key" >/dev/null 2>&1 || "$LAUNCHCTL_BIN" print "user/$(id -u)/$key" >/dev/null 2>&1; then
      log "service $key: loaded"
    else
      log "service $key: not loaded"
      problems=1
    fi
  done
  # "Loaded" means the ready file names the gateway now running (pid and start time, and that pid is
  # alive): a pid alone can be reused after a crash, and both records outlive a gateway that died.
  # The wording avoids "not loaded", which reports services above.
  if [ ! -f "$HERMES_HOME/plugins/$PLUGIN_NAME/plugin.yaml" ]; then
    log "plugin $PLUGIN_NAME: missing"
    problems=1
  elif python3 - "$HERMES_HOME" "$PLUGIN_NAME" <<'PY'
import json, os, sys
from pathlib import Path
home, name = Path(sys.argv[1]), sys.argv[2]
try:
    gateway = json.loads((home / "gateway.pid").read_text(encoding="utf-8"))
    ready = json.loads((home / f"{name}.ready.json").read_text(encoding="utf-8"))
except (OSError, ValueError):
    sys.exit(1)
if not isinstance(gateway, dict) or not isinstance(ready, dict):
    sys.exit(1)
pid = ready.get("pid")
same = (pid, ready.get("start_time")) == (gateway.get("pid"), gateway.get("start_time"))
if not same or not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
    sys.exit(1)
try:
    os.kill(pid, 0)  # signal 0 only probes: nothing is sent
except PermissionError:
    pass  # alive, owned by another user
except (ProcessLookupError, OverflowError, OSError):
    sys.exit(1)
sys.exit(0)
PY
  then
    log "plugin $PLUGIN_NAME: loaded by the running gateway"
  else
    log "plugin $PLUGIN_NAME: installed, waiting for a gateway restart"
    problems=1
  fi
  # /healthz answers 200 with {"ok":true,"pharmaitchat":false} while the app behind the service is down,
  # so a 200 alone says nothing: parse the field instead of trusting the status code
  local health
  if health="$(curl -sf -m 3 "$MCP_HEALTH_URL" 2>/dev/null)"; then
    if printf '%s' "$health" | python3 -c 'import json,sys
try:
    sys.exit(0 if json.load(sys.stdin).get("pharmaitchat") is True else 1)
except Exception:
    sys.exit(1)'; then
      log "pharmaitchat-mcp: healthy"
    else
      log "pharmaitchat-mcp: up, PharmaITChat not reachable"
      problems=1
    fi
  else
    log "pharmaitchat-mcp: not answering"
    problems=1
  fi
  return "$problems"
}

case "${1:-}" in
  check) check ;;
  install-config) install_config ;;
  install-services) install_services ;;
  install-plugin) install_plugin ;;
  install-cron) install_cron ;;
  # Separate statements, not &&: set -e is ignored inside && lists, which would hide a failed install_config
  all)
    install_config
    install_services
    install_plugin
    install_cron
    ;;
  *) sed -n '2,9p' "$0"; exit 1 ;;
esac
