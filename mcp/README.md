# pharmallm-mcp

MCP service that exposes PharmaLLM to AI agents (Hermes Agent, Claude Desktop, any MCP client) over Streamable HTTP. It holds no RAG logic: every tool calls PharmaLLM's REST API.

## Run

```bash
npm --prefix mcp install
npm --prefix mcp start          # http://127.0.0.1:3200/mcp
```

| Variable | Default | Purpose |
|----------|---------|---------|
| `MCP_PORT` | `3200` | Listen port |
| `MCP_HOST` | `127.0.0.1` | Bind address; use a LAN or Tailscale IP to serve another machine |
| `MCP_TOKEN` | *(none)* | Bearer token agents must send; required when `MCP_HOST` is not loopback |
| `PHARMALLM_URL` | `http://localhost:3000` | PharmaLLM base URL |
| `PHARMALLM_API_TOKEN` | *(none)* | PharmaLLM API token (see `scripts/switch-stack.sh token`) |

Without `MCP_TOKEN` the service only accepts requests from the same machine with a `localhost`, `127.0.0.1` or `[::1]` Host header (other Host names get `403`, which blocks DNS rebinding). With `MCP_TOKEN` set, the token is required instead and any Host is accepted.

## Tools

| Tool | Purpose |
|------|---------|
| `search_knowledge` | Top chunks and sources for a query (fast) |
| `ask_pharmallm` | Full RAG answer with sources (~1-2 min) |
| `add_knowledge` | Add text (with source) or a URL |
| `knowledge_status` | Knowledge base and ChromaDB status |
| `competitive_position`, `graph_stats` | A vendor's standing per account segment (incumbency first: defend / displace / greenfield), and graph size |
| `list_knowledge_gaps`, `resolve_knowledge_gap` | Low-confidence questions and re-checks |
| `system_health`, `dashboard_metrics` | Stack, services, usage metrics |
| `run_news_agent`, `news_agent_status` | Trigger or inspect the news scrub |
| `start_reindex`, `reindex_status` | Background index rebuild |
| `record_feedback`, `feedback_report` | Rate answers, feedback reports |

## Hermes Agent

`~/.hermes/config.yaml`:

```yaml
mcp_servers:
  pharmallm:
    url: "http://localhost:3200/mcp"
    headers:
      Authorization: "Bearer ${PHARMALLM_MCP_TOKEN}"
    timeout: 900
```

The long timeout covers `run_news_agent`, which gives up after 14 minutes so its error reaches Hermes before the 900 s tool timeout. When Hermes runs on another Mac, start this service with `MCP_HOST` set to the model Mac's LAN or Tailscale address and `MCP_TOKEN`, and use that address in `url`.

## Tests

```bash
npm --prefix mcp test
npm --prefix mcp run typecheck
```
