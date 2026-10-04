// The pipeline: gather -> narrate -> render -> deliver, with the job's stage
// recorded before each step runs. Every collaborator arrives through
// PipelineDeps so this module never touches a database, network or LLM
// client directly -- that is what lets the test drive it entirely with fakes
// and an in-memory job store.
//
// R7 (final review, important 2): what the stage sequence buys is
// DIAGNOSABILITY, not resumability -- the same ruling export-jobs.ts already
// carries as its R2 comment, which until now only that file had. `stage` is
// set BEFORE each step, so it names the step currently in flight; when that
// step throws, the catch below records exactly which stage failed. Nothing
// resumes: there is no retry path, no resume path and no re-run endpoint
// anywhere in this subsystem, and no step's output is checkpointed. A failed
// export is re-requested as a brand new job with a new id, which re-runs
// every stage from the start. An earlier draft of this comment claimed a
// crash mid-step resumed from the last completed step; it never did.
//
// This pipeline does not re-implement the internal/external audience
// boundary. Task 6's gather() decides what an artifact contains for a given
// audience (and throws for combinations that have no valid form, such as an
// external vendor-comparison); this pipeline only passes the artifact
// through gather -> narrate -> render -> deliver and lets those throws
// surface as a failed job.
import type { Artifact } from "./artifact.js";
import type { GatherDeps, gather as gatherFn } from "./export-artifacts.js";
import type { DeliveryDeps, deliver as deliverFn } from "./export-delivery.js";
import type { DocumentFormat, ExportJob, ExportJobStore, Stage } from "./export-jobs.js";

export interface PipelineDeps {
  jobs: ExportJobStore;
  gather: typeof gatherFn;
  gatherDeps: GatherDeps;
  narrate(artifact: Artifact): Promise<Artifact>;
  render: Record<DocumentFormat, (artifact: Artifact) => Promise<Buffer>>;
  deliver: typeof deliverFn;
  deliveryDeps: DeliveryDeps;
}

// R8 (final review, CRITICAL): the delivered filename used to be
// `${artifact.title}.${format}`, and an account-brief carries the SAME title
// for both audiences. Two exports that differed only in audience therefore
// landed on one path: the internal one overwrote the external one in
// data/exports/ (silently changing the bytes behind a URL already handed to a
// customer) and, for the iCloud destination, in a synced folder, so the
// overwrite left the machine.
//
// The job id is now part of every delivered name, which is what makes
// collision impossible: ids are randomUUID()s (export-jobs.ts), so two
// requests get different names even when every request field is identical,
// let alone when the audience differs. The two destinations name files
// differently on purpose:
//
//   download  ->  "<jobId>.<format>"
//       Nothing but the route reads this directory, and the route addresses a
//       job. Deriving the on-disk name from the id alone means the read path
//       needs no stored filename to trust and no column to migrate: given a
//       job row it recomputes the one name that job could ever have written.
//       Nothing model-written reaches the filesystem on this path at all.
//
//   icloud / telegram  ->  "<title-slug>-<audience>-<jobId>.<format>"
//       These land in front of a human -- a Finder window, a chat thread --
//       where a bare UUID is useless. The audience is in the name because
//       that is the difference between a customer handout and an
//       account-intelligence document sitting in the same folder, and the
//       title slug says what it is. The id keeps it unique.
//
// The slug is built from a model-influenced title, so it is reduced to
// [a-z0-9-] here and still passed through export-delivery.ts's containment
// check before any write.
function slugify(title: string): string {
  return title
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

/** The on-disk name of a "download" export: recomputable from the job row alone. */
export function downloadFilename(job: Pick<ExportJob, "id" | "format">): string {
  return `${job.id}.${job.format}`;
}

export function deliveredFilename(job: ExportJob, artifact: Artifact): string {
  if (job.destination === "download") return downloadFilename(job);
  const slug = slugify(artifact.title) || "artifact";
  return `${slug}-${job.audience}-${job.id}.${job.format}`;
}

// Runs one job to completion (or to a recorded failure). There is no
// timeout anywhere in this function: narration runs at roughly 3.4 tok/s
// behind a single-request local model server, so a job may legitimately
// wait minutes behind other work. Waiting is healthy; only a thrown error
// is a failure.
export async function runExport(id: string, deps: PipelineDeps): Promise<void> {
  const job = deps.jobs.get(id);
  if (job === null) return;
  // Images have their own runner (export-image.ts); a png job reaching the
  // document pipeline is a wiring bug, recorded as such rather than rendered
  if (job.kind === "image" || job.format === "png") {
    deps.jobs.fail(id, "queued", "image jobs run in the image runner, not the document pipeline");
    return;
  }

  let stage: Stage = "gathering";
  try {
    deps.jobs.setStage(id, stage);
    const gathered = await deps.gather(
      job.kind,
      job.audience,
      { account: job.account, vendor: job.vendor },
      deps.gatherDeps,
    );

    stage = "narrating";
    deps.jobs.setStage(id, stage);
    const artifact = await deps.narrate(gathered);

    stage = "rendering";
    deps.jobs.setStage(id, stage);
    const bytes = await deps.render[job.format](artifact);

    stage = "delivering";
    deps.jobs.setStage(id, stage);
    const filename = deliveredFilename(job, artifact);
    const location = await deps.deliver({ jobId: job.id, filename, bytes }, job.destination, deps.deliveryDeps);

    deps.jobs.complete(id, location);
  } catch (err) {
    deps.jobs.fail(id, stage, err instanceof Error ? err.message : String(err));
  }
}
