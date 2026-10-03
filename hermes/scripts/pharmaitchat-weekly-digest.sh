#!/usr/bin/env bash
# Hermes script-mode cron job: the weekly digest, Mondays 07:30, over the
# previous Monday-to-Sunday week, for the active role.
#
# Installed by scripts/hermes-setup.sh install-cron into ~/.hermes/scripts/,
# with __PROJECT_DIR__ replaced by this repo's absolute path at install time.
#
# Unlike the canary and ingest jobs this one runs with --deliver telegram: its
# stdout IS the message. scripts/digest.ts prints the digest (within one
# Telegram message), or one line saying why it failed and exits 1. Each run's
# output is also kept in data/logs/weekly-digest-<date>.log. With --email the
# full digest also goes by email when config/email.local.yaml exists; whether
# it went ("email: sent to …" / "email failed: …") is in that log.
set -uo pipefail

PROJECT_DIR="__PROJECT_DIR__"
cd "$PROJECT_DIR" || { echo "Weekly digest: cannot cd to $PROJECT_DIR"; exit 1; }

# The digest runs in-process against the active stack, like the nightly ingest
if [ -z "${LLM_PROVIDER:-}" ] && [ -s "$PROJECT_DIR/data/run/active-stack" ]; then
  LLM_PROVIDER="$(cat "$PROJECT_DIR/data/run/active-stack")"
  export LLM_PROVIDER
fi

LOG_DIR="$PROJECT_DIR/data/logs"
LOG_FILE="$LOG_DIR/weekly-digest-$(date +%F).log"
mkdir -p "$LOG_DIR" || { echo "Weekly digest: cannot create $LOG_DIR"; exit 1; }
printf '=== %s weekly digest ===\n' "$(date +%FT%T%z)" >>"$LOG_FILE"

# pipefail makes $? the digest script's status, not tee's
OUTPUT="$(npx tsx scripts/digest.ts --request "digest of last week" --email 2>>"$LOG_FILE" | tee -a "$LOG_FILE")"
STATUS=$?

if [ -n "$OUTPUT" ]; then
  echo "$OUTPUT"
else
  echo "Weekly digest failed (exit $STATUS), see data/logs/weekly-digest-$(date +%F).log"
fi

exit "$STATUS"
