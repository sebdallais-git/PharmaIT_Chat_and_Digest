// Knowledge gap tools: low-confidence questions and their resolution

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PharmaITChatClient } from "../pharmaitchat-client.js";
import { compactGap } from "./compact.js";
import { runLongTool, runTool } from "./result.js";
import type { ToolLogger, ToolOptions } from "./result.js";

function gapsOf(payload: unknown): Array<Record<string, unknown>> {
  const gaps = typeof payload === "object" && payload !== null ? (payload as { gaps?: unknown }).gaps : undefined;
  return Array.isArray(gaps) ? gaps.filter((gap): gap is Record<string, unknown> => typeof gap === "object" && gap !== null) : [];
}

export function registerGapTools(server: McpServer, client: PharmaITChatClient, log: ToolLogger, options: ToolOptions = {}): void {
  server.registerTool(
    "list_knowledge_gaps",
    {
      description: "Recent questions PharmaITChat answered with low confidence, with overall gap statistics.",
      inputSchema: {
        status: z
          .enum(["triggered", "skipped", "resolved", "unresolved", "review", "detected"])
          .optional()
          .describe(
            "Only gaps with this status (new gaps are 'triggered'; 'review' is the scorer's middle band, parked for a human)"
          ),
        limit: z.number().int().min(1).max(50).optional().describe("How many gaps to return, newest first (default 20)"),
      },
    },
    async ({ status, limit }) =>
      runTool("list_knowledge_gaps", log, async () => {
        const gaps = gapsOf(await client.get("/api/knowledge/gaps"));
        return {
          gaps: (status ? gaps.filter((gap) => gap.status === status) : gaps).slice(0, limit ?? 20).map(compactGap),
          stats: await client.get("/api/knowledge/gaps/stats"),
        };
      })
  );

  server.registerTool(
    "resolve_knowledge_gap",
    {
      description:
        "Re-ask a knowledge gap's question through PharmaITChat's RAG pipeline and let the local scorer judge the new " +
        "answer: the gap is marked resolved, unresolved (retried later), or review (parked for a human). Use after " +
        "adding knowledge for that topic. Takes about 1-2 minutes.",
      inputSchema: {
        gap_id: z.number().int().positive(),
        original_query: z.string().min(1),
        search_topic: z.string().min(1).optional(),
      },
    },
    async ({ gap_id, original_query, search_topic }, extra) =>
      runLongTool("resolve_knowledge_gap", log, extra, options, () =>
        client.post(
          "/api/knowledge/gaps/check-resolution",
          search_topic ? { gap_id, original_query, search_topic } : { gap_id, original_query },
          5 * 60 * 1000
        )
      )
  );
}
