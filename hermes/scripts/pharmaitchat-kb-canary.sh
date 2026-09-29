#!/usr/bin/env bash
# Hermes script-mode cron job: asks the KB canaries (config/kb-canaries.yaml).
#
# Installed by scripts/hermes-setup.sh install-cron into ~/.hermes/scripts/,
# with __PROJECT_DIR__ replaced by this repo's absolute path at install time.
#
# Runs with --no-agent, --deliver local and --failure-deliver telegram (see
# hermes/cron/jobs.json): stdout is what Hermes sends, and only on a non-zero
# exit. scripts/kb-canary.ts prints nothing on stdout when every canary passed
# and a short summary when one did not; its per-canary lines go to stderr,
# which this wrapper keeps in a dated log.
set -uo pipefail

PROJECT_DIR="__PROJECT_DIR__"
cd "$PROJECT_DIR" || { echo "KB canary: cannot cd to $PROJECT_DIR"; exit 1; }

LOG_DIR="$PROJECT_DIR/data/logs"
LOG_FILE="$LOG_DIR/kb-canary-$(date +%F).log"
mkdir -p "$LOG_DIR" || { echo "KB canary: cannot create $LOG_DIR"; exit 1; }
printf '=== %s kb canary ===\n' "$(date +%FT%T%z)" >>"$LOG_FILE"

# pipefail makes $? the canary script's status, not tee's
OUTPUT="$(npx tsx scripts/kb-canary.ts 2>>"$LOG_FILE" | tee -a "$LOG_FILE")"
STATUS=$?

if [ "$STATUS" -ne 0 ]; then
  if [ -n "$OUTPUT" ]; then
    echo "$OUTPUT"
  else
    echo "KB canary failed (exit $STATUS), see data/logs/kb-canary-$(date +%F).log"
  fi
fi

exit "$STATUS"
