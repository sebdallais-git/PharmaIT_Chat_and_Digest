#!/usr/bin/env bash
# Start ChromaDB, the active LLM stack and the PharmaITChat dev server
# Usage: ./scripts/start-services.sh   (switch stacks with scripts/switch-stack.sh ollama|mlx)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_PREFIX="start-services"
# shellcheck source=lib/services.sh
source "$SCRIPT_DIR/lib/services.sh"

STACK="$(cat "$PROJECT_DIR/data/run/active-stack" 2>/dev/null || echo ollama)"

cleanup() {
  echo ""
  log "Shutting down services..."
  # Kill all child processes
  kill 0 2>/dev/null
  exit 0
}
trap cleanup SIGINT SIGTERM

ensure_containers
ensure_chromadb
"$SCRIPT_DIR/switch-stack.sh" ensure-stack "$STACK"

log "Starting PharmaITChat dev server on the $STACK stack..."
cd "$PROJECT_DIR"
export CHROMADB_URL="$CHROMA_URL"
export LLM_PROVIDER="$STACK"
# API token for agents and other machines, created by scripts/switch-stack.sh token
if [ -s "$PROJECT_DIR/data/run/api-token" ]; then
  export PHARMAITCHAT_API_TOKEN="$(cat "$PROJECT_DIR/data/run/api-token")"
fi
# Where the Gap Detector sends each gap it finds. Without it the app logs
# "N8N_WEBHOOK_URL not set" and the auto-fill workflow never runs.
export N8N_WEBHOOK_URL="${N8N_WEBHOOK_URL:-http://localhost:${N8N_PORT:-5678}/webhook/knowledge-gap}"
npx tsx watch src/server.ts &

# Wait for all background processes
wait
