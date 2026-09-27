#!/usr/bin/env bash
# launchd entry point for pharmaitchat-jev: reads the scorer and Hugging Face
# tokens from data/run and starts open-jev. Tokens are passed through the
# environment only, never as arguments.
#
# Follows scripts/run-mcp.sh, including its refusal to listen beyond loopback
# without a token.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RUN_DIR="${PHARMALLM_RUN_DIR:-$PROJECT_DIR/data/run}"
JEV_DIR="${JEV_DIR:-$PROJECT_DIR/../open-jev}"

read_token() {
  if [ -s "$1" ]; then tr -d '[:space:]' <"$1"; fi
}

export JEV_HOST="${JEV_HOST:-127.0.0.1}"
export JEV_PORT="${JEV_PORT:-8010}"   # 8000 belongs to the Splash stack
OPENJEV_API_KEY="$(read_token "$RUN_DIR/jev-token")"
HF_TOKEN="$(read_token "$RUN_DIR/hf-token")"
export OPENJEV_API_KEY HF_TOKEN

# Gemma 3 4B is gated on Hugging Face: without a token the server starts and
# then fails to load a model, which looks like a hang. Fail here instead.
if [ -z "$HF_TOKEN" ]; then
  echo "run-jev: $RUN_DIR/hf-token is missing or empty; Gemma 3 4B is a gated model and will not download" >&2
  exit 1
fi

case "$JEV_HOST" in
  127.0.0.1|localhost|::1) ;;
  *)
    if [ -z "$OPENJEV_API_KEY" ]; then
      echo "run-jev: refusing to listen on $JEV_HOST without $RUN_DIR/jev-token" >&2
      exit 1
    fi
    ;;
esac

# Test hook: a stub replaces the real service
if [ -n "${RUN_JEV_EXEC:-}" ]; then
  exec "$RUN_JEV_EXEC"
fi

cd "$JEV_DIR"
exec .venv/bin/openjev serve --host "$JEV_HOST" --port "$JEV_PORT"
