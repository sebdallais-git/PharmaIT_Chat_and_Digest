# Hermes Agent for PharmaITChat

Everything needed to run [Hermes Agent](https://hermes-agent.nousresearch.com/) as a Telegram assistant on PharmaITChat, on this Mac or on a second Mac on the LAN. Secrets never live here: they stay in `~/.hermes/.env` and `data/run/*-token` (mode 600).

| File | Purpose |
|---|---|
| `config.template.yaml` | Hermes config: the app's `/v1` model with 64k context, a `pharmaitchat` MCP server (19 tools, no `start_reindex`), a `pharmaitchat_cron` server for scheduled runs (17 tools, no `my_role`, also no `add_knowledge`), Docker sandbox without network, local SearXNG search, deny approvals when unattended |
| `SOUL.md` | Assistant role and tool policy |
| `cron/jobs.json` | The seven scheduled jobs: watchlist ingest 02:30, KB canaries 05:00, gap resolution 07:00, weekly digest Monday 07:30, daily briefing Tuesday–Friday 07:30, health watch 09/19 (silent when healthy), feedback digest Monday 08:00 |
| `scripts/pharmaitchat-watchlist-ingest.sh` | The watchlist ingest job's script body (the canary, weekly-digest and daily-briefing jobs have one each alongside it); `install-cron` copies it into `~/.hermes/scripts/` with the repo's path baked in |
| `plugins/pharmaitchat-switch/` | Plugin that receives the Telegram **Switch** / **Cancel** buttons for a stack switch |
| `tests/test_pharmaitchat_switch.py` | The plugin's unit tests (`npm run test:hermes-plugin`) |
| `com.pharmaitchat.mcp.plist.template` | launchd service for `pharmaitchat-mcp` |

## 1. Install Hermes (once)

The installer is pinned to a reviewed commit. It installs uv and Python into `~/.hermes`, clones Hermes to `~/.hermes/hermes-agent` and appends a PATH line to `~/.zshrc`, `~/.zprofile` and `~/.profile`. The flags skip the browser download, the third-party computer-use driver and the setup wizard.

```bash
HERMES_COMMIT=228022ef5b209cb0a3d739394edddf887e1db0f6
curl -fsSL "https://raw.githubusercontent.com/NousResearch/hermes-agent/$HERMES_COMMIT/scripts/install.sh" -o /tmp/hermes-install.sh
less /tmp/hermes-install.sh     # review before running
bash /tmp/hermes-install.sh --commit "$HERMES_COMMIT" --skip-setup --skip-browser --skip-computer-use --non-interactive
exec zsh -l
```

`exec` replaces the shell, so anything after it on the same line never runs. Check the install in the new shell:

```bash
hermes --version
```

## 2. Create the Telegram bot

1. In Telegram, message **@BotFather**, send `/newbot` and copy the bot token.
2. Message **@userinfobot** to get your numeric user ID.
3. Put both in `~/.hermes/.env` yourself (never paste them into a chat or command line):

```bash
mkdir -p ~/.hermes && touch ~/.hermes/.env && chmod 600 ~/.hermes/.env
nano ~/.hermes/.env
# TELEGRAM_BOT_TOKEN=<token from BotFather>
# TELEGRAM_ALLOWED_USERS=<your numeric id>
```

## 3. Configure and start

`scripts/hermes-setup.sh` needs the system `python3` (`/usr/bin/python3`, from the Command Line Tools: `xcode-select --install`). Re-run `install-services` after changing Node versions — the launch agent records an absolute `node` path, so the service dies when that path disappears.

```bash
scripts/switch-stack.sh token          # PharmaITChat API token (skip if it exists)
scripts/switch-stack.sh mcp-token      # token Hermes uses for pharmaitchat-mcp
scripts/hermes-setup.sh all            # install-config, install-services, install-plugin, install-cron
scripts/hermes-setup.sh check          # read-only status; prints variable names, never values
```

`install-config` copies the template and `SOUL.md` into `~/.hermes` (a changed file is backed up first) and fills `~/.hermes/.env`:

| Variable | Value |
|---|---|
| `PHARMALLM_URL` | `http://localhost:3000` |
| `PHARMALLM_MCP_URL` | `http://127.0.0.1:3200/mcp` |
| `SEARXNG_URL` | `http://localhost:8888` |
| `PHARMAITCHAT_API_TOKEN` | from `data/run/api-token` |
| `PHARMALLM_MCP_TOKEN` | from `data/run/mcp-token` |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS` | you add them (step 2) |
| `TELEGRAM_HOME_CHANNEL` | defaults to the first id in `TELEGRAM_ALLOWED_USERS`, so scheduled jobs reach your DM |

> [!NOTE]
> The product was renamed from PharmaLLM, but three of these keys keep the old name on purpose: `config.template.yaml` expands `${PHARMALLM_URL}`, `${PHARMALLM_MCP_URL}` and `${PHARMALLM_MCP_TOKEN}` through Hermes, which has no fallback of its own, so renaming them would break the config. (`PHARMALLM_URL` is read by the MCP service too, which accepts either name.) The API token is different: the app and the switch plugin read it directly, so `install-config` writes `PHARMAITCHAT_API_TOKEN` **and** keeps `PHARMALLM_API_TOKEN` in step with it — a rotation updates both, and an `.env` that only has the legacy key still works.

## Scheduled jobs

| Job | Schedule | What it does |
|---|---|---|
| `pharmaitchat-watchlist-ingest` | 02:30 daily | The nightly watchlist run (script mode, no agent). Silent unless it fails |
| `pharmaitchat-kb-canary` | 05:00 daily | Asks the KB canary questions (script mode). Silent unless one fails |
| `pharmaitchat-gap-resolution` | 07:00 daily | Re-checks at most 3 triggered knowledge gaps, oldest first; `[SILENT]` when there are none |
| `pharmaitchat-weekly-digest` | Monday 07:30 | Last week's digest for your role, ending with action items (script mode) |
| `pharmaitchat-daily-briefing` | Tuesday–Friday 07:30 | Yesterday's news about your accounts and what to do about it (script mode). Silent on a day with nothing actionable |
| `pharmaitchat-health-watch` | 09:00 and 19:00 | Reports failing checks; `[SILENT]` while healthy |
| `pharmaitchat-feedback-digest` | Monday 08:00 | Weekly rating trends and the worst-rated answers |

Edit `cron/jobs.json` and re-run `scripts/hermes-setup.sh install-cron` to change any of them.

## Operations

| Task | Command |
|---|---|
| Gateway (Telegram + cron) | `hermes gateway status\|restart\|stop` — logs in `~/.hermes/logs/gateway.log` |
| MCP service | `scripts/switch-stack.sh mcp status\|start\|stop` — logs in `data/logs/mcp.log` |
| Scheduled jobs | `hermes cron list`, `hermes cron run <id>` (runs on the next scheduler tick) |
| One-shot question | `hermes chat -q "…" --format stream-json` (shows each tool call) |
| Update jobs or config after editing this folder | `scripts/hermes-setup.sh install-config` or `install-cron` |
| Update the switch plugin after editing it | `scripts/hermes-setup.sh install-plugin` (restarts the gateway) |
| Switch the LLM stack | `scripts/switch-stack.sh omlx` (or `ollama`/`mlx`) — Hermes follows the active stack, so this also moves the agent, no Hermes change needed |

**After a reboot.** `com.pharmaitchat.mcp` and the Hermes gateway come back on their own; the PharmaITChat app and the model stack do not (they have no launch agent). Run `scripts/start-services.sh` (or `scripts/switch-stack.sh ollama`) before the first job fires — until then `/healthz` reports `pharmaitchat:false`, `scripts/hermes-setup.sh check` says `pharmaitchat-mcp: up, PharmaITChat not reachable`, and the scheduled jobs deliver failure messages.

### Docker sandbox

The `terminal` toolset runs in a Docker container. Pull the image once before the first use — the first pull otherwise runs inside the tool-call timeout and the sandbox fails to start:

```bash
docker pull nikolaik/python-nodejs:python3.11-nodejs20
```

The sandbox is sized for a small VM (`container_cpu: 1`, `container_memory: 512`). The Docker VM must keep headroom beyond Neo4j and SearXNG, which already take about 700 MB of colima's 1.91 GB on this Mac; raise those two values only after giving the VM more RAM.

If `docker pull` hangs with no output, the daemon is wedged: `colima restart` clears it. That also restarts Neo4j and SearXNG, so the graph and web search are briefly unavailable.

**Speed and GPU budget (measured).** Every Hermes agent step is a full cold prefill of about 160 s: Hermes' prompt prefix changes from request to request, so the prompt cache never hits. A Telegram answer with 3–4 tool calls therefore takes about 10–20 minutes, and the four LLM-agent scheduled jobs cost about 45–55 minutes of GPU per day. The watchlist ingest (02:30) is script mode — it never goes through a Hermes agent step, so this prefill math doesn't apply to it; its GPU cost is one local-model tagging call per new item, sequential, capped at 250 items a night. A web chat between two Hermes steps evicts the shared Ollama prompt cache, so nothing is saved even when a prefix would have matched.

**Stack switches and benchmarks.** Hermes always uses the active stack. During a switch or a benchmark, the app is unavailable or answers 503, and Hermes says so.

## Stack-switch buttons

The web UI confirms a stack switch with Telegram buttons instead of a link. The app and Hermes share one bot, and Hermes' gateway is that bot's only update consumer, so the `pharmaitchat-switch` plugin (`hermes/plugins/pharmaitchat-switch/`) is what receives the tap.

Install it with:

```bash
scripts/hermes-setup.sh install-plugin
```

This also restarts the gateway, because the plugin only wires its Telegram handler when the gateway connects. Once loaded, it writes `~/.hermes/pharmaitchat-switch.ready.json` with the gateway's pid and start time; the app compares that file against the gateway's own status before it will let you request a stack switch. `scripts/hermes-setup.sh check` reports the plugin as `missing`, `loaded by the running gateway`, or `installed, waiting for a gateway restart`.

The plugin reads `PHARMAITCHAT_API_TOKEN` and falls back to `PHARMALLM_API_TOKEN`, so a token rotation that only rewrites one of the two keys still leaves it working. Its tests run with `npm run test:hermes-plugin`.

## Moving Hermes to a second Mac

On the PharmaITChat Mac, let the MCP service listen on the network:

```bash
MCP_HOST=0.0.0.0 scripts/hermes-setup.sh install-services
```

This bakes `MCP_HOST` into the launch agent, so it survives a reboot — `launchctl setenv` would not, and `run-mcp.sh` would silently fall back to loopback. An MCP token is then required: `run-mcp.sh` refuses to listen on a non-loopback host without one (`scripts/switch-stack.sh mcp-token`).

On the Hermes Mac, clone this repo, install Hermes (step 1), then set the URLs and copy the two token values into `~/.hermes/.env` by hand before running `scripts/hermes-setup.sh install-config`, `scripts/hermes-setup.sh install-plugin`, `scripts/hermes-setup.sh install-cron` and `hermes gateway install --force --start-now --start-on-login`:

```
PHARMALLM_URL=http://<pharmaitchat-mac>:3000
PHARMALLM_MCP_URL=http://<pharmaitchat-mac>:3200/mcp
SEARXNG_URL=http://<pharmaitchat-mac>:8888
```

On the Hermes Mac, `scripts/hermes-setup.sh check` reports `service com.pharmaitchat.mcp: not loaded` by design: that service runs on the other Mac, so its absence here is expected and not a fault. To make the health line meaningful there, point the probe at the other Mac: `MCP_HEALTH_URL=http://<pharmaitchat-mac>:3200/healthz scripts/hermes-setup.sh check`.

A two-Mac setup cannot confirm UI-driven stack switches through Telegram — the plugin calls the app on localhost. Switch with `scripts/switch-stack.sh` on the model Mac instead.

## Troubleshooting

- `hermes doctor --live` probes the model and MCP server.
- `hermes mcp test pharmaitchat` checks the MCP connection and lists tools.
- "context length below minimum": the gateway model must run with 65536 (`scripts/switch-stack.sh ollama-ctx`).
- MCP calls fail after 5 minutes: `pharmaitchat-mcp` must be the version that sends keepalives (restart it: `scripts/switch-stack.sh mcp stop && scripts/switch-stack.sh mcp start`).
- `check` reports the gateway as not loaded: it probes the `gui` launchd domain while the gateway loads in `user`. Confirm with `hermes gateway status`.
