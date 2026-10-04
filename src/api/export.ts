// HTTP surface for artifact export: request one, poll its status, download
// the finished file.
//
// POST /api/export             -> { jobId }          (returns immediately)
// GET  /api/export/:id         -> job status          (poll for the location)
// GET  /api/export/file/:id   -> the file              (download destination)
//
// Every route here is asynchronous end to end: narration runs at roughly
// 3.4 tok/s behind a single local model server, so a deck can take minutes
// to render. POST must not await the pipeline -- it creates the job,
// launches the pipeline detached, and returns the job id. A "download"
// destination becomes a URL the caller polls for, never a held connection;
// a synchronous export would reproduce a timeout bug that previously made
// chat look broken.
//
// This file does NOT add /api/export to src/api/auth.ts's BROWSER_ROUTES.
// That list is an allowlist of UNPROTECTED routes ("these stay open"); an
// export carries the account intelligence config/accounts.local.yaml is
// gitignored to protect, so it must stay behind the API token like every
// other non-browser /api/* route. Absence from the list already means
// protected -- see __tests__/auth.test.ts for the pinning test.
//
// Router construction follows src/api/stack.ts: createExportRouter(deps)
// takes every collaborator as an argument, so a test can inject an
// in-memory job store and a fake pipeline runner. The default export wires
// the real ones; no test in this file opens the real job database or starts
// the real pipeline.
import { Router } from "express";
import type { Request, Response } from "express";
import { randomInt } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { isAudience } from "../services/artifact.js";
import { hasExternalForm, internalOnlyKindMessage, isArtifactKind } from "../services/export-artifacts.js";
import { isDestination, resolveContainedPath } from "../services/export-delivery.js";
import { isExportFormat, isExportKind, openExportJobs } from "../services/export-jobs.js";
import type { ExportFormat, ExportJob, ExportJobStore, ExportRequest } from "../services/export-jobs.js";
import { downloadFilename, runExport } from "../services/export-pipeline.js";
import type { PipelineDeps } from "../services/export-pipeline.js";
import { IMAGE_SIZES, isImageSize, loadImagePresets, type ImagePreset } from "../services/image-presets.js";
import { MAX_PROMPT_CHARS } from "../services/image-prompt.js";
import { imageModelPath } from "../services/image-system.js";
import { loadHostConfig } from "../platform/host-config.js";
import { sweepExpiredExports } from "../services/export-retention.js";
import { buildImageDeps, buildPipelineDeps } from "../services/export-wiring.js";
import { runImageExport } from "../services/export-image.js";

export type ValidationResult = { ok: true; value: ExportRequest } | { ok: false; error: string };

// The body is attacker-controlled shape (this is a trust boundary): every
// field is checked with the same closed-set guard its storage layer uses,
// rather than re-declaring the vocabulary here or trusting a field's type.
const MAX_SEED = 4294967295;

export function validateExportRequest(
  body: unknown,
  // A map, or a loader called only for image requests: a broken presets file must not fail document exports
  presets: Map<string, ImagePreset> | (() => Map<string, ImagePreset>) = loadImagePresets,
  randomSeed: () => number = () => randomInt(0, 2 ** 31),
): ValidationResult {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

  if (!isExportKind(b.kind)) {
    return { ok: false, error: `unknown artifact kind ${JSON.stringify(b.kind)}` };
  }
  if (!isExportFormat(b.format)) {
    return { ok: false, error: `unknown format ${JSON.stringify(b.format)} (expected xlsx, pdf, pptx or png)` };
  }
  if (b.format === "png" && b.kind !== "image") return { ok: false, error: `format "png" is only for kind "image"` };
  if (b.kind === "image" && b.format !== "png") return { ok: false, error: `kind "image" is only for format "png"` };

  if (b.kind === "image") {
    const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
    if (prompt === "" || prompt.length > MAX_PROMPT_CHARS) return { ok: false, error: `prompt is required (1 to ${MAX_PROMPT_CHARS} characters)` };
    let known: Map<string, ImagePreset>;
    try {
      known = typeof presets === "function" ? presets() : presets;
    } catch (err) {
      return { ok: false, error: `config/image-presets.yaml is invalid: ${err instanceof Error ? err.message : String(err)}` };
    }
    const preset = b.preset ?? "none";
    if (typeof preset !== "string" || !known.has(preset)) {
      return { ok: false, error: `unknown preset ${JSON.stringify(preset)} (known: ${[...known.keys()].join(", ")})` };
    }
    const size = b.size ?? "square";
    if (!isImageSize(size)) return { ok: false, error: `unknown size ${JSON.stringify(size)} (known: ${Object.keys(IMAGE_SIZES).join(", ")})` };
    const seed = b.seed ?? randomSeed();
    if (typeof seed !== "number" || !Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) {
      return { ok: false, error: `seed must be an integer from 0 to ${MAX_SEED}` };
    }
    // An image carries no account text: the audience is optional and only
    // recorded (the column is NOT NULL); it never reaches the file name
    const audience = b.audience ?? "internal";
    if (!isAudience(audience)) return { ok: false, error: `audience must be "internal" or "external"` };
    const destination = b.destination ?? "download";
    if (!isDestination(destination)) return { ok: false, error: `unknown destination ${JSON.stringify(destination)}` };
    return {
      ok: true,
      value: { kind: "image", format: "png", audience, destination, image: { prompt, preset, size, raw: b.raw === true, seed } },
    };
  }

  // Deliberately no default: the two audiences contain different data, so a
  // missing audience must fail loudly rather than guess which one was meant.
  if (!isAudience(b.audience)) {
    return { ok: false, error: `audience is required and must be "internal" or "external"` };
  }
  // R11 (final review, important 3): some kinds have no external form, and
  // export-artifacts.ts refuses them by design. Validating each field on its
  // own accepted the combination anyway and failed minutes later in the
  // gathering stage. The rule and its wording both come from that module --
  // this is a fast-fail in front of the authority, not a second opinion.
  if (!hasExternalForm(b.kind) && b.audience === "external") {
    return { ok: false, error: internalOnlyKindMessage(b.kind) };
  }
  const destination = b.destination ?? "download";
  if (!isDestination(destination)) {
    return { ok: false, error: `unknown destination ${JSON.stringify(destination)}` };
  }

  return {
    ok: true,
    value: {
      kind: b.kind,
      format: b.format,
      audience: b.audience,
      destination,
      account: typeof b.account === "string" ? b.account : undefined,
      vendor: typeof b.vendor === "string" ? b.vendor : undefined,
    },
  };
}

export interface ExportRouterDeps {
  jobs: ExportJobStore;
  downloadDir: string;
  // Kicks off the pipeline without the caller waiting on it. Fire-and-forget
  // by design: the route function returns before this settles.
  runPipeline(jobId: string): void;
  // False until scripts/setup-image-model.sh has saved the model: an image
  // request is then refused at once instead of queuing a job bound to fail
  imageModelReady(): boolean;
}

// Express's ParamsDictionary types a param as string | string[] to account
// for repeated wildcard segments; neither ":id" declared here ever
// matches more than one segment, so this always narrows to a plain string
// at runtime. An array would only ever appear for a route pattern this file
// does not declare.
function singleParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? "" : value;
}

// R10 (final review, minor 3): an .xlsx served with no Content-Type is
// sniffed by the browser and may render as text. The type is chosen from the
// job's own format, which is a closed vocabulary validated at the storage
// boundary (export-jobs.ts), so this map is total and needs no fallback.
const CONTENT_TYPES: Record<ExportFormat, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  png: "image/png",
};

// The name the browser saves the download as. The file on disk is named
// "<jobId>.<format>" (export-pipeline.ts), which is meaningless in a
// Downloads folder, so a readable name is rebuilt here from the job's own
// fields -- including the audience, so a customer-facing brief and an
// internal one for the same account do not land side by side under one name.
//
// account/vendor are caller-supplied strings, so this goes into a header:
// everything outside [A-Za-z0-9._-] is replaced rather than echoed, which
// removes the quote, CR and LF that could otherwise break out of the header
// value, and the path separators and ".." a client might be tempted to obey.
function attachmentName(job: ExportJob): string {
  // Images never carry the audience in their name (spec 2026-10-04)
  if (job.kind === "image") return `image-${job.image?.preset ?? "none"}-${job.id.slice(0, 8)}.png`;
  const parts = [job.kind, job.account ?? job.vendor ?? "", job.audience].filter((p) => p !== "");
  const stem = parts.join("-").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/\.+/g, ".").replace(/^[.-]+|[.-]+$/g, "");
  return `${stem === "" ? "artifact" : stem}.${job.format}`;
}

export function createExportRouter(deps: ExportRouterDeps): Router {
  const router = Router();

  router.post("/", (req: Request, res: Response): void => {
    const result = validateExportRequest(req.body);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    if (result.value.kind === "image" && !deps.imageModelReady()) {
      res.status(503).json({ error: "image model not installed: run scripts/setup-image-model.sh" });
      return;
    }

    const jobId = deps.jobs.create(result.value);
    // Not awaited: the caller polls GET /:id for progress and location.
    deps.runPipeline(jobId);

    res.status(202).json({ jobId });
  });

  // R9 (final review, CRITICAL): this route used to serve by FILENAME, with
  // no link to the job that produced the file. Any caller could name any file
  // in the download directory, and two exports that differed only in audience
  // shared a name -- so the URL a customer had been given could start
  // serving an internal artifact. It now resolves through the job: the param
  // is a job id, the filename is recomputed from that job row
  // (downloadFilename), and a caller has no way to name a file at all.
  //
  // Every refusal is the same 404: an unknown job, a job still running, a job
  // delivered somewhere other than the download directory, and a path that
  // fails containment all mean "no such export is servable here" from the
  // caller's point of view, and the response shape should not tell an
  // enumerating caller which case it hit (this route sits behind the API
  // token regardless -- see the header comment).
  //
  // Containment is still applied even though the filename is no longer
  // caller-supplied: it is built from a stored id, and resolveContainedPath
  // is the same check the write side applies (minor 1), so a row holding
  // something unexpected cannot reach outside the download directory.
  router.get("/file/:id", (req: Request, res: Response): void => {
    const job = deps.jobs.get(singleParam(req.params.id));
    if (job === null || job.destination !== "download" || job.stage !== "done") {
      res.status(404).json({ error: "no such export" });
      return;
    }

    const path = resolveContainedPath(deps.downloadDir, downloadFilename(job));
    if (path === null || !existsSync(path)) {
      res.status(404).json({ error: "no such export" });
      return;
    }

    res.setHeader("Content-Type", CONTENT_TYPES[job.format]);
    res.setHeader("Content-Disposition", `attachment; filename="${attachmentName(job)}"`);
    const stream = createReadStream(path);
    // The file can vanish between existsSync and the open (the retention
    // sweep). With no listener that error crashed the whole server.
    stream.on("error", () => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.removeHeader("Content-Disposition");
      res.status(404).json({ error: "no such export" });
    });
    stream.pipe(res);
  });

  router.get("/:id", (req: Request, res: Response): void => {
    const job = deps.jobs.get(singleParam(req.params.id));
    if (job === null) {
      res.status(404).json({ error: "no such job" });
      return;
    }
    res.json(job);
  });

  return router;
}

export interface PipelineRunnerDeps<D = PipelineDeps> {
  jobs: ExportJobStore;
  buildPipelineDeps: () => Promise<D>;
  runExport: (id: string, deps: D) => Promise<void>;
  // Optional so a test can leave housekeeping out of what it is asserting.
  sweep?: () => Promise<unknown>;
}

// Wraps buildPipelineDeps() -> runExport() so a rejection that happens
// BEFORE runExport's own total try/catch (in practice: buildPipelineDeps()
// failing to reach Neo4j or the watchlist store) does not leave the job
// stranded at "queued" forever. runExport has its own error handling once
// it starts, so this only ever needs to record a failure for a job that
// never got that far -- "queued" is the honest stage to report, since
// gathering never began.
//
// Returns the underlying promise (rather than void) so tests can await it
// deterministically instead of guessing at a settle delay. Production
// wiring below discards the return value, which is fine: a function
// returning Promise<void> is assignable to ExportRouterDeps.runPipeline's
// "(jobId: string): void" precisely because a void-returning function type
// ignores whatever the assigned function returns.
//
// This function itself must never reject -- it is called fire-and-forget
// by the route handler, and a rejection here would become the unhandled
// rejection the original .catch() existed to avoid. jobs.fail() throws if
// the job id is unknown (export-jobs.ts); that should not happen here
// since create() already returned this id, but the inner try/catch guards
// against it regardless.
export function createPipelineRunner<D = PipelineDeps>(deps: PipelineRunnerDeps<D>): (jobId: string) => Promise<void> {
  return async (jobId: string): Promise<void> => {
    try {
      const pipelineDeps = await deps.buildPipelineDeps();
      await deps.runExport(jobId, pipelineDeps);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`export ${jobId}: pipeline wiring failed:`, message);
      try {
        deps.jobs.fail(jobId, "queued", `export could not be started: ${message}`);
      } catch (failErr: unknown) {
        console.error(
          `export ${jobId}: failed to record job failure:`,
          failErr instanceof Error ? failErr.message : failErr,
        );
      }
    }

    // Retention runs here rather than on a schedule: a machine that never
    // exports accumulates nothing, so sweeping after each export is
    // self-limiting and needs no timer.
    //
    // Deliberately OUTSIDE the try above, in its own guard. Inside it, a
    // sweep that could not delete a file would be caught by that catch and
    // recorded as the export failing -- marking a job that succeeded as
    // failed. Retention is housekeeping; it must never change the outcome
    // the caller is polling for.
    try {
      await deps.sweep?.();
    } catch (sweepErr: unknown) {
      console.error(`export retention sweep failed:`, sweepErr instanceof Error ? sweepErr.message : sweepErr);
    }
  };
}

// openExportJobs() opens a real sqlite file (mkdirSync + a live connection) --
// real I/O, not just an object construction. Calling it at module load would
// mean simply IMPORTING this file (as every test that imports
// validateExportRequest or createExportRouter does, since ES modules
// execute the whole file) opens the real job database as a side effect.
// This lazily opens it on first actual use by a route handler instead, and
// memoizes the connection across requests -- the same shape as
// buildPipelineDeps(), which is itself only called once a request arrives.
function lazyJobStore(): ExportJobStore {
  let real: ExportJobStore | null = null;
  const ensure = (): ExportJobStore => (real ??= openExportJobs());
  return {
    create: (request) => ensure().create(request),
    get: (id) => ensure().get(id),
    setStage: (id, stage) => ensure().setStage(id, stage),
    complete: (id, location) => ensure().complete(id, location),
    fail: (id, stage, message) => ensure().fail(id, stage, message),
    listExpirable: (beforeIso) => ensure().listExpirable(beforeIso),
    expire: (id) => ensure().expire(id),
    close: () => real?.close(),
  };
}

const exportJobs = lazyJobStore();
// buildPipelineDeps is given the router's own store (R6 in export-wiring.ts):
// the pipeline must not open a second connection to the same job database.
const sweep = () =>
  sweepExpiredExports({ jobs: exportJobs, downloadDir: join(process.cwd(), "data", "exports"), now: new Date(), unlink });
const runDocument = createPipelineRunner({ jobs: exportJobs, buildPipelineDeps: () => buildPipelineDeps(exportJobs), runExport, sweep });
// Images skip the document wiring (Neo4j, watchlist): a graph outage must not stop a picture
const runImage = createPipelineRunner({ jobs: exportJobs, buildPipelineDeps: () => buildImageDeps(exportJobs), runExport: runImageExport, sweep });

export default createExportRouter({
  jobs: exportJobs,
  downloadDir: join(process.cwd(), "data", "exports"),
  // void: fire-and-forget, matching this route's comment above -- POST
  // must not await the pipeline. createPipelineRunner's returned promise
  // never rejects (see its own comment), so there is nothing to catch here.
  runPipeline: (jobId) => {
    void (exportJobs.get(jobId)?.kind === "image" ? runImage : runDocument)(jobId);
  },
  imageModelReady: () => existsSync(imageModelPath(process.cwd(), loadHostConfig().resources.image.quantize)),
});
