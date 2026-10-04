// Artifact export tools: request a document from PharmaITChat's data and
// poll the job it returns. Both routes on PharmaITChat's side return
// promptly (POST /api/export is fire-and-forget, GET /api/export/:id is a
// plain status read -- see src/api/export.ts), so neither tool needs the
// keepalive machinery runLongTool exists for; this follows graph.ts's
// shape (runTool only, no ToolOptions), not knowledge.ts's.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PharmaITChatClient } from "../pharmaitchat-client.js";
import { runTool } from "./result.js";
import type { ToolLogger } from "./result.js";

export function registerExportTools(server: McpServer, client: PharmaITChatClient, log: ToolLogger): void {
  server.registerTool(
    "create_artifact",
    {
      // The destination is a free choice for the model, and one of the three
      // options is an egress: an INTERNAL artifact is account intelligence,
      // and 'icloud' syncs it off this machine. A model cannot weigh that if
      // the description does not say it, so it says it here, in the text the
      // model actually reads, rather than only in a comment.
      description:
        "Produce a document from PharmaITChat's data: an account brief, incumbency matrix or vendor " +
        "comparison, as xlsx, pdf or pptx. `audience` is required -- 'internal' includes incumbency and " +
        "competitive position, 'external' omits them for something a customer may see. " +
        "`destination` defaults to 'download', which keeps the file on this machine behind an " +
        "authenticated URL; 'telegram' sends it to the configured chat. Choose 'icloud' ONLY when the " +
        "user asked for it: it writes into an iCloud-synced folder, so the file leaves this machine and " +
        "reaches their other devices -- which for an 'internal' artifact means account intelligence " +
        "leaves this machine. When in doubt use 'download', which stays on this machine. " +
        "Returns a job id; a deck takes several minutes. Poll with artifact_status.",
      inputSchema: {
        kind: z.enum(["account-brief", "incumbency-matrix", "vendor-comparison"]),
        format: z.enum(["xlsx", "pdf", "pptx"]),
        audience: z.enum(["internal", "external"]),
        destination: z.enum(["download", "telegram", "icloud"]).optional(),
        account: z.string().optional(),
        vendor: z.string().optional(),
      },
    },
    async (args) => runTool("create_artifact", log, () => client.post("/api/export", args))
  );

  server.registerTool(
    "artifact_status",
    {
      description: "Check an export job: its stage, and where the finished file went.",
      inputSchema: { job_id: z.string().min(1) },
    },
    // job_id becomes part of the request path; encodeURIComponent keeps a
    // value containing "/" or ".." from altering which route is actually
    // requested -- the same class of path-containment bug already fixed
    // twice on this branch, on export's write side (export-delivery.ts's
    // resolveDestinationPath) and read side (export.ts's resolveDownloadPath).
    async ({ job_id }) => runTool("artifact_status", log, () => client.get(`/api/export/${encodeURIComponent(job_id)}`))
  );

  server.registerTool(
    "create_image",
    {
      // The model reads this to decide when to draw and how to describe the
      // request; text in images is unreliable, so it is told not to ask for it.
      description:
        "Generate an image from a text description, locally (FLUX.1-schnell on this machine). Use it for visuals: " +
        "slide hero images, backgrounds, LinkedIn post images. Images contain no text, words, numbers or logos: put " +
        "those in the message or document instead. `preset` is a style (none, house, photo, abstract, brand); " +
        "`size` is square (LinkedIn post), portrait (LinkedIn 4:5), linkedin (landscape link image) or slide (16:9). " +
        "`destination` defaults to 'download'; use 'telegram' to send the image to the user's chat. " +
        "Returns a job id; an image takes about a minute, longer while the language model is busy. Poll with artifact_status; " +
        "its `image.seed` lets the user ask for the same image again with changes.",
      inputSchema: {
        prompt: z.string().min(1).max(1000),
        preset: z.string().optional(),
        size: z.enum(["square", "portrait", "linkedin", "slide"]).optional(),
        raw: z.boolean().optional(),
        seed: z.number().int().min(0).optional(),
        destination: z.enum(["download", "telegram", "icloud"]).optional(),
      },
    },
    async (args) => runTool("create_image", log, () => client.post("/api/export", { kind: "image", format: "png", ...args }))
  );
}
