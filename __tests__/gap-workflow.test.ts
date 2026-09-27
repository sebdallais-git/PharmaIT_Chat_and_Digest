import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface WorkflowNode {
  name: string;
  parameters?: { jsCode?: string; url?: string };
  onError?: string;
}

const workflow = JSON.parse(
  readFileSync(join(process.cwd(), "n8n", "knowledge_gap_workflow_v2.json"), "utf8"),
) as { nodes: WorkflowNode[]; connections: Record<string, { main?: unknown[] }> };

function node(name: string): WorkflowNode {
  const found = workflow.nodes.find((n) => n.name === name);
  if (found === undefined) throw new Error(`no node named ${name}`);
  return found;
}

// The log node's code, run the way n8n runs it. Substring assertions on the
// source cannot see the defect this suite exists to catch -- they pass if the
// word merely appears in a comment -- so the code is executed against the
// inputs the node actually receives.
interface LogOutput {
  status: string;
  verdict: string | null;
  probability: number | null;
  resolved: boolean | null;
  error: string | null;
  gap_id: number;
}

type LogNodeFn = (
  input: { first(): { json: Record<string, unknown> } },
  ref: (name: string) => { first(): { json: Record<string, unknown> } },
  console: { log(message: string): void },
) => Array<{ json: LogOutput }>;

const summaryJson: Record<string, unknown> = {
  gap_id: 7,
  search_topic: "ransomware in pharma",
  original_query: "Who attacked Merck?",
  stats: { stored: 3 },
};

function runLogNode(resolution: Record<string, unknown>): LogOutput {
  const code = node("Resolution Result Log").parameters?.jsCode ?? "";
  const run = new Function("$input", "$", "console", code) as unknown as LogNodeFn;
  const items = run(
    { first: () => ({ json: resolution }) },
    (name: string) => {
      if (name !== "Summary & Log") throw new Error(`unexpected node reference ${name}`);
      return { first: () => ({ json: summaryJson }) };
    },
    { log: () => {} },
  );
  return items[0].json;
}

describe("knowledge gap workflow", () => {
  it("still posts the resolution check at the app, not the scorer", () => {
    expect(node("Check Gap Resolution").parameters?.url).toBe(
      "http://localhost:3000/api/knowledge/gaps/check-resolution",
    );
  });

  // Both outputs of Check Gap Resolution -- success and error -- are wired to
  // the log node, so the log node is the only thing standing between a failed
  // call and a fabricated verdict.
  it("routes the error output of the resolution check into the log node", () => {
    expect(node("Check Gap Resolution").onError).toBe("continueErrorOutput");
    expect(workflow.connections["Check Gap Resolution"].main).toHaveLength(2);
  });

  // The log node used to branch on a boolean. A three-way verdict read as a
  // boolean silently collapses "review" into "still open", which would spend
  // the retry the review band exists to save.
  it("maps each verdict onto its own status", () => {
    expect(runLogNode({ verdict: "resolved", probability: 0.93 })).toMatchObject({
      status: "gap_resolved",
      verdict: "resolved",
      probability: 0.93,
      resolved: true,
      error: null,
    });
    expect(runLogNode({ verdict: "review", probability: 0.61 })).toMatchObject({
      status: "gap_review",
      verdict: "review",
      probability: 0.61,
      resolved: false,
    });
    expect(runLogNode({ verdict: "unresolved", probability: 0.12 })).toMatchObject({
      status: "gap_still_open",
      verdict: "unresolved",
      probability: 0.12,
      resolved: false,
    });
  });

  // THE defect this branch exists to delete, one layer up: a failed call is not
  // a verdict. Logging it as "unresolved" asserts a judgment nobody made.
  it.each([
    ["a transport error", { error: "connect ECONNREFUSED 127.0.0.1:8000" }],
    ["an error object", { error: { message: "The service refused the connection" } }],
    ["a 503 body", { error: { message: "Request failed with status code 503" }, statusCode: 503 }],
    ["an empty item", {}],
    ["a body with no verdict", { new_response: "some text" }],
    ["an unknown verdict", { verdict: "confident", probability: 0.4 }],
    ["a prototype key as a verdict", { verdict: "constructor" }],
  ])("reports %s as a failed decision, not as a verdict", (_label: string, resolution: Record<string, unknown>) => {
    const result = runLogNode(resolution);

    expect(result.status).toBe("gap_decision_failed");
    expect(result.status).not.toBe("gap_still_open");
    expect(result.verdict).toBeNull();
    expect(result.resolved).not.toBe(true);
    expect(result.resolved).not.toBe(false); // not a judgment either way
    expect(result.probability).toBeNull();
    expect(typeof result.error).toBe("string");
  });

  it("carries the error detail it was given", () => {
    expect(runLogNode({ error: "connect ECONNREFUSED 127.0.0.1:8000" }).error).toContain("ECONNREFUSED");
    expect(runLogNode({ error: { message: "Request failed with status code 503" } }).error).toContain("503");
  });

  // An app build older than the three-way verdict answers with a boolean and no
  // verdict. That is a real judgment, so it still maps.
  it("keeps the boolean fallback for an older app build, and only for it", () => {
    expect(runLogNode({ resolved: true, new_response: "x" })).toMatchObject({
      status: "gap_resolved",
      resolved: true,
    });
    expect(runLogNode({ resolved: false, new_response: "x" })).toMatchObject({
      status: "gap_still_open",
      resolved: false,
    });
    // ... but never when the call itself failed.
    expect(runLogNode({ resolved: false, error: "timeout of 120000ms exceeded" }).status).toBe("gap_decision_failed");
  });

  it("carries the gap identity from the summary node", () => {
    expect(runLogNode({ verdict: "review", probability: 0.5 }).gap_id).toBe(7);
    expect(runLogNode({ error: "boom" }).gap_id).toBe(7);
  });
});
