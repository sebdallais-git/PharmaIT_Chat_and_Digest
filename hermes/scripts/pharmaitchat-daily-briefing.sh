#!/usr/bin/env bash
# Hermes script-mode cron job: the weekday briefing, Tuesday to Friday 07:30,
# over yesterday's news about the active role's accounts, ending with action
# items. (Monday gets the full weekly digest at the same time instead.)
#
# Installed by scripts/hermes-setup.sh install-cron into ~/.hermes/scripts/,
# with __PROJECT_DIR__ replaced by this repo's absolute path at install time.
#
# Runs with --deliver telegram: stdout is the message, and an empty stdout is
# silent. scripts/digest.ts --briefing prints nothing on a day with no account
# news, so a quiet day sends nothing. It replaced the 06:00 "news digest" job,
# which reported the retired news agent's "0 new articles" every morning.
# With --email the full briefing also goes by email when config/email.local.yaml
# exists (and a quiet day sends no email either).
set -uo pipefail

PROJECT_DIR="__PROJECT_DIR__"
cd "$PROJECT_DIR" || { echo "Daily briefing: cannot cd to $PROJECT_DIR"; exit 1; }

# The briefing runs in-process against the active stack, like the nightly ingest
if [ -z "${LLM_PROVIDER:-}" ] && [ -s "$PROJECT_DIR/data/run/active-stack" ]; then
  LLM_PROVIDER="$(cat "$PROJECT_DIR/data/run/active-stack")"
  export LLM_PROVIDER
fi

LOG_DIR="$PROJECT_DIR/data/logs"
LOG_FILE="$LOG_DIR/daily-briefing-$(date +%F).log"
mkdir -p "$LOG_DIR" || { echo "Daily briefing: cannot create $LOG_DIR"; exit 1; }
printf '=== %s daily briefing ===\n' "$(date +%FT%T%z)" >>"$LOG_FILE"

# pipefail makes $? the script's status, not tee's
OUTPUT="$(npx tsx scripts/digest.ts --request "briefing of yesterday" --briefing --email 2>>"$LOG_FILE" | tee -a "$LOG_FILE")"
STATUS=$?

if [ "$STATUS" -ne 0 ] && [ -z "$OUTPUT" ]; then
  echo "Daily briefing failed (exit $STATUS), see data/logs/daily-briefing-$(date +%F).log"
elif [ -n "$OUTPUT" ]; then
  echo "$OUTPUT"
fi

exit "$STATUS"
