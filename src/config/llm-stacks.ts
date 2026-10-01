// Stack definitions for the Ollama / MLX switch. Exactly one stack is active per process.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serviceUrl } from "../platform/host-config.js";
import type { HostConfig } from "../platform/host-config.js";

export type StackName = "ollama" | "mlx" | "omlx" | "splash";

// Single source of truth for the set of stack names: everything that needs to enumerate or
// validate stacks (the router, the state machine, progress parsing) imports this rather than
// keeping its own copy, so a fourth stack needs one edit instead of several.
export const STACK_NAMES: readonly StackName[] = ["ollama", "mlx", "omlx", "splash"];

export function isStackName(value: unknown): value is StackName {
  return typeof value === "string" && (STACK_NAMES as readonly string[]).includes(value);
}

export interface StackConfig {
  name: StackName;
  chatBaseUrl: string;
  embedBaseUrl: string;
  chatModel: string;
  embeddingModel: string;
  embeddingDim: number;
  chromaCollection: string;
  indexFile: string;
  // The identity stamped into (and expected from) the index this stack reads and writes. Usually
  // the stack's own name and embedding model, but stacks that share an index must agree on both or
  // the index guard would invalidate it — and a rebuild deletes the live ChromaDB collection.
  indexStack: string;
  indexEmbeddingModel: string;
}

const EMBEDDING_DIM = 1024;

export function buildStacks(env: NodeJS.ProcessEnv = process.env, host?: HostConfig): Record<StackName, StackConfig> {
  // Endpoints from config/host.yaml; OLLAMA_URL, MLX_CHAT_URL, MLX_EMBED_URL, OMLX_URL and SPLASH_URL still win
  const ollamaUrl = serviceUrl("ollama", env, host);
  const mlxChatUrl = serviceUrl("mlx_chat", env, host);
  const mlxEmbedUrl = serviceUrl("mlx_embed", env, host);
  const omlxUrl = serviceUrl("omlx", env, host);
  const splashUrl = serviceUrl("splash", env, host);

  return {
    ollama: {
      name: "ollama",
      chatBaseUrl: ollamaUrl,
      embedBaseUrl: ollamaUrl,
      chatModel: "qwen3.8-pharma",
      embeddingModel: "qwen3-embedding:0.6b-q8_0",
      embeddingDim: EMBEDDING_DIM,
      chromaCollection: "knowledge_base_ollama",
      indexFile: ".index.ollama.json",
      indexStack: "ollama",
      indexEmbeddingModel: "qwen3-embedding:0.6b-q8_0",
    },
    mlx: {
      name: "mlx",
      chatBaseUrl: mlxChatUrl,
      embedBaseUrl: mlxEmbedUrl,
      chatModel: "mlx-community/Qwen3.8-27B-4bit",
      embeddingModel: "mlx-community/Qwen3-Embedding-0.6B-8bit",
      embeddingDim: EMBEDDING_DIM,
      chromaCollection: "knowledge_base_mlx",
      indexFile: ".index.mlx.json",
      indexStack: "mlx",
      indexEmbeddingModel: "mlx-community/Qwen3-Embedding-0.6B-8bit",
    },
    // oMLX serves chat and embeddings from one process; its embeddings are identical to the MLX
    // server's (cosine 1.000000, see the verification doc), so it shares the MLX index
    omlx: {
      name: "omlx",
      chatBaseUrl: omlxUrl,
      embedBaseUrl: omlxUrl,
      chatModel: "mlx-community--Qwen3.8-27B-4bit",
      embeddingModel: "mlx-community--Qwen3-Embedding-0.6B-8bit",
      embeddingDim: EMBEDDING_DIM,
      chromaCollection: "knowledge_base_mlx",
      indexFile: ".index.mlx.json",
      // Deliberately the MLX stack's identity, not omlx's: oMLX serves the very same embedding
      // model under a different discovery id (double dashes instead of a slash) and produces
      // interchangeable vectors (cosine 1.000000, verified). Stamping "omlx" here would make the
      // index guard reject the shared index on every mlx<->omlx switch, and the rebuild branch
      // deletes the collection and re-embeds the whole knowledge base.
      indexStack: "mlx",
      indexEmbeddingModel: "mlx-community/Qwen3-Embedding-0.6B-8bit",
    },
    // Splash is chat-only -- it exposes no /v1/embeddings at all -- so it
    // borrows the MLX embedding server and shares the MLX index, the same
    // arrangement omlx uses. See the indexStack comment on omlx above: the
    // identity stamped here is deliberately "mlx", because a mismatch sends
    // the next switch down the rebuild branch, which DELETES the collection.
    splash: {
      name: "splash",
      chatBaseUrl: splashUrl,
      embedBaseUrl: mlxEmbedUrl,
      chatModel: "incoai/Qwen3.8-27B-Splash",
      embeddingModel: "mlx-community/Qwen3-Embedding-0.6B-8bit",
      embeddingDim: EMBEDDING_DIM,
      chromaCollection: "knowledge_base_mlx",
      indexFile: ".index.mlx.json",
      indexStack: "mlx",
      indexEmbeddingModel: "mlx-community/Qwen3-Embedding-0.6B-8bit",
    },
  };
}

/**
 * The stack actually running, as written by switch-stack.sh. Returns null when
 * the file is missing or unreadable.
 */
export function readRunningStack(): string | null {
  try {
    const raw = readFileSync(join(process.cwd(), "data", "run", "active-stack"), "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function getActiveStack(
  env: NodeJS.ProcessEnv = process.env,
  runningStack: () => string | null = readRunningStack,
): StackConfig {
  // An explicit LLM_PROVIDER wins -- switch-stack.sh sets it deliberately when
  // acting on a stack that is not the running one. Otherwise use the stack that
  // is actually running. Never fall back to a hardcoded default: this used to
  // resolve to "ollama", so any script run from a bare shell silently operated
  // on the wrong collection, and reindex.ts DELETEs the collection it rebuilds.
  const name = env.LLM_PROVIDER ?? runningStack();
  if (name === null || name === undefined) {
    throw new Error(
      "No LLM_PROVIDER set and data/run/active-stack is unreadable -- refusing to guess which stack to use",
    );
  }
  if (!isStackName(name)) {
    throw new Error(`Unknown stack "${name}" (expected one of: ${STACK_NAMES.join(", ")})`);
  }
  return buildStacks(env)[name];
}
