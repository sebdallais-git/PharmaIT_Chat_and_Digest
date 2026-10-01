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
# JEV_HOST, JEV_PORT and JEV_MLX_CACHE_LIMIT come from config/host.yaml (exits on an invalid profile)
# shellcheck source=lib/host.sh
source "$SCRIPT_DIR/lib/host.sh"

read_token() {
  if [ -s "$1" ]; then tr -d '[:space:]' <"$1"; fi
}

# The spec's 4-bit scorer (~3 GB), relative to $JEV_DIR. Without --model the
# server loaded open-jev's 16-bit default (8 GB), which starved memory beside
# the 27B and scored the baseline gaps worse (71.9% vs 91.2% agreement).
export JEV_MODEL="${JEV_MODEL:-models/gemma-3-4b-it-4bit}"
case "$JEV_MLX_CACHE_LIMIT" in
  ''|*[!0-9]*)
    echo "run-jev: JEV_MLX_CACHE_LIMIT must be a byte count, got '$JEV_MLX_CACHE_LIMIT'" >&2
    exit 1
    ;;
esac
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
# open-jev itself sets no cache limit, so the cap is set in its process before
# its CLI starts (same entry point as .venv/bin/openjev). The value is read from
# the environment, never pasted into the code string.
exec .venv/bin/python -c 'import os, sys, mlx.core as mx; mx.set_cache_limit(int(os.environ["JEV_MLX_CACHE_LIMIT"])); from openjev.cli import main; main(sys.argv[1:])' \
  serve --host "$JEV_HOST" --port "$JEV_PORT" --model "$JEV_MODEL"
