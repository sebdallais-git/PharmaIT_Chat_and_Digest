// The image runner: an export job of kind "image" goes narrating (the 27B
// expands the prompt) -> rendering (FLUX draws it) -> delivering, through the
// same job store, delivery and retention as documents (spec 2026-10-04). No
// Artifact is built: an image has no sections.

import { join } from "node:path";
import type { DeliveryDeps, deliver as deliverFn } from "./export-delivery.js";
import type { ExportJob, ExportJobStore, Stage } from "./export-jobs.js";
import { downloadFilename, slugify } from "./export-pipeline.js";
import type { GeneratedImage, ImageSpec } from "./image-generator.js";
import { IMAGE_SIZES, type ImagePreset } from "./image-presets.js";
import { buildImagePrompt, type CompleteFn } from "./image-prompt.js";

export interface ImageRunnerDeps {
  jobs: ExportJobStore;
  presets: Map<string, ImagePreset>;
  complete: CompleteFn;
  generate(spec: ImageSpec): Promise<GeneratedImage>;
  // Where mflux writes its output before delivery
  workDir: string;
  deliver: typeof deliverFn;
  deliveryDeps: DeliveryDeps;
  removeFile(path: string): Promise<void>;
}

/** "<id>.png" for downloads; "image-<prompt slug>-<id>.png" elsewhere. Never the audience. */
export function imageFilename(job: ExportJob): string {
  if (job.destination === "download") return downloadFilename(job);
  const slug = slugify(job.image?.prompt ?? "").slice(0, 40).replace(/-+$/, "") || "image";
  return `image-${slug}-${job.id}.png`;
}

export async function runImageExport(id: string, deps: ImageRunnerDeps): Promise<void> {
  const job = deps.jobs.get(id);
  if (job === null) return;
  const request = job.image;
  const outputPath = join(deps.workDir, `${job.id}.png`);
  let stage: Stage = "narrating";
  try {
    if (job.kind !== "image" || request === undefined) throw new Error("not an image job");
    deps.jobs.setStage(id, stage);
    const preset = deps.presets.get(request.preset);
    if (preset === undefined) throw new Error(`unknown preset ${JSON.stringify(request.preset)}`);
    const prompt = await buildImagePrompt({ prompt: request.prompt, preset, raw: request.raw }, deps.complete);

    stage = "rendering";
    deps.jobs.setStage(id, stage);
    const { width, height } = IMAGE_SIZES[request.size];
    const image = await deps.generate({ jobId: id, prompt, preset: request.preset, size: request.size, width, height, seed: request.seed, outputPath });

    stage = "delivering";
    deps.jobs.setStage(id, stage);
    const location = await deps.deliver({ jobId: id, filename: imageFilename(job), bytes: image.png }, job.destination, deps.deliveryDeps);
    deps.jobs.complete(id, location);
  } catch (err) {
    deps.jobs.fail(id, stage, err instanceof Error ? err.message : String(err));
  } finally {
    await deps.removeFile(outputPath).catch(() => undefined);
  }
}
