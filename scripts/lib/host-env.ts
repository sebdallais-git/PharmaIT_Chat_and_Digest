// Prints the host profile (config/host.yaml) as shell exports for scripts/lib/host.sh to eval.
// Each line keeps a non-empty value already in the environment (set-but-empty counts as unset):
//   [ -n "${NAME:-}" ] || NAME='value'; export NAME
// Every value is single-quoted with embedded ' escaped as '\'' , so no value (even a free-text
// host name) can break out of the quotes: the output is safe to eval.
import { HostConfigError, loadHostConfig } from "../../src/platform/host-config.js";
import type { HostConfig } from "../../src/platform/host-config.js";

function exportsFor(host: HostConfig): Array<[string, string | number]> {
  const e = host.endpoints;
  const r = host.resources;
  return [
    ["PHARMAITCHAT_HOST_NAME", host.name],
    ["PHARMAITCHAT_HOST_ADDRESS", host.address],
    ["APP_PORT", e.app.port],
    ["APP_HTTPS_PORT", e.app.httpsPort ?? ""],
    ["MCP_HOST", e.mcp.address],
    ["MCP_PORT", e.mcp.port],
    ["N8N_PORT", e.n8n.port],
    ["CHROMADB_PORT", e.chromadb.port],
    ["NEO4J_PORT", e.neo4j.port],
    ["SEARXNG_PORT", e.searxng.port],
    ["JEV_HOST", e.scorer.address],
    ["JEV_PORT", e.scorer.port],
    ["OLLAMA_PORT", e.ollama.port],
    ["MLX_CHAT_PORT", e.mlx_chat.port],
    ["MLX_EMBED_PORT", e.mlx_embed.port],
    ["OMLX_PORT", e.omlx.port],
    ["SPLASH_PORT", e.splash.port],
    ["MLX_CACHE_LIMIT", r.mlxChat.cacheLimitBytes],
    ["MLX_PROMPT_CACHE_BYTES", r.mlxChat.promptCacheBytes],
    ["MLX_PROMPT_CONCURRENCY", r.mlxChat.promptConcurrency],
    ["MLX_DECODE_CONCURRENCY", r.mlxChat.decodeConcurrency],
    ["MLX_EMBED_CACHE_LIMIT", r.mlxEmbed.cacheLimitBytes],
    ["JEV_MLX_CACHE_LIMIT", r.scorer.cacheLimitBytes],
    ["OMLX_CACHE_MAX_GB", r.omlx.ssdCacheMaxGb],
    ["OLLAMA_NUM_PARALLEL", r.ollama.numParallel],
    ["IMAGE_QUANTIZE", r.image.quantize],
  ];
}

try {
  const lines = exportsFor(loadHostConfig()).map(([name, value]) => {
    const quoted = String(value).replace(/'/g, "'\\''");
    return `[ -n "\${${name}:-}" ] || ${name}='${quoted}'; export ${name}`;
  });
  process.stdout.write(`${lines.join("\n")}\n`);
} catch (err) {
  process.stderr.write(`${err instanceof HostConfigError ? err.message : String(err)}\n`);
  process.exit(1);
}
