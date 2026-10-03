import { afterEach, describe, expect, it } from "@jest/globals";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createGraphRouter, type GraphRouterDeps } from "../src/api/graph.js";
import {
  ACCOUNT_EVIDENCE_CYPHER,
  ACCOUNTS_CYPHER,
  NEED_SEGMENTS_CYPHER,
  POSITIONS_CYPHER,
  VENDOR_EVIDENCE_CYPHER,
  VENDORS_CYPHER,
  type CompetitiveDeps,
} from "../src/services/competitive-graph.js";

let server: Server | null = null;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
});

const competitive: CompetitiveDeps = {
  async runCypher(query) {
    if (query === ACCOUNTS_CYPHER) return [];
    if (query === NEED_SEGMENTS_CYPHER) return [];
    if (query === POSITIONS_CYPHER) {
      return [{ vendor: "dell", segment: "storage-block", position: "leader", confidence: "high", rationale: "r", asOf: "" }];
    }
    if (query === VENDORS_CYPHER) return [{ id: "dell" }];
    if (query === ACCOUNT_EVIDENCE_CYPHER || query === VENDOR_EVIDENCE_CYPHER) return [];
    throw new Error("unexpected query");
  },
  briefs: () => ({ excerpts: new Map(), errors: [] }),
  vendorAliases: () => ({}),
};

function fakeDeps(overrides: Partial<GraphRouterDeps> = {}): GraphRouterDeps {
  return {
    isAvailable: async () => true,
    stats: async () => ({ nodeCount: 0, relationshipCount: 0, nodesByLabel: {}, relationshipsByType: {} }),
    competitive: () => competitive,
    rebuild: async () => ({ nodes: 0, relationships: 0, lines: [] }),
    ...overrides,
  };
}

async function start(deps: GraphRouterDeps): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use("/api/graph", createGraphRouter(deps));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server?.once("listening", () => resolve()));
  return `http://127.0.0.1:${(server?.address() as AddressInfo).port}/api/graph`;
}

async function post(url: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: resp.status, body: (await resp.json()) as Record<string, unknown> };
}

describe("POST /api/graph/competitive-position", () => {
  it("answers a vendor question", async () => {
    const base = await start(fakeDeps());
    const { status, body } = await post(`${base}/competitive-position`, { vendor: "dell" });
    expect(status).toBe(200);
    expect(body.market).toEqual([{ vendor: "dell", segment: "storage-block", position: "leader" }]);
  });

  it("returns 400 with the resolver's message for an unknown vendor", async () => {
    const base = await start(fakeDeps());
    const { status, body } = await post(`${base}/competitive-position`, { vendor: "lenovo" });
    expect(status).toBe(400);
    expect(body.error).toBe('unknown vendor "lenovo" (known: dell)');
  });

  it("returns 400 when a field is not a string", async () => {
    const base = await start(fakeDeps());
    const { status, body } = await post(`${base}/competitive-position`, { vendor: 42 });
    expect(status).toBe(400);
    expect(body.error).toBe("vendor, account and segment must be strings when given");
  });

  it("returns 503 when Neo4j is down", async () => {
    const base = await start(fakeDeps({ isAvailable: async () => false }));
    const { status } = await post(`${base}/competitive-position`, { vendor: "dell" });
    expect(status).toBe(503);
  });

  it("no longer serves the old-schema entity search", async () => {
    const base = await start(fakeDeps());
    const resp = await fetch(`${base}/search`, { method: "POST" });
    expect(resp.status).toBe(404);
  });
});

describe("POST /api/graph/rebuild", () => {
  it("rebuilds whatever stack is active, and reports the counts", async () => {
    const base = await start(fakeDeps({ rebuild: async () => ({ nodes: 60, relationships: 127, lines: ["x"] }) }));
    const { status, body } = await post(`${base}/rebuild`, {});
    expect(status).toBe(200);
    expect(body).toEqual({ message: "Graph rebuild complete", nodes: 60, relationships: 127, output: ["x"] });
  });

  it("refuses a second rebuild while one is running", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = await start(
      fakeDeps({
        rebuild: async () => {
          await gate;
          return { nodes: 0, relationships: 0, lines: [] };
        },
      }),
    );
    const first = post(`${base}/rebuild`, {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await post(`${base}/rebuild`, {});
    expect(second.status).toBe(409);
    release();
    expect((await first).status).toBe(200);
  });

  it("returns 503 when Neo4j is down, without rebuilding", async () => {
    let called = false;
    const base = await start(
      fakeDeps({
        isAvailable: async () => false,
        rebuild: async () => {
          called = true;
          return { nodes: 0, relationships: 0, lines: [] };
        },
      }),
    );
    expect((await post(`${base}/rebuild`, {})).status).toBe(503);
    expect(called).toBe(false);
  });

  it("returns 500 with the validation message from a bad source", async () => {
    const base = await start(
      fakeDeps({
        rebuild: async () => {
          throw new Error("dell-storage-block.md: invalid position");
        },
      }),
    );
    const { status, body } = await post(`${base}/rebuild`, {});
    expect(status).toBe(500);
    expect(body.error).toBe("dell-storage-block.md: invalid position");
  });
});
