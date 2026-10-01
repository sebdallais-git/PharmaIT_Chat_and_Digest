// Knowledge graph tools (the vendor-intelligence graph in Neo4j, via PharmaITChat)

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PharmaITChatClient } from "../pharmaitchat-client.js";
import { runTool } from "./result.js";
import type { ToolLogger } from "./result.js";

export function registerGraphTools(server: McpServer, client: PharmaITChatClient, log: ToolLogger): void {
  // One composite tool rather than graph primitives: the local model fails at
  // orchestrating several calls (spec 2026-09-21, "Query path").
  server.registerTool(
    "competitive_position",
    {
      description:
        "How a vendor stands at the user's accounts, segment by segment, e.g. 'What is Dell doing best for my accounts?'. " +
        "For each account it resolves who is already installed in each segment first, then labels the vendor's mode there: " +
        "defend (the vendor is installed), displace (a rival is), greenfield (declared: nobody is) or unknown " +
        "(who is installed is not recorded -- never read it as greenfield). Also returns the vendor's " +
        "position per segment with its rationale, confidence, short strong/weak claims from curated briefs, sources and " +
        "recent news. Positions are labels, not a ranking: never present vendors as ranked. " +
        "Give at least one of vendor, account or segment.",
      inputSchema: {
        vendor: z.string().min(1).optional().describe("Vendor, e.g. 'dell', 'HPE' or 'Pure Storage'"),
        account: z.string().min(1).optional().describe("Account, e.g. 'Roche' or 'Genentech'; omit for all accounts"),
        segment: z
          .string()
          .min(1)
          .optional()
          .describe("One segment, e.g. 'storage-block', 'storage-file', 'compute-ai', 'data-protection'"),
      },
    },
    async ({ vendor, account, segment }) =>
      runTool("competitive_position", log, () =>
        client.post("/api/graph/competitive-position", { vendor, account, segment }),
      ),
  );

  server.registerTool(
    "graph_stats",
    { description: "Knowledge graph size: node counts by label and relationship counts by type." },
    async () => runTool("graph_stats", log, () => client.get("/api/graph/stats"))
  );
}
