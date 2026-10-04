import { describe, expect, it } from "@jest/globals";
import { imageFilename, runImageExport, type ImageRunnerDeps } from "../src/services/export-image.js";
import { openExportJobs, type ExportRequest } from "../src/services/export-jobs.js";
import type { ImageSpec } from "../src/services/image-generator.js";

// The image runner with fakes: no 27B, no mflux, no files.

const REQUEST: ExportRequest = {
  kind: "image",
  format: "png",
  audience: "internal",
  destination: "telegram",
  image: { prompt: "AI factory at a pharma plant", preset: "photo", size: "linkedin", raw: false, seed: 42 },
};

function harness(over: Partial<ImageRunnerDeps> = {}) {
  const jobs = openExportJobs(":memory:");
  const specs: ImageSpec[] = [];
  const delivered: Array<{ filename: string; destination: string; bytes: Buffer }> = [];
  const removed: string[] = [];
  const stages: string[] = [];
  const realSetStage = jobs.setStage.bind(jobs);
  jobs.setStage = (id, stage) => {
    stages.push(stage);
    realSetStage(id, stage);
  };
  const deps: ImageRunnerDeps = {
    jobs,
    presets: new Map([
      ["none", { name: "none", style: "" }],
      ["photo", { name: "photo", style: "photorealistic" }],
    ]),
    complete: async () => "a bright modern plant with robots",
    generate: async (spec) => {
      specs.push(spec);
      return { png: Buffer.from("PNG"), ms: 40_000, peakBytes: 7e9 };
    },
    workDir: "/work",
    deliver: async (file, destination) => {
      delivered.push({ filename: file.filename, destination, bytes: file.bytes });
      return destination;
    },
    deliveryDeps: { downloadDir: "/d", icloudDir: "/i", writeFile: async () => {}, sendDocument: async () => {} },
    removeFile: async (path) => {
      removed.push(path);
    },
    ...over,
  };
  return { deps, jobs, specs, delivered, removed, stages };
}

describe("runImageExport", () => {
  it("expands, draws at the preset size with the job's seed, delivers and completes", async () => {
    const h = harness();
    const id = h.jobs.create(REQUEST);
    await runImageExport(id, h.deps);

    expect(h.stages).toEqual(["narrating", "rendering", "delivering"]);
    expect(h.specs[0]).toMatchObject({
      jobId: id,
      width: 1200,
      height: 624,
      seed: 42,
      preset: "photo",
      size: "linkedin",
      outputPath: `/work/${id}.png`,
    });
    expect(h.specs[0].prompt).toBe("a bright modern plant with robots, photorealistic, no text, no letters, no words, no logos, no watermark");
    expect(h.delivered).toEqual([{ filename: imageFilename(h.jobs.get(id)!), destination: "telegram", bytes: Buffer.from("PNG") }]);
    expect(h.jobs.get(id)).toMatchObject({ stage: "done", location: "telegram" });
    expect(h.removed).toEqual([`/work/${id}.png`]);
  });

  it("records the stage that failed and still removes the work file", async () => {
    const h = harness({
      generate: async () => {
        throw new Error("gave up after 10 min: not enough memory: 6.8 GB free, need 10");
      },
    });
    const id = h.jobs.create(REQUEST);
    await runImageExport(id, h.deps);
    expect(h.jobs.get(id)).toMatchObject({ stage: "failed", error: "rendering: gave up after 10 min: not enough memory: 6.8 GB free, need 10" });
    expect(h.removed).toEqual([`/work/${id}.png`]);
  });

  it("fails a job whose preset was removed from the config since it was queued", async () => {
    const h = harness();
    const id = h.jobs.create({ ...REQUEST, image: { ...REQUEST.image!, preset: "gone" } });
    await runImageExport(id, h.deps);
    expect(h.jobs.get(id)).toMatchObject({ stage: "failed", error: 'narrating: unknown preset "gone"' });
  });
});

describe("imageFilename", () => {
  it("is the job id for downloads, and a prompt slug without the audience elsewhere", () => {
    const jobs = openExportJobs(":memory:");
    const download = jobs.get(jobs.create({ ...REQUEST, destination: "download" }))!;
    expect(imageFilename(download)).toBe(`${download.id}.png`);
    const telegram = jobs.get(jobs.create({ ...REQUEST, audience: "external" }))!;
    expect(imageFilename(telegram)).toBe(`image-ai-factory-at-a-pharma-plant-${telegram.id}.png`);
    expect(imageFilename(telegram)).not.toContain("external");
  });
});
