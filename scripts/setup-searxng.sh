#!/usr/bin/env bash
# (Re)create the local SearXNG container from config/searxng/settings.yml.
#
# The container used to carry its own copy of the settings in an anonymous
# volume, so nothing about it was reproducible. This keeps what it ran with
# (image, name, restart policy, :8888) and builds its settings from the repo.
# Run it again after editing the settings or changing a key.
#
# Two secrets, both created or read from data/run (mode 600) and passed through
# the environment only (`-e NAME` names the variable, so no value ever appears
# in docker's argv):
#   searxng-secret   SearXNG's own secret key, created here once
#   brave-api-key    optional Brave Search API key, created by hand
#
# SearXNG reads engine API keys only from its settings file, so the repo file is
# mounted read-only as a base and scripts/lib/render-searxng-settings.py (sent on
# stdin) writes the container's settings.yml with the key filled in, mode 600,
# inside the container's own volume. The entrypoint keeps an existing
# settings.yml, so a restart then serves the rendered file.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RUN_DIR="${PHARMALLM_RUN_DIR:-$PROJECT_DIR/data/run}"
SETTINGS="$PROJECT_DIR/config/searxng/settings.yml"
RENDER="$SCRIPT_DIR/lib/render-searxng-settings.py"
SECRET_FILE="$RUN_DIR/searxng-secret"
BRAVE_KEY_FILE="$RUN_DIR/brave-api-key"
SEARXNG_PORT="${SEARXNG_PORT:-8888}"
CONTAINER_PYTHON="/usr/local/searxng/.venv/bin/python"

[ -f "$SETTINGS" ] || { echo "setup-searxng: no settings at $SETTINGS" >&2; exit 1; }

mkdir -p "$RUN_DIR"
if [ ! -s "$SECRET_FILE" ]; then
  (umask 077 && od -An -tx1 -N32 /dev/urandom | tr -d ' \n' >"$SECRET_FILE")
fi
SEARXNG_SECRET="$(tr -d '[:space:]' <"$SECRET_FILE")"
export SEARXNG_SECRET

if [ -s "$BRAVE_KEY_FILE" ]; then
  BRAVE_API_KEY="$(tr -d '[:space:]' <"$BRAVE_KEY_FILE")"
  export BRAVE_API_KEY
  brave="with the Brave Search API"
else
  unset BRAVE_API_KEY
  brave="without the Brave Search API (no $BRAVE_KEY_FILE)"
fi

docker rm -f searxng >/dev/null 2>&1 || true
docker run -d \
  --name searxng \
  --restart unless-stopped \
  -p "$SEARXNG_PORT:8080" \
  -v "$SETTINGS:/etc/searxng/base.yml:ro" \
  -e SEARXNG_SECRET \
  searxng/searxng >/dev/null

docker exec -i -e BRAVE_API_KEY searxng \
  "$CONTAINER_PYTHON" - /etc/searxng/base.yml /etc/searxng/settings.yml <"$RENDER"
docker restart searxng >/dev/null

echo "setup-searxng: searxng recreated on :$SEARXNG_PORT $brave"
