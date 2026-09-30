// The digest agent for Hermes: a purpose-built digest for the period and focus
// the user asked for, framed by their active role and ending with sales action
// items. Takes a minute or two on the local model.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PharmaITChatClient } from "../pharmaitchat-client.js";
import { runLongTool, type ToolLogger, type ToolOptions } from "./result.js";

// Four bounded 27B calls; generous for a busy stack
const DIGEST_TIMEOUT_MS = 10 * 60_000;

function markdownOf(value: unknown): string {
  const markdown = (value as { markdown?: unknown } | null)?.markdown;
  return typeof markdown === "string" ? markdown : JSON.stringify(value);
}

export function registerDigestTools(server: McpServer, client: PharmaITChatClient, log: ToolLogger, options: ToolOptions = {}): void {
  server.registerTool(
    "make_digest",
    {
      description:
        "Build a news digest from PharmaITChat's watchlist for the user's active role: their accounts, the infrastructure " +
        "scene, pharma industry, cyber, AI and R&D/manufacturing IT, ending with sales action items per line they sell. " +
        "Use it whenever the user asks for a digest, recap, round-up or 'what happened' over a period. Pass their request " +
        "verbatim (it sets the period and focus, e.g. 'last week', 'storage at Novartis this month'). Send the result " +
        "back unchanged; it already fits one Telegram message. Takes 1-2 minutes.",
      inputSchema: {
        request: z.string().min(1).describe("The user's request, verbatim"),
      },
    },
    async ({ request }, extra) =>
      runLongTool("make_digest", log, extra, options, async () =>
        markdownOf(await client.post("/api/digest", { request }, DIGEST_TIMEOUT_MS)),
      ),
  );
}
