#!/usr/bin/env bash
# Find Hermes agent sessions that outlived an MCP server rename and are still calling dead tool names.
# Read-only: inspects the session store, the agent log and the cron job definitions, and mutates nothing.
# Usage:
#   scripts/check-stale-sessions.sh            report on the live sessions and recent dead-name errors
#   scripts/check-stale-sessions.sh --quiet    print only problems (for use before or after a rename)
# Exits 1 when a routed session predates the current MCP registration or a dead-name error is found.
set -euo pipefail

HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
DB="$HERMES_HOME/state.db"
AGENT_LOG="$HERMES_HOME/logs/agent.log"
JOBS_JSON="$HERMES_HOME/cron/jobs.json"
QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

[ -f "$DB" ] || { echo "no session store at $DB" >&2; exit 2; }

# The newest "registered N tool(s)" line marks the current tool namespace. Any session that has been
# routed since before that moment may still be imitating tool names from the previous one.
python3 - "$DB" "$AGENT_LOG" "$JOBS_JSON" "$QUIET" <<'PY'
import json, os, re, sqlite3, sys
from datetime import datetime

db, agent_log, jobs_json, quiet = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"
problems = []

def say(*a):
    if not quiet:
        print(*a)

# --- current MCP namespace, from the newest registration line -------------------------------------
registered, cutoff = {}, None
reg_re = re.compile(r"^(\S+ \S+).*MCP server '([^']+)' \(HTTP\): registered (\d+) tool")
if os.path.exists(agent_log):
    with open(agent_log, errors="replace") as fh:
        for line in fh:
            m = reg_re.match(line)
            if m:
                stamp, name, count = m.group(1), m.group(2), m.group(3)
                cutoff = stamp                      # last registration wins
                registered[name] = (count, stamp)

if cutoff:
    cutoff_dt = datetime.strptime(cutoff.split(",")[0], "%Y-%m-%d %H:%M:%S")
    # Servers register in one burst at gateway start. Keep only that burst: a server last seen in an
    # earlier burst has been renamed away, and must not count as live or the cron check misses it.
    registered = {
        n: v for n, v in registered.items()
        if (cutoff_dt - datetime.strptime(v[1].split(",")[0], "%Y-%m-%d %H:%M:%S")).total_seconds() <= 120
    }
    say(f"current MCP namespace (as of {cutoff}):")
    for name, (count, stamp) in sorted(registered.items()):
        say(f"  mcp__{name}__*  {count} tools  registered {stamp}")
else:
    cutoff_dt = None
    say("no MCP registration found in the agent log — cannot date the namespace")

# --- live routed sessions -------------------------------------------------------------------------
con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
routed = set()
say("\nrouted sessions:")
for (entry_json,) in con.execute("SELECT entry_json FROM gateway_routing"):
    e = json.loads(entry_json)
    sid, key = e.get("session_id", "?"), e.get("session_key", "?")
    routed.add(sid)
    created = (e.get("created_at") or "")[:19]
    row = con.execute(
        "SELECT message_count, tool_call_count FROM sessions WHERE id = ?", (sid,)
    ).fetchone() or (0, 0)
    stale = ""
    if cutoff_dt and created:
        try:
            if datetime.strptime(created, "%Y-%m-%dT%H:%M:%S") < cutoff_dt and row[1] > 0:
                stale = "  <-- STALE: predates the current namespace and has called tools"
                problems.append(f"session {sid} ({key}) started {created}, {row[1]} tool calls")
        except ValueError:
            pass
    say(f"  {sid}  {key}")
    say(f"    started {created}  messages={row[0]} tool_calls={row[1]}"
        f"  fresh_reset={e.get('is_fresh_reset')}{stale}")

# --- dead-name errors since the current namespace took effect --------------------------------------
dead = {}
if os.path.exists(agent_log):
    err_re = re.compile(r"^(\S+ \S+).*\[([^\]]+)\].*'(mcp__\w+)' is not a deferrable tool")
    with open(agent_log, errors="replace") as fh:
        for line in fh:
            m = err_re.match(line)
            if m and (not cutoff or m.group(1) >= cutoff):
                dead.setdefault((m.group(2), m.group(3)), 0)
                dead[(m.group(2), m.group(3))] += 1

# Only a session that is still routed can call a dead name again; errors from a session that has
# since been rotated away are history, so they are reported but do not fail the check.
say("\ndead-name tool calls since the namespace changed:")
if dead:
    for (sid, tool), n in sorted(dead.items()):
        marker = "  <-- STILL ROUTED" if sid in routed else "  (retired session)"
        say(f"  {sid}  {tool}  x{n}{marker}")
        if sid in routed:
            problems.append(f"routed session {sid} called {tool} ({n}x) after the rename")
else:
    say("  none")

# --- cron job definitions holding a name that is no longer registered -------------------------------
say("\ncron job definitions:")
if os.path.exists(jobs_json):
    data = json.load(open(jobs_json))
    jobs = data if isinstance(data, list) else data.get("jobs", data)
    if isinstance(jobs, dict):
        jobs = list(jobs.values())
    live = set(registered)
    for j in jobs:
        blob = json.dumps(j)
        # Any mcp__<server>__ mentioned in the job whose server is not currently registered.
        orphans = {s for s in re.findall(r"mcp__(\w+?)__", blob) if s not in live}
        flag = f"  <-- references {sorted(orphans)}" if orphans else ""
        say(f"  {j.get('name','?'):34} enabled={j.get('enabled')}{flag}")
        if orphans:
            problems.append(f"cron job {j.get('name')} references {sorted(orphans)}")
else:
    say("  no jobs.json")

# --- verdict ----------------------------------------------------------------------------------------
if problems:
    print("\nAT RISK:")
    for p in problems:
        print(f"  - {p}")
    print("\nRotate each affected chat session from inside that chat (/new), then re-run.")
    sys.exit(1)

print("\nOK: no session predates the current MCP namespace, no dead-name calls, no stale cron refs.")
PY
