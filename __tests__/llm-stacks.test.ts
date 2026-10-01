import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHostConfig } from "../src/platform/host-config.js";
import { thinkingBody } from "../src/services/thinking.js";
import { buildStacks, getActiveStack, isStackName, STACK_NAMES } from "../src/config/llm-stacks.js";

describe("getActiveStack", () => {
  it("falls back to the running stack when LLM_PROVIDER is unset", () => {
    // A bare shell has no LLM_PROVIDER. Defaulting to ollama pointed such a
    // process at the wrong collection -- and reindex.ts DELETEs the collection
    // it is about to rebuild.
    expect(getActiveStack({}, () => "mlx").name).toBe("mlx");
  });

  it("prefers an explicit LLM_PROVIDER over the running stack", () => {
    expect(getActiveStack({ LLM_PROVIDER: "ollama" }, () => "mlx").name).toBe("ollama");
  });

  it("refuses to guess when neither the env nor the running stack says", () => {
    expect(() => getActiveStack({}, () => null)).toThrow(/refusing to guess/);
  });

  it("rejects a corrupt running-stack file rather than falling back", () => {
    expect(() => getActiveStack({}, () => "lmstudio")).toThrow(/lmstudio/);
  });

  it("selects the mlx stack", () => {
    const stack = getActiveStack({ LLM_PROVIDER: "mlx" });
    expect(stack.name).toBe("mlx");
    expect(stack.chatModel).toBe("mlx-community/Qwen3.8-27B-4bit");
    expect(stack.embeddingModel).toBe("mlx-community/Qwen3-Embedding-0.6B-8bit");
  });

  it("throws on an unknown provider", () => {
    expect(() => getActiveStack({ LLM_PROVIDER: "lmstudio" })).toThrow(/Unknown stack.*lmstudio/);
  });
});

describe("buildStacks", () => {
  it("honours URL overrides", () => {
    const stacks = buildStacks({ OLLAMA_URL: "http://o:1", MLX_CHAT_URL: "http://m:2", MLX_EMBED_URL: "http://e:3" });
    expect(stacks.ollama.chatBaseUrl).toBe("http://o:1");
    expect(stacks.ollama.embedBaseUrl).toBe("http://o:1");
    expect(stacks.mlx.chatBaseUrl).toBe("http://m:2");
    expect(stacks.mlx.embedBaseUrl).toBe("http://e:3");
  });

  it("uses the same model family on both stacks and separate indexes", () => {
    const { ollama, mlx } = buildStacks({});
    expect(ollama.chatModel).toBe("qwen3.8-pharma");
    expect(ollama.embeddingModel).toBe("qwen3-embedding:0.6b-q8_0");
    expect(ollama.embeddingDim).toBe(1024);
    expect(mlx.embeddingDim).toBe(1024);
    expect(ollama.chromaCollection).toBe("knowledge_base_ollama");
    expect(mlx.chromaCollection).toBe("knowledge_base_mlx");
    expect(ollama.indexFile).toBe(".index.ollama.json");
    expect(mlx.indexFile).toBe(".index.mlx.json");
  });

  it("keeps each stack's own index identity where nothing is shared", () => {
    const { ollama, mlx } = buildStacks({});
    expect(ollama.indexStack).toBe("ollama");
    expect(ollama.indexEmbeddingModel).toBe(ollama.embeddingModel);
    expect(mlx.indexStack).toBe("mlx");
    expect(mlx.indexEmbeddingModel).toBe(mlx.embeddingModel);
  });

  it("disables thinking on both stacks", () => {
    const { ollama, mlx } = buildStacks({});
    expect(thinkingBody(ollama, "off")).toEqual({ reasoning_effort: "none" });
    expect(thinkingBody(mlx, "off")).toEqual({ chat_template_kwargs: { enable_thinking: false } });
  });
});

describe("omlx stack", () => {
  it("serves chat and embeddings from one server and shares the MLX index", () => {
    const { mlx, omlx } = buildStacks({});

    expect(omlx.name).toBe("omlx");
    expect(omlx.chatBaseUrl).toBe("http://localhost:8090");
    expect(omlx.embedBaseUrl).toBe(omlx.chatBaseUrl);
    expect(omlx.chatModel).toBe("mlx-community--Qwen3.8-27B-4bit");
    expect(omlx.embeddingModel).toBe("mlx-community--Qwen3-Embedding-0.6B-8bit");
    expect(omlx.embeddingDim).toBe(mlx.embeddingDim);
    expect(omlx.chromaCollection).toBe(mlx.chromaCollection);
    expect(omlx.indexFile).toBe(mlx.indexFile);
  });

  // F1: sharing the collection and the index file is not enough — the stack metadata stamped into
  // them has to match too, or the index guard invalidates the shared index on every mlx↔omlx switch.
  it("reads and writes the index under the MLX stack's identity, not its own", () => {
    const { mlx, omlx } = buildStacks({});
    expect(omlx.indexStack).toBe(mlx.indexStack);
    expect(omlx.indexEmbeddingModel).toBe(mlx.indexEmbeddingModel);
    expect(omlx.indexStack).toBe("mlx");
    expect(omlx.indexEmbeddingModel).toBe("mlx-community/Qwen3-Embedding-0.6B-8bit");
  });

  it("takes its URL from the environment", () => {
    expect(buildStacks({ OMLX_URL: "http://127.0.0.1:9100" }).omlx.chatBaseUrl).toBe("http://127.0.0.1:9100");
  });

  it("is selectable through LLM_PROVIDER", () => {
    expect(getActiveStack({ LLM_PROVIDER: "omlx" }).name).toBe("omlx");
  });

  it("rejects an unknown stack name and names all known stacks", () => {
    expect(() => getActiveStack({ LLM_PROVIDER: "vllm" })).toThrow(/ollama.*mlx.*omlx.*splash/);
  });
});

describe("STACK_NAMES", () => {
  it("matches the keys of the stack map, so the list cannot drift from it", () => {
    expect([...STACK_NAMES].sort()).toEqual(Object.keys(buildStacks({})).sort());
  });
});

describe("isStackName", () => {
  it("accepts each known stack name", () => {
    for (const name of STACK_NAMES) expect(isStackName(name)).toBe(true);
  });

  it("rejects a non-string", () => {
    expect(isStackName(42)).toBe(false);
    expect(isStackName(undefined)).toBe(false);
    expect(isStackName(null)).toBe(false);
  });

  it("rejects an array", () => {
    expect(isStackName(["omlx"])).toBe(false);
  });

  it("rejects an unknown name", () => {
    expect(isStackName("vllm")).toBe(false);
  });
});

describe("the splash stack", () => {
  it("is a known stack name", () => {
    expect(STACK_NAMES).toEqual(["ollama", "mlx", "omlx", "splash"]);
    expect(isStackName("splash")).toBe(true);
  });

  it("serves chat from Splash and embeddings from the MLX server", () => {
    const { splash } = buildStacks({});

    expect(splash.chatBaseUrl).toBe("http://localhost:8000");
    expect(splash.embedBaseUrl).toBe("http://localhost:8081");
    expect(splash.chatModel).toBe("incoai/Qwen3.8-27B-Splash");
    expect(splash.embeddingModel).toBe("mlx-community/Qwen3-Embedding-0.6B-8bit");
  });

  // THE DESTRUCTIVE MISTAKE THIS TEST EXISTS TO PREVENT:
  // splash shares .index.mlx.json and knowledge_base_mlx with mlx and omlx.
  // The index guard compares the stamped identity against the running stack's;
  // a mismatch takes the rebuild branch, and reindex DELETES the ChromaDB
  // collection before re-embedding. Stamping "splash" here would destroy the
  // knowledge base on the first switch back to mlx.
  it("stamps the MLX index identity, not its own", () => {
    const { splash, mlx } = buildStacks({});

    expect(splash.indexStack).toBe("mlx");
    expect(splash.indexEmbeddingModel).toBe(mlx.indexEmbeddingModel);
    expect(splash.chromaCollection).toBe(mlx.chromaCollection);
    expect(splash.indexFile).toBe(mlx.indexFile);
  });

  // The spec requires the /v1 gateway, n8n and the nightly ingest to follow the
  // active stack with no code change. They all resolve it through
  // getActiveStack(), so this is inherited -- pinned rather than assumed.
  it("is a complete StackConfig, so every getActiveStack consumer works unchanged", () => {
    const { splash, mlx } = buildStacks({});

    expect(Object.keys(splash).sort()).toEqual(Object.keys(mlx).sort());
    expect(Object.values(splash).every((v) => v !== undefined && v !== "")).toBe(true);
  });

  // THE CRITICAL FINDING this test exists to pin: splash's thinking body was copied from mlx/omlx's
  // chat_template_kwargs convention, but Splash's own server, its warm-up in switch-stack.sh, the
  // spec and the README all disable thinking via reasoning_effort. With the wrong field, warm_up
  // warms up successfully with one body while every real chat request through llm-client.ts /
  // model-gateway.ts sends a different, undocumented one -- and nothing else in the codebase
  // compares the two halves (this file and scripts/switch-stack.sh), so the mismatch is invisible
  // to every test that only looks at one side.
  it("disables thinking via reasoning_effort, matching the warm-up, not mlx's chat_template_kwargs", () => {
    const { splash } = buildStacks({});

    expect(thinkingBody(splash, "off")).toEqual({ reasoning_effort: "none" });
    expect(thinkingBody(splash, "off")).not.toHaveProperty("chat_template_kwargs");
  });

  it("honours SPLASH_URL and MLX_EMBED_URL overrides", () => {
    const { splash } = buildStacks({ SPLASH_URL: "http://127.0.0.1:9000", MLX_EMBED_URL: "http://127.0.0.1:9001" });

    expect(splash.chatBaseUrl).toBe("http://127.0.0.1:9000");
    expect(splash.embedBaseUrl).toBe("http://127.0.0.1:9001");
  });

  // getActiveStack narrows the name with a hand-written list that is NOT
  // generated from STACK_NAMES. It is a second source of truth in the same
  // file and silently rejects any stack missing from it.
  it("resolves splash through getActiveStack", async () => {
    const { getActiveStack } = await import("../src/config/llm-stacks.js");

    expect(getActiveStack({ LLM_PROVIDER: "splash" }).name).toBe("splash");
  });
});

describe("buildStacks reads endpoints from the host profile", () => {
  const fixture = readFileSync(join(process.cwd(), "__tests__", "fixtures", "host.yaml"), "utf-8");

  it("uses the profile's ports when no env override is set", () => {
    const host = parseHostConfig(fixture.replace("mlx_chat:  { port: 8080 }", "mlx_chat:  { port: 9080 }"), "t.yaml");
    const stacks = buildStacks({}, host);
    expect(stacks.mlx.chatBaseUrl).toBe("http://localhost:9080");
    expect(stacks.splash.embedBaseUrl).toBe("http://localhost:8081");
  });

  it("still lets MLX_CHAT_URL win", () => {
    const host = parseHostConfig(fixture, "t.yaml");
    expect(buildStacks({ MLX_CHAT_URL: "http://elsewhere:1" }, host).mlx.chatBaseUrl).toBe("http://elsewhere:1");
  });
});
