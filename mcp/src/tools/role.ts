// The user's role (who they are, their accounts, what they sell) is set by
// chatting. This tool lets Hermes hand those messages to PharmaITChat's role
// conversation, which asks follow-up questions itself.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PharmaITChatClient } from "../pharmaitchat-client.js";
import { runTool, type ToolLogger } from "./result.js";

// One 27B extraction call at most
const ROLE_TIMEOUT_MS = 120_000;

function replyText(value: unknown): string {
  const reply = (value as { reply?: unknown } | null)?.reply;
  return typeof reply === "string" ? reply : JSON.stringify(value);
}

export function registerRoleTools(server: McpServer, client: PharmaITChatClient, log: ToolLogger): void {
  server.registerTool(
    "my_role",
    {
      description:
        "The user's own job role in PharmaITChat: who they are, the accounts they cover and the lines they sell " +
        "(storage, servers, networking, backup, end-user computing, security). Every answer and digest is framed by it. " +
        "Call it whenever the user says who they are, asks to switch role, changes their accounts, portfolio or focus, " +
        "asks what their role is, or answers a question this tool asked. Pass their message verbatim and send the " +
        "reply back to them unchanged: it may be a follow-up question.",
      inputSchema: {
        message: z.string().min(1).describe("The user's message, verbatim"),
      },
    },
    async ({ message }) =>
      runTool("my_role", log, async () => replyText(await client.post("/api/role/message", { message }, ROLE_TIMEOUT_MS)))
  );
}
