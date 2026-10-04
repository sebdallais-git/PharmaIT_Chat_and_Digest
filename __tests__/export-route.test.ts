import { afterEach, describe, expect, it } from "@jest/globals";
import express from "express";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExportRouter, createPipelineRunner, validateExportRequest } from "../src/api/export.js";
import type { ExportRouterDeps } from "../src/api/export.js";
import { openExportJobs } from "../src/services/export-jobs.js";
import type { ExportJobStore, ExportRequest } from "../src/services/export-jobs.js";
import { downloadFilename } from "../src/services/export-pipeline.js";
import type { PipelineDeps } from "../src/services/export-pipeline.js";
import { ARTIFACT_KINDS, gather } from "../src/services/export-artifacts.js";
import type { GatherDeps } from "../src/services/export-artifacts.js";

const good = {
  kind: "account-brief",
  format: "pdf",
  audience: "internal",
  destination: "telegram",
  account: "roche",
};

describe("validateExportRequest", () => {
  it("accepts a complete request", () => {
    const result = validateExportRequest(good);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.destination).toBe("telegram");
  });

  it("defaults the destination to download", () => {
    const { destination: _drop, ...noDestination } = good;
    const result = validateExportRequest(noDestination);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.destination).toBe("download");
  });

  // No default: an export that does not say who it is for must not guess,
  // because the two audiences contain different data.
  it("rejects a request with no audience", () => {
    const { audience: _drop, ...noAudience } = good;
    const result = validateExportRequest(noAudience);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/audience/i);
  });

  it("rejects an unknown format", () => {
    const result = validateExportRequest({ ...good, format: "keynote" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/format/i);
  });

  it("rejects an unknown artifact kind", () => {
    const result = validateExportRequest({ ...good, kind: "sales-forecast" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/kind/i);
  });

  it("rejects a non-object body", () => {
    expect(validateExportRequest(null).ok).toBe(false);
    expect(validateExportRequest("hello").ok).toBe(false);
    expect(validateExportRequest(undefined).ok).toBe(false);
  });

  // Final review, important 3: these two kinds have no external form at all,
  // and export-artifacts.ts throws for them by design. Validating each field
  // independently accepted the combination anyway, returned 202 with a job
  // id, and failed minutes later in the gathering stage -- for something the
  // API could tell the caller at request time.
  describe("audience/kind combinations with no valid form", () => {
    for (const kind of ["vendor-comparison", "incumbency-matrix"] as const) {
      it(`rejects external ${kind}`, () => {
        const result = validateExportRequest({ ...good, kind, audience: "external", vendor: "acme" });

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/no external version/);
      });

      it(`still accepts internal ${kind}`, () => {
        expect(validateExportRequest({ ...good, kind, audience: "internal", vendor: "acme" }).ok).toBe(true);
      });
    }

    // The gatherer stays the authority; this is a fast-fail in front of it.
    // The two derive the rule from one place (hasExternalForm), and this test
    // is what would fail if they ever stopped agreeing: for every kind, the
    // validator accepts an external request exactly when gather() does not
    // throw for it. The GatherDeps here are fakes -- no live service.
    it("agrees with gather() about which kinds have an external form", async () => {
      const fakeGatherDeps: GatherDeps = {
        async incumbency() {
          return [];
        },
        async positions() {
          return [];
        },
        async news() {
          return [];
        },
      };

      for (const kind of ARTIFACT_KINDS) {
        const gatherRefused = await gather(kind, "external", { account: "roche", vendor: "acme" }, fakeGatherDeps).then(
          () => false,
          () => true,
        );
        const validatorRefused = !validateExportRequest({
          ...good,
          kind,
          audience: "external",
          account: "roche",
          vendor: "acme",
        }).ok;

        expect({ kind, validatorRefused }).toEqual({ kind, validatorRefused: gatherRefused });
      }
    });
  });
});

// Router-level tests. Every dependency is injected -- an in-memory job store
// and a fake pipeline runner -- so no test here opens the real job database
// or starts the real narrate/render/deliver pipeline.
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((r) => server.close(() => r()));
});

interface Fixture {
  url: string;
  jobs: ExportJobStore;
  started: string[];
  downloadDir: string;
}

function startApp(overrides: Partial<ExportRouterDeps> = {}): Promise<Fixture> {
  const jobs = openExportJobs(":memory:");
  const downloadDir = mkdtempSync(join(tmpdir(), "export-route-test-"));
  const started: string[] = [];
  const deps: ExportRouterDeps = {
    jobs,
    downloadDir,
    runPipeline: (jobId) => {
      started.push(jobId);
    },
    imageModelReady: () => true,
    ...overrides,
  };
  const app = express();
  app.use(express.json());
  app.use("/api/export", createExportRouter(deps));
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      servers.push(server);
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, jobs, started, downloadDir });
    });
  });
}

async function postExport(url: string, body: unknown) {
  const res = await fetch(`${url}/api/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const goodRequest = {
  kind: "account-brief",
  format: "pdf",
  audience: "internal",
  account: "roche",
};

describe("POST /api/export", () => {
  it("creates a job, returns its id immediately, and starts the pipeline without waiting on it", async () => {
    const fixture = await startApp();

    const { status, body } = await postExport(fixture.url, goodRequest);

    expect(status).toBe(202);
    expect(typeof body.jobId).toBe("string");
    expect(fixture.jobs.get(body.jobId as string)?.stage).toBe("queued");
    expect(fixture.started).toEqual([body.jobId]);
  });

  it("does not wait for the pipeline to finish before responding", async () => {
    const resolvers: Array<() => void> = [];
    const gate = new Promise<void>((resolve) => resolvers.push(resolve));
    let pipelineFinished = false;
    const fixture = await startApp({
      runPipeline: () => {
        void gate.then(() => {
          pipelineFinished = true;
        });
      },
    });

    const { status } = await postExport(fixture.url, goodRequest);

    expect(status).toBe(202);
    expect(pipelineFinished).toBe(false);
    resolvers[0]?.();
  });

  it("rejects an invalid request with 400 and creates no job", async () => {
    const fixture = await startApp();

    const { status, body } = await postExport(fixture.url, { ...goodRequest, audience: undefined });

    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/audience/i);
    expect(fixture.started).toEqual([]);
  });

  // A combination the gatherer refuses by design must be refused here, before
  // a job id is handed out and a pipeline is started for work that cannot
  // succeed.
  it("rejects an external vendor-comparison with 400 and starts no pipeline", async () => {
    const fixture = await startApp();

    const { status, body } = await postExport(fixture.url, {
      ...goodRequest,
      kind: "vendor-comparison",
      audience: "external",
      vendor: "acme",
    });

    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/no external version/);
    expect(body.jobId).toBeUndefined();
    expect(fixture.started).toEqual([]);
  });
});

describe("GET /api/export/:id", () => {
  it("reports the job's stage while it is running", async () => {
    const fixture = await startApp();
    const id = fixture.jobs.create({ kind: "account-brief", format: "pdf", audience: "internal", destination: "download", account: "roche" });
    fixture.jobs.setStage(id, "narrating");

    const res = await fetch(`${fixture.url}/api/export/${id}`);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.stage).toBe("narrating");
  });

  it("returns 404 for an unknown job id", async () => {
    const fixture = await startApp();

    const res = await fetch(`${fixture.url}/api/export/does-not-exist`);

    expect(res.status).toBe(404);
  });
});

// The download route resolves through the JOB, never through a
// caller-supplied filename: a caller holding a job id gets that job's bytes
// and has no way to name a file directly. That is what stops an internal
// export from being served at a URL already handed to a customer -- the two
// are different jobs, so they are different URLs over different files.
describe("GET /api/export/file/:id", () => {
  // Stands in for a finished download export: the job row plus the file the
  // delivery step wrote for it, named the way export-pipeline.ts names it.
  function finishedJob(fixture: Fixture, over: Partial<ExportRequest> = {}, bytes = "hello pdf"): string {
    const id = fixture.jobs.create({
      kind: "account-brief",
      format: "pdf",
      audience: "internal",
      destination: "download",
      account: "roche",
      ...over,
    });
    const job = fixture.jobs.get(id);
    writeFileSync(join(fixture.downloadDir, downloadFilename({ id, format: job?.format ?? "pdf" })), bytes);
    fixture.jobs.complete(id, `/api/export/file/${id}`);
    return id;
  }

  it("serves the bytes belonging to the requested job", async () => {
    const fixture = await startApp();
    const external = finishedJob(fixture, { audience: "external" }, "the customer copy");
    const internal = finishedJob(fixture, { audience: "internal" }, "incumbency by segment");

    const res = await fetch(`${fixture.url}/api/export/file/${external}`);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("the customer copy");
    expect(internal).not.toBe(external);
  });

  // The whole point of the critical fix: an internal export of the same kind,
  // account and format must not be reachable at the external export's URL.
  it("keeps an internal export off the external export's url", async () => {
    const fixture = await startApp();
    const external = finishedJob(fixture, { audience: "external" }, "the customer copy");
    finishedJob(fixture, { audience: "internal" }, "incumbency by segment");

    const res = await fetch(`${fixture.url}/api/export/file/${external}`);

    expect(await res.text()).not.toContain("incumbency");
  });

  it("answers 404, and keeps the server up, when the file cannot be opened after the existence check", async () => {
    // Stands in for the retention sweep deleting the file between existsSync
    // and the open: a directory passes existsSync and then fails to read.
    // Without an error listener on the stream that crashed the process.
    const fixture = await startApp();
    const id = finishedJob(fixture);
    const path = join(fixture.downloadDir, downloadFilename({ id, format: "pdf" }));
    rmSync(path);
    mkdirSync(path);

    const res = await fetch(`${fixture.url}/api/export/file/${id}`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no such export" });
    expect(res.headers.get("content-disposition")).toBeNull();
    expect((await fetch(`${fixture.url}/api/export/file/${id}`)).status).toBe(404);
  });

  it("returns 404 for a job id that does not exist", async () => {
    const fixture = await startApp();

    const res = await fetch(`${fixture.url}/api/export/file/00000000-0000-4000-8000-000000000000`);

    expect(res.status).toBe(404);
  });

  it("returns 404 for a job that has not finished delivering", async () => {
    const fixture = await startApp();
    const id = fixture.jobs.create({
      kind: "account-brief",
      format: "pdf",
      audience: "internal",
      destination: "download",
      account: "roche",
    });

    const res = await fetch(`${fixture.url}/api/export/file/${id}`);

    expect(res.status).toBe(404);
  });

  // A telegram or iCloud export has no servable file in the download
  // directory; its job id must not become a way to read one.
  it("returns 404 for a job that was not delivered as a download", async () => {
    const fixture = await startApp();
    const id = finishedJob(fixture, { destination: "icloud" });

    const res = await fetch(`${fixture.url}/api/export/file/${id}`);

    expect(res.status).toBe(404);
  });

  it("sets the content type and a sanitised attachment filename", async () => {
    const fixture = await startApp();
    const id = finishedJob(fixture, { format: "xlsx", account: "roche/../evil" });

    const res = await fetch(`${fixture.url}/api/export/file/${id}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toMatch(/^attachment; filename="[A-Za-z0-9._-]+"$/);
    expect(disposition).not.toContain("..");
    expect(disposition).not.toContain("/");
  });

  // A stored job id holding a path must never address a file outside the
  // download directory.
  //
  // Be precise about WHICH guard stops this, because an earlier version of
  // this test claimed the wrong one: `resolveContainedPath` calls basename()
  // first, so the id collapses to its last segment and the resolved path is
  // already inside downloadDir -- the 404 then comes from the file not being
  // there, and the strict-prefix containment check never fires. Containment
  // is the backstop behind basename(), not the guard doing the work here.
  // What this test pins is the OUTCOME the route owes a caller: bytes from
  // outside the directory are never served, whatever a row contains.
  it("never serves a file outside the download directory for a job id holding a path", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "export-route-outside-"));
    writeFileSync(join(outsideDir, "secret.pdf"), "top secret");
    const hostileId = `${outsideDir}/secret`;
    const jobs = openExportJobs(":memory:");
    // A store that hands back a job whose id is a traversal string, standing
    // in for any way a row could arrive holding one.
    const hostileJobs: ExportJobStore = {
      ...jobs,
      get: () => ({
        id: hostileId,
        kind: "account-brief",
        format: "pdf",
        audience: "internal",
        destination: "download",
        stage: "done",
        location: `/api/export/file/${hostileId}`,
        error: null,
        createdAt: "2026-09-22T10:00:00.000Z",
      }),
    };
    const fixture = await startApp({ jobs: hostileJobs });

    const res = await fetch(`${fixture.url}/api/export/file/${encodeURIComponent(hostileId)}`);

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("top secret");
  });

  // Traversal attempts aimed at the route itself: these are simply job ids
  // that do not exist, and must stay refused.
  it.each([["%2E%2E"], ["%2F"], ["nope.pdf"], ["..%2F..%2Fetc%2Fpasswd"]])(
    "refuses %s as a job id",
    async (attempt: string) => {
      const fixture = await startApp();
      writeFileSync(join(fixture.downloadDir, "nope.pdf"), "should not be reachable by name");

      const res = await fetch(`${fixture.url}/api/export/file/${attempt}`);

      expect([400, 404]).toContain(res.status);
    },
  );
});

// createPipelineRunner is the fix for the finding in
// .superpowers/sdd/2026-09-22-artifact-export/task-9-fix-1.md: the catch
// on the un-awaited pipeline promise must not just console.error -- it
// must fail the job so a poller can see why an export never arrived. This
// only fires for a rejection BEFORE runExport's own total try/catch, i.e.
// buildPipelineDeps() itself (in production: Neo4j / the watchlist store
// being unreachable), which is exactly what these fakes simulate. No test
// here touches a live service: buildPipelineDeps and runExport are both
// fakes, and jobs is the same in-memory store the route reads back from.
describe("createPipelineRunner", () => {
  it("fails the job with a stage and message when the pipeline runner rejects, readable through the status route", async () => {
    const jobs = openExportJobs(":memory:");
    const runner = createPipelineRunner({
      jobs,
      buildPipelineDeps: async () => {
        throw new Error("Neo4j is not running");
      },
      runExport: async () => {},
    });
    let pending: Promise<void> | undefined;
    const fixture = await startApp({
      jobs,
      runPipeline: (jobId) => {
        pending = runner(jobId);
      },
    });

    const { status, body } = await postExport(fixture.url, goodRequest);
    expect(status).toBe(202);
    await pending;

    const res = await fetch(`${fixture.url}/api/export/${body.jobId as string}`);
    const job = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(job.stage).toBe("failed");
    // "queued" because the job never started gathering -- that is the
    // honest stage to report, not a guess at where it would have gotten to.
    expect(String(job.error)).toMatch(/queued/);
    expect(String(job.error)).toMatch(/Neo4j is not running/);
  });

  it("returns the job id immediately -- the failure is only recorded after the response was already sent", async () => {
    let rejectGate!: (err: Error) => void;
    const gate = new Promise<never>((_resolve, reject) => {
      rejectGate = reject;
    });
    const jobs = openExportJobs(":memory:");
    const runner = createPipelineRunner({
      jobs,
      buildPipelineDeps: () => gate,
      runExport: async () => {},
    });
    let pending: Promise<void> | undefined;
    const fixture = await startApp({
      jobs,
      runPipeline: (jobId) => {
        pending = runner(jobId);
      },
    });

    const { status, body } = await postExport(fixture.url, goodRequest);
    expect(status).toBe(202);
    expect(typeof body.jobId).toBe("string");

    // The response is already sent; the job must still be at "queued"
    // because the pipeline wiring has not settled (rejected or not) yet.
    const queuedRes = await fetch(`${fixture.url}/api/export/${body.jobId as string}`);
    const queuedJob = (await queuedRes.json()) as Record<string, unknown>;
    expect(queuedJob.stage).toBe("queued");

    rejectGate(new Error("Neo4j is not running"));
    await pending;

    const failedRes = await fetch(`${fixture.url}/api/export/${body.jobId as string}`);
    const failedJob = (await failedRes.json()) as Record<string, unknown>;
    expect(failedJob.stage).toBe("failed");
  });

  // Retention is housekeeping that runs after each export. It must never
  // change the outcome the caller is polling for: an earlier draft ran the
  // sweep inside the runner's try, so a sweep that could not delete a file
  // would have been caught by the same catch and recorded the SUCCESSFUL
  // export as failed.
  it("does not let a failing retention sweep fail an export that succeeded", async () => {
    const jobs = openExportJobs(":memory:");
    const id = jobs.create({
      kind: "account-brief",
      format: "pdf",
      audience: "internal",
      destination: "download",
      account: "roche",
    });
    const runner = createPipelineRunner({
      jobs,
      buildPipelineDeps: async () => ({}) as unknown as PipelineDeps,
      runExport: async () => {
        jobs.complete(id, `/api/export/file/${id}`);
      },
      sweep: async () => {
        throw new Error("EACCES: permission denied");
      },
    });

    await expect(runner(id)).resolves.toBeUndefined();

    expect(jobs.get(id)?.stage).toBe("done");
    expect(jobs.get(id)?.error).toBeNull();
    jobs.close();
  });

  it("sweeps expired exports after a successful run", async () => {
    const jobs = openExportJobs(":memory:");
    let swept = 0;
    const runner = createPipelineRunner({
      jobs,
      buildPipelineDeps: async () => ({}) as unknown as PipelineDeps,
      runExport: async () => {},
      sweep: async () => {
        swept += 1;
      },
    });

    await runner("job-1");

    expect(swept).toBe(1);
    jobs.close();
  });

  it("does not let a failure inside the fail() call become an unhandled rejection", async () => {
    // jobs.fail() throws when the id does not exist (export-jobs.ts). This
    // fake reproduces that throw unconditionally, standing in for any
    // reason fail() might throw, to prove the guard around it holds: the
    // runner must still settle (not reject) instead of letting this escape
    // as the unhandled rejection the original .catch() existed to prevent.
    const throwingJobs: ExportJobStore = {
      create: () => "job-1",
      get: () => null,
      setStage: () => {},
      complete: () => {},
      fail: () => {
        throw new Error('no export job with id "job-1"');
      },
      listExpirable: () => [],
      expire: () => {},
      close: () => {},
    };
    const runner = createPipelineRunner({
      jobs: throwingJobs,
      buildPipelineDeps: async () => {
        throw new Error("Neo4j is not running");
      },
      runExport: async () => {},
    });

    await expect(runner("job-1")).resolves.toBeUndefined();
  });
});

// Image requests (2026-10-04)
describe("validateExportRequest for images", () => {
  const presets = new Map([
    ["none", { name: "none", style: "" }],
    ["photo", { name: "photo", style: "photorealistic" }],
  ]);
  const seed = () => 7;

  it("accepts a prompt, with preset none, size square, raw false, a seed, and no audience required", () => {
    expect(validateExportRequest({ kind: "image", format: "png", prompt: "a lab bench" }, presets, seed)).toEqual({
      ok: true,
      value: {
        kind: "image",
        format: "png",
        audience: "internal",
        destination: "download",
        image: { prompt: "a lab bench", preset: "none", size: "square", raw: false, seed: 7 },
      },
    });
    const full = validateExportRequest(
      { kind: "image", format: "png", prompt: "x", preset: "photo", size: "slide", raw: true, seed: 99, destination: "telegram", audience: "external" },
      presets,
      seed,
    );
    expect(full).toMatchObject({ ok: true, value: { audience: "external", destination: "telegram", image: { preset: "photo", size: "slide", raw: true, seed: 99 } } });
  });

  it("refuses a missing or over-long prompt, an unknown preset or size, a bad seed", () => {
    const bad = (body: Record<string, unknown>) => validateExportRequest({ kind: "image", format: "png", prompt: "x", ...body }, presets, seed);
    expect(bad({ prompt: "  " })).toEqual({ ok: false, error: "prompt is required (1 to 1000 characters)" });
    expect(bad({ prompt: "x".repeat(1001) })).toEqual({ ok: false, error: "prompt is required (1 to 1000 characters)" });
    expect(bad({ preset: "cartoon" })).toEqual({ ok: false, error: 'unknown preset "cartoon" (known: none, photo)' });
    expect(bad({ size: "banner" })).toEqual({ ok: false, error: 'unknown size "banner" (known: square, portrait, linkedin, slide)' });
    expect(bad({ seed: -1 })).toEqual({ ok: false, error: "seed must be an integer from 0 to 4294967295" });
  });

  it("refuses png for a document and any other format for an image", () => {
    expect(validateExportRequest({ kind: "account-brief", format: "png", audience: "internal" }, presets, seed)).toEqual({ ok: false, error: 'format "png" is only for kind "image"' });
    expect(validateExportRequest({ kind: "image", format: "pdf", prompt: "x" }, presets, seed)).toEqual({ ok: false, error: 'kind "image" is only for format "png"' });
  });

  it("still requires an audience for documents", () => {
    expect(validateExportRequest({ kind: "account-brief", format: "pdf" }, presets, seed)).toEqual({ ok: false, error: 'audience is required and must be "internal" or "external"' });
  });
});

describe("POST /api/export for an image", () => {
  it("answers 503 when the model is not installed, without creating or starting a job", async () => {
    const fixture = await startApp({ imageModelReady: () => false });
    const { status, body } = await postExport(fixture.url, { kind: "image", format: "png", prompt: "a lab bench" });
    expect(status).toBe(503);
    expect(body).toEqual({ error: "image model not installed: run scripts/setup-image-model.sh" });
    expect(fixture.started).toEqual([]);
  });

  it("queues an image job when the model is installed", async () => {
    const fixture = await startApp();
    const { status, body } = await postExport(fixture.url, { kind: "image", format: "png", prompt: "a lab bench", size: "slide" });
    expect(status).toBe(202);
    expect(fixture.jobs.get(body.jobId as string)).toMatchObject({ kind: "image", format: "png", stage: "queued", image: { size: "slide" } });
  });
});
