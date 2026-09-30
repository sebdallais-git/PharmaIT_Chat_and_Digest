// Builds the MCP server with every PharmaITChat tool registered

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PharmaITChatClient } from "./pharmaitchat-client.js";
import { registerExportTools } from "./tools/export.js";
import { registerFeedbackTools } from "./tools/feedback.js";
import { registerGapTools } from "./tools/gaps.js";
import { registerGraphTools } from "./tools/graph.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import { registerOperationsTools } from "./tools/operations.js";
import { registerRoleTools } from "./tools/role.js";
import type { ToolLogger, ToolOptions } from "./tools/result.js";

export const SERVER_INFO = { name: "pharmaitchat", version: "1.0.0" };

export function buildMcpServer(client: PharmaITChatClient, log: ToolLogger, options: ToolOptions = {}): McpServer {
  // The logging capability lets long tools send keepalive notifications
  const server = new McpServer(SERVER_INFO, { capabilities: { logging: {} } });
  registerKnowledgeTools(server, client, log, options);
  registerGraphTools(server, client, log);
  registerGapTools(server, client, log, options);
  registerOperationsTools(server, client, log, options);
  registerFeedbackTools(server, client, log);
  registerExportTools(server, client, log);
  registerRoleTools(server, client, log);
  return server;
}
